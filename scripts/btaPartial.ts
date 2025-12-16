import 'reflect-metadata';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { SignalAnalyzerService, BarData } from '../src/domain/signal-analyzer';
import { MeanReversionModule } from '../src/domain/signal-analyzer/modules';
import { TradeGatekeeper } from '../src/domain/signal-analyzer/gatekeeper/trade-gatekeeper';
import { TrendAlignmentGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trend-alignment.gate';
import { MeanReversionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate';
import { AntiSpamGate } from '../src/domain/signal-analyzer/gatekeeper/gates/anti-spam.gate';
import { TradingSessionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trading-session.gate';

/**
 * Scaling In позиция — вход частями (3 части: 40% → 30% → 30%)
 */
interface ScalingTrade {
    action: 'LONG' | 'SHORT';
    entries: number[];
    sizesUsd: number[];
    currentParts: number;
    maxParts: number;
    tp: number[];
    sl: number;
    ts: number;
    tags: string[];
}

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================

const SYMBOLS_TO_TEST: string[] = [
    'ACEUSDT', 'AIOTUSDT', 'AIOUSDT', 'BASUSDT', 'BDXNUSDT', 'BEATUSDT', 'COAIUSDT', 'EDENUSDT',
    'FHEUSDT', 'FOLKSUSDT', 'JELLYJELLYUSDT', 'LIGHTUSDT', 'NXPCUSDT', 'ORCAUSDT', 'PORTALUSDT', 'POWERUSDT',
    'PTBUSDT', 'RIVERUSDT', 'SKYAIUSDT', 'SWARMSUSDT', 'TAKEUSDT', 'TRUTHUSDT'
];
const BLACKLIST: string[] = ['GUSDT'];
const MIN_VOLUME_24H = 1_000_000;
const INITIAL_BALANCE = 100;
const LEVERAGE = 3;
const MARGIN_PER_TRADE = 10;
const BINANCE_COMMISSION_RATE = 0.0004;

// ==========================================

async function runAdvancedBacktest() {
    await DatabaseModule.initialize();
    const historyRepo = AppDataSource.getRepository(HistoryCandle);

    const modules = [new MeanReversionModule()];
    const gates = [
        new TrendAlignmentGate(),
        new MeanReversionGate(),
        new TradingSessionGate(),
        new AntiSpamGate()
    ];

    const gatekeeper = new TradeGatekeeper(gates);
    const analyzer = new SignalAnalyzerService(modules, gatekeeper);

    console.log('🚀 Starting SERIOUS Backtest...');
    console.log(`💰 Balance: $${INITIAL_BALANCE} | 🎰 Leverage: x${LEVERAGE}`);

    let totalPnL = 0;
    let wins = 0;
    let losses = 0;
    let currentBalance = INITIAL_BALANCE;
    let totalFeesPaid = 0;
    let maxBalance = INITIAL_BALANCE;
    let maxDrawdown = 0;

    let symbolsToBacktest = SYMBOLS_TO_TEST;

    if (symbolsToBacktest.length === 0) {
        const uniqueSymbols = await historyRepo
            .createQueryBuilder('candle')
            .select('DISTINCT(candle.symbol)', 'symbol')
            .getRawMany();

        symbolsToBacktest = uniqueSymbols.map(s => s.symbol);
    }

    for (const symbol of symbolsToBacktest) {
        if (BLACKLIST.includes(symbol)) continue;

        const entities = await historyRepo.find({
            where: { symbol },
            order: { ts: 'ASC' }
        });

        if (entities.length < 200) continue;

        const bars = entities.map(e => e.data as unknown as BarData);

        const durationH = (bars[bars.length - 1].ts - bars[0].ts) / 3600000;
        const totalVolumeUsd = bars.reduce((sum, b) => sum + (b.v * b.c), 0);
        const avgVolume24h = (totalVolumeUsd / durationH) * 24;

        if (avgVolume24h < MIN_VOLUME_24H) continue;

        let activeTrade: ScalingTrade | null = null;
        const warmup = 100;

        analyzer.warmUp(symbol, bars.slice(0, warmup));

        for (let i = warmup; i < bars.length; i++) {
            const currentBar = bars[i];

            if (currentBalance > maxBalance) maxBalance = currentBalance;
            const currentDD = (maxBalance - currentBalance) / maxBalance;
            if (currentDD > maxDrawdown) maxDrawdown = currentDD;

            if (currentBalance <= 0) break;

            const slice = bars.slice(0, i + 1);

            // === A. Проверка выхода из сделки ===
            if (activeTrade) {
                const trade: ScalingTrade = activeTrade;
                const totalSize = trade.sizesUsd.reduce((a, b) => a + b, 0);
                const weightedSum = trade.entries.reduce((sum, e, idx) => sum + e * trade.sizesUsd[idx], 0);
                const avgEntry = weightedSum / totalSize;

                let exitPrice: number | null = null;
                let outcome: 'WIN' | 'LOSS' = 'LOSS';

                if (trade.action === 'LONG') {
                    if (currentBar.l <= trade.sl) exitPrice = trade.sl;
                    else if (currentBar.h >= trade.tp[0]) {
                        exitPrice = trade.tp[0];
                        outcome = 'WIN';
                    }
                } else {
                    if (currentBar.h >= trade.sl) exitPrice = trade.sl;
                    else if (currentBar.l <= trade.tp[0]) {
                        exitPrice = trade.tp[0];
                        outcome = 'WIN';
                    }
                }

                if (!exitPrice && currentBar.ts - trade.ts > 120 * 60000) {
                    exitPrice = currentBar.c;
                }

                if (exitPrice) {
                    const direction = trade.action === 'LONG' ? 1 : -1;
                    const pnlPricePct = (exitPrice - avgEntry) / avgEntry;
                    const rawPnlUsd = direction * pnlPricePct * totalSize;

                    const openFee = totalSize * BINANCE_COMMISSION_RATE;
                    const closeNominal = totalSize * (exitPrice / avgEntry);
                    const closeFee = Math.abs(closeNominal) * BINANCE_COMMISSION_RATE;

                    const totalCommission = openFee + closeFee;
                    const netPnl = rawPnlUsd - totalCommission;

                    currentBalance += netPnl;
                    totalPnL += netPnl;
                    totalFeesPaid += totalCommission;

                    if (outcome === 'WIN') wins++; else losses++;

                    activeTrade = null;
                }
                continue;
            }

            // === B. Анализ ===
            const signal = analyzer.analyze(symbol, slice);

            // === C. Вход с Scaling In ===
            if (signal.action !== 'NO_TRADE') {
                if (currentBalance < MARGIN_PER_TRADE) continue;

                const fullPositionSizeUsd = MARGIN_PER_TRADE * LEVERAGE;

                if (!activeTrade) {
                    const firstSize = fullPositionSizeUsd * 0.4;
                    activeTrade = {
                        action: signal.action,
                        entries: [signal.entryPrice],
                        sizesUsd: [firstSize],
                        currentParts: 1,
                        maxParts: 3,
                        tp: signal.tp,
                        sl: signal.sl,
                        ts: currentBar.ts,
                        tags: signal.reasonTags
                    } as ScalingTrade;
                } else if (activeTrade) {
                    const trade: ScalingTrade = activeTrade;

                    if (trade.action === signal.action && trade.currentParts < trade.maxParts) {
                        const totalSizeSoFar = trade.sizesUsd.reduce((a, b) => a + b, 0);
                        const weightedSum = trade.entries.reduce((sum, e, idx) => sum + e * trade.sizesUsd[idx], 0);
                        const avgEntry = weightedSum / totalSizeSoFar;

                        const priceMovePct = trade.action === 'SHORT'
                            ? (avgEntry - currentBar.c) / avgEntry
                            : (currentBar.c - avgEntry) / avgEntry;

                        if (priceMovePct >= 0.015) {
                            const addSize = fullPositionSizeUsd * 0.3;
                            const entryThisPart = signal.entryPrice || currentBar.c;

                            trade.entries.push(entryThisPart);
                            trade.sizesUsd.push(addSize);
                            trade.currentParts++;
                        }
                    }


                }
            }
        }
    }

    console.log('\n=======================================');
    console.log(`🏁 RESULT: ${wins}W / ${losses}L (${(wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0}% Winrate)`);
    console.log(`💰 Net PnL After Fees: $${(currentBalance - INITIAL_BALANCE).toFixed(2)}`);
    console.log(`💸 Total Binance Fees Paid: $${totalFeesPaid.toFixed(2)}`);
    console.log(`📉 Max Drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);
    console.log(`🏦 FINAL Balance: $${currentBalance.toFixed(2)} (Start: $${INITIAL_BALANCE}, x${(currentBalance / INITIAL_BALANCE).toFixed(2)})`);
    console.log('=======================================');

    await DatabaseModule.close();
}

runAdvancedBacktest();