import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { SignalAnalyzerService, BarData, TradeAction, SignalResult } from '../src/domain/signal-analyzer';
import { MeanReversionModule, OrderflowModule, MomentumModule } from '../src/domain/signal-analyzer/modules';
import { TradeGatekeeper } from '../src/domain/signal-analyzer/gatekeeper/trade-gatekeeper';
import { TrendAlignmentGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trend-alignment.gate';
import { MeanReversionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate';
import { AntiSpamGate } from '../src/domain/signal-analyzer/gatekeeper/gates/anti-spam.gate';
import { TradingSessionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trading-session.gate';
import { DEFAULT_CONFIG } from '../src/domain/signal-analyzer/types/config';
import { MarketContext, TrendState } from '../src/domain/signal-analyzer/types/context';
import { generateTradeChart } from './utils/chart-generator';

// ==========================================
// ⚙️ SYSTEM CONFIG (SYNCED)
// ==========================================
const POS_CFG = DEFAULT_CONFIG.position;
const FEES_CFG = DEFAULT_CONFIG.fees;
const TECH_CFG = DEFAULT_CONFIG.technical;

// ==========================================
// 💀 MARKET PHYSICS
// ==========================================
const INITIAL_BALANCE = 100;
const MIN_SCORE_THRESHOLD = DEFAULT_CONFIG.decision.threshold || 0.01;

// Константы биржи
const FUNDING_RATE = 0.0001;
const FUNDING_INTERVAL = 28800000;
const MAINT_MARGIN_RATE = 0.005;
const LIQUIDATION_FEE = 0.01;

// ==========================================
// 🔧 HELPERS
// ==========================================
function fmt(num: number): string {
    if (!num) return '0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '+';
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
    return `${sign}${abs.toFixed(0)}`;
}

// ==========================================
// 🔧 MARKET CONTEXT FROM BTC
// ==========================================
function computeMarketContext(
    btcBars: BarData[] | undefined,
    ethBars: BarData[] | undefined
): MarketContext {

    const getTrend = (bars: BarData[] | undefined): { trend: TrendState, changePct5m: number } => {
        if (!bars || bars.length < 10) return { trend: 'FLAT', changePct5m: 0 };

        const current = bars[bars.length - 1];
        const past5m = bars[Math.max(0, bars.length - 6)];
        const past30m = bars[Math.max(0, bars.length - 31)];

        const change5m = (current.c - past5m.c) / past5m.c;
        const change30m = (current.c - past30m.c) / past30m.c;

        let trend: TrendState = 'FLAT';
        if (change30m >= 0.08) trend = 'PUMP';
        else if (change30m <= -0.08) trend = 'CRASH';
        else if (change5m >= 0.02) trend = 'UP';
        else if (change5m <= -0.02) trend = 'DOWN';

        return { trend, changePct5m: change5m };
    };

    const btcTrend = getTrend(btcBars);
    const ethTrend = getTrend(ethBars);

    // Global trend follows BTC
    let globalTrend = btcTrend.trend;

    // Permissions based on trend
    let allowLong = true, allowShort = true, reason = 'Normal';
    if (globalTrend === 'CRASH') { allowLong = false; reason = 'BTC CRASH - Longs Blocked'; }
    if (globalTrend === 'PUMP') { allowShort = false; reason = 'BTC PUMP - Shorts Blocked'; }

    return {
        btc: { symbol: 'BTCUSDT', trend: btcTrend.trend, changePct5m: btcTrend.changePct5m, priceVsEma: 0, isVolatile: false },
        eth: { symbol: 'ETHUSDT', trend: ethTrend.trend, changePct5m: ethTrend.changePct5m, priceVsEma: 0, isVolatile: false },
        globalTrend,
        riskLevel: globalTrend === 'FLAT' ? 'LOW' : globalTrend === 'PUMP' || globalTrend === 'CRASH' ? 'EXTREME' : 'MEDIUM',
        isBrokenCorrelation: btcTrend.trend !== ethTrend.trend,
        permissions: { allowLong, allowShort, reason }
    };
}

// ==========================================
// 🔧 TYPES
// ==========================================
interface ActivePosition {
    id: string;
    symbol: string;
    action: TradeAction;
    entryPrice: number;
    quantity: number;
    margin: number;
    leverage: number;
    tp: number[];
    sl: number;
    openTime: number;
    lastFundingTime: number;
}

interface MarketSnapshot {
    symbol: string;
    bar: BarData;
}

type ExtendedSignalResult = SignalResult & {
    entryType?: 'market' | 'limit';
    quantity?: number;
    positionSizeUsd?: number;
}

// ==========================================
// 🚀 REALISTIC PORTFOLIO ENGINE
// ==========================================

async function runRealBacktest() {
    await DatabaseModule.initialize();
    const historyRepo = AppDataSource.getRepository(HistoryCandle);

    const modules = [new MeanReversionModule(), new OrderflowModule(), new MomentumModule()];
    // Убрали TradingSessionGate для теста (блокирует по времени исторических данных)
    const gates = [new TrendAlignmentGate(), new MeanReversionGate(), new AntiSpamGate()];
    const gatekeeper = new TradeGatekeeper(gates);
    const analyzer = new SignalAnalyzerService(modules, gatekeeper, DEFAULT_CONFIG);

    console.log('💀 Starting SYNCED Portfolio Backtest...');

    // Clean up charts folder
    const chartsDir = path.resolve(process.cwd(), 'backtest-charts');
    if (fs.existsSync(chartsDir)) {
        fs.rmSync(chartsDir, { recursive: true, force: true });
        console.log('🧹 Cleaned backtest-charts folder');
    }
    console.log(`💰 Balance: $${INITIAL_BALANCE}`);
    console.log(`⚙️ Mode: ${TECH_CFG.entryOffsetAtrMult > 0 ? 'LIMIT ENTRY (Offset)' : 'MARKET ENTRY'}`);
    console.log(`⚙️ Config: Lev x${POS_CFG.leverage} | Max Trades: ${POS_CFG.maxOpenTrades} | Risk: ${POS_CFG.baseRiskPct}%`);

    // --- LOAD DATA ---
    console.log('📥 Loading market data...');
    const allSymbols = await historyRepo.createQueryBuilder('c').select('DISTINCT(c.symbol)', 'symbol').getRawMany();
    const marketData = new Map<string, BarData[]>();
    const timelineSet = new Set<number>();

    // Черный список для теста
    const BLACKLIST = [
        // USD-pegged
        'USDTUSDT',   // Tether (самый популярный)
        'USDCUSDT',   // USD Coin (Circle)
        'BUSDUSDT',   // Binance USD (deprecated с 2024)
        'TUSDUSDT',   // TrueUSD
        'USDPUSDT',   // Pax Dollar
        'DAIUSDT',    // DAI (децентрализованный)
        'FRAXUSDT',   // Frax
        'USTCUSDT',   // TerraClassicUSD (crashed в 2022)
        'FDUSDUSDT',  // First Digital USD (новый от Binance)
        'PYUSDUSDT',  // PayPal USD

        // EUR-pegged
        'EURUSDT',    // Euro стейблкоины
        'EUROCUSDT',

        // Other fiats
        'GBPUSDT',    // British Pound
        'AUDUSDT',    // Australian Dollar (но часто это Audius токен!)
    ];

    for (const { symbol } of allSymbols) {
        if (BLACKLIST.includes(symbol)) continue;
        const rawResults = await historyRepo.createQueryBuilder('h').select('h.data').where('h.symbol = :symbol', { symbol }).orderBy('h.ts', 'ASC').getMany();
        const bars = rawResults.map(r => r.data as unknown as BarData);

        if (bars.length < 200) continue;

        // Фильтр ликвидности (20M/day)
        const durationH = (bars[bars.length - 1].ts - bars[0].ts) / 3600000;
        const totalVol = bars.reduce((sum, b) => sum + (b.v * b.c), 0);
        if ((totalVol / durationH) * 24 < 50_000_000) continue;

        marketData.set(symbol, bars);
        bars.forEach(b => timelineSet.add(b.ts));

        analyzer.warmUp(symbol, bars.slice(0, 150));
    }

    const timeline = Array.from(timelineSet).sort((a, b) => a - b);
    console.log(`✅ Loaded ${marketData.size} symbols. Simulating ${timeline.length} minutes...`);

    // --- SIMULATION LOOP ---
    let balance = INITIAL_BALANCE;
    let activePositions: ActivePosition[] = [];
    const tradeHistory: any[] = [];

    const cursorIndices = new Map<string, number>();
    for (const sym of marketData.keys()) cursorIndices.set(sym, 0);

    for (const ts of timeline) {
        // A. SNAPSHOT MARKET
        const currentMarket: MarketSnapshot[] = [];
        for (const [sym, bars] of marketData.entries()) {
            let idx = cursorIndices.get(sym) || 0;
            while (idx < bars.length - 1 && bars[idx].ts < ts) idx++;
            cursorIndices.set(sym, idx);
            if (bars[idx].ts === ts) currentMarket.push({ symbol: sym, bar: bars[idx] });
        }

        // B. MANAGE POSITIONS
        for (let i = activePositions.length - 1; i >= 0; i--) {
            const pos = activePositions[i];
            const marketItem = currentMarket.find(m => m.symbol === pos.symbol);
            if (!marketItem) continue;

            const bar = marketItem.bar;
            if (bar.ts === pos.openTime) continue;

            const isLong = pos.action === 'LONG';
            const positionValue = pos.quantity * bar.c;

            // 1. Funding
            if (ts - pos.lastFundingTime >= FUNDING_INTERVAL) {
                const fundingCost = positionValue * FUNDING_RATE;
                balance -= fundingCost;
                pos.lastFundingTime = ts;
            }

            // 2. Liquidation
            const worstPrice = isLong ? bar.l : bar.h;
            const worstPnl = (worstPrice - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
            const currentMargin = pos.margin + worstPnl;
            const maintenanceMargin = (pos.entryPrice * pos.quantity) * MAINT_MARGIN_RATE;

            if (currentMargin <= maintenanceMargin) {
                balance -= (positionValue * LIQUIDATION_FEE);
                tradeHistory.push({ symbol: pos.symbol, pnl: -pos.margin, reason: 'LIQUIDATION' });
                console.log(`💀 LIQUIDATED [${pos.symbol}] @ ${worstPrice}. Lost Margin: -$${pos.margin.toFixed(2)}. Bal: $${balance.toFixed(2)}`);
                activePositions.splice(i, 1);
                continue;
            }

            // 3. SL / TP / Expiry
            let closePrice: number | null = null;
            let reason = '';
            const hitSL = isLong ? bar.l <= pos.sl : bar.h >= pos.sl;
            const hitTP = isLong ? bar.h >= pos.tp[0] : bar.l <= pos.tp[0];
            const isExpired = (ts - pos.openTime) > 6 * 60 * 60 * 1000;

            if (hitSL) { closePrice = pos.sl; reason = 'SL'; }
            else if (hitTP) { closePrice = pos.tp[0]; reason = 'TP'; }
            else if (isExpired) { closePrice = bar.c; reason = 'EXPIRED'; }

            if (closePrice) {
                const dir = isLong ? 1 : -1;
                const grossPnl = (closePrice - pos.entryPrice) * pos.quantity * dir;
                const exitVal = closePrice * pos.quantity;
                const exitFee = exitVal * FEES_CFG.taker;

                const netPnl = grossPnl - exitFee;
                balance += (pos.margin + netPnl);

                activePositions.splice(i, 1);
                tradeHistory.push({ symbol: pos.symbol, pnl: netPnl, reason });

                const emoji = netPnl > 0 ? '✅' : '❌';
                console.log(`${emoji} CLOSED [${pos.symbol}] ${reason}. PnL: $${netPnl.toFixed(2)}. Bal: $${balance.toFixed(2)}`);
            }
        }

        // C. FIND NEW TRADES
        if (activePositions.length < POS_CFG.maxOpenTrades && balance > 10) {
            const candidates: { sym: string, res: ExtendedSignalResult, bar: BarData }[] = [];

            for (const { symbol, bar } of currentMarket) {
                if (activePositions.find(p => p.symbol === symbol)) continue;

                const idx = cursorIndices.get(symbol)!;
                if (idx < 50) continue;
                const allBars = marketData.get(symbol)!;
                const slice = allBars.slice(Math.max(0, idx - 200), idx);

                // Compute market context from BTC/ETH at current time
                const btcIdx = cursorIndices.get('BTCUSDT') || 0;
                const ethIdx = cursorIndices.get('ETHUSDT') || 0;
                const btcBars = marketData.get('BTCUSDT')?.slice(Math.max(0, btcIdx - 35), btcIdx + 1);
                const ethBars = marketData.get('ETHUSDT')?.slice(Math.max(0, ethIdx - 35), ethIdx + 1);
                const marketContext = computeMarketContext(btcBars, ethBars);

                const result = analyzer.analyze(symbol, slice, marketContext, balance) as ExtendedSignalResult;

                if (result.action !== 'NO_TRADE' && Math.abs(result.meta.rawScore) > MIN_SCORE_THRESHOLD) {
                    candidates.push({ sym: symbol, res: result, bar });
                }
            }

            candidates.sort((a, b) => Math.abs(b.res.meta.rawScore) - Math.abs(a.res.meta.rawScore));

            for (const cand of candidates) {
                if (activePositions.length >= POS_CFG.maxOpenTrades) break;
                if (balance < 10) break;

                const { res, bar } = cand;

                let quantity = res.quantity || 0;
                let positionSizeUsd = res.positionSizeUsd || 0;

                if (quantity === 0) {
                    const riskUsd = balance * (POS_CFG.baseRiskPct / 100);
                    const distToSl = Math.abs(res.entryPrice - res.sl);
                    const slPct = distToSl / res.entryPrice;
                    positionSizeUsd = Math.min(riskUsd / slPct, balance * POS_CFG.leverage);
                    quantity = positionSizeUsd / res.entryPrice;
                }

                if (positionSizeUsd < 5) continue;

                // === EXECUTION LOGIC ===
                let entryPriceReal = res.entryPrice;
                let isFilled = false;
                let isMaker = false;

                if (res.entryType === 'limit') {
                    const canFillLong = res.action === 'LONG' && bar.l <= res.entryPrice;
                    const canFillShort = res.action === 'SHORT' && bar.h >= res.entryPrice;
                    if (canFillLong || canFillShort) {
                        isFilled = true;
                        isMaker = true;
                        entryPriceReal = res.entryPrice;
                    } else {
                        continue;
                    }
                } else {
                    isFilled = true;
                    isMaker = false;
                    const slipDir = res.action === 'LONG' ? 1 : -1;
                    entryPriceReal = bar.o * (1 + FEES_CFG.slippage * slipDir);
                }

                if (!isFilled) continue;

                const requiredMargin = positionSizeUsd / POS_CFG.leverage;
                const entryFeeRate = isMaker ? FEES_CFG.maker : FEES_CFG.taker;
                const entryFee = (entryPriceReal * quantity) * entryFeeRate;

                if (balance < (requiredMargin + entryFee)) continue;

                balance -= (requiredMargin + entryFee);

                // 🔥 FIX: Пересчитываем SL/TP относительно РЕАЛЬНОЙ цены входа
                // Если мы вошли по цене отличной от сигнала (slippage), SL/TP должны пропорционально сдвинуться
                const isLong = res.action === 'LONG';
                const direction = isLong ? 1 : -1;

                // Расстояние до SL в % от сигнала -> применяем к реальной цене
                const originalSlDistance = Math.abs(res.entryPrice - res.sl);
                const slPct = originalSlDistance / res.entryPrice;
                const adjustedSl = entryPriceReal - (direction * entryPriceReal * slPct);

                // Расстояние до TP в % от сигнала -> применяем к реальной цене
                const adjustedTp = res.tp.map(tpLevel => {
                    const originalTpDistance = Math.abs(tpLevel - res.entryPrice);
                    const tpPct = originalTpDistance / res.entryPrice;
                    return entryPriceReal + (direction * entryPriceReal * tpPct);
                });

                activePositions.push({
                    id: `${res.symbol}-${ts}`,
                    symbol: res.symbol,
                    action: res.action,
                    entryPrice: entryPriceReal,
                    quantity: quantity,
                    margin: requiredMargin,
                    leverage: POS_CFG.leverage,
                    tp: adjustedTp,  // 🔥 Пересчитанный TP
                    sl: adjustedSl,  // 🔥 Пересчитанный SL
                    openTime: ts,
                    lastFundingTime: ts
                });

                console.log(`⚡ OPEN [${res.symbol}] ${res.action} (${res.entryType}) @ ${entryPriceReal.toFixed(4)}. Size: $${positionSizeUsd.toFixed(0)}`);

                // 📊 Generate HTML chart for this trade
                const allBarsForChart = marketData.get(res.symbol)!;
                const chartIdx = cursorIndices.get(res.symbol)!;
                // 3 hours before + 1 hour after entry
                const chartBars = allBarsForChart.slice(Math.max(0, chartIdx - 180), Math.min(allBarsForChart.length, chartIdx + 61));
                generateTradeChart({
                    symbol: res.symbol,
                    action: res.action,
                    entryPrice: entryPriceReal,
                    sl: res.sl,
                    tp: res.tp,
                    bars: chartBars,
                    timestamp: ts
                }, 'backtest-charts');

                // ============================================
                // 🔥 30m CONTEXT DISPLAY (UPDATED)
                // ============================================
                try {
                    const fullHistory = marketData.get(res.symbol)!;
                    const currentIdx = cursorIndices.get(res.symbol)!;

                    // Расчет 30m метрик (как было раньше)
                    const startTime = bar.ts - 30 * 60 * 1000;
                    let pastIdx = currentIdx;
                    let liqLong30m = 0;
                    let liqShort30m = 0;
                    let volume30m = 0;

                    while (pastIdx >= 0 && fullHistory[pastIdx].ts > startTime) {
                        const b = fullHistory[pastIdx];
                        liqLong30m += b.liquidations?.long || 0;
                        liqShort30m += b.liquidations?.short || 0;
                        volume30m += (b.v * b.c);
                        pastIdx--;
                    }

                    pastIdx = Math.max(0, pastIdx);
                    const pastBar = fullHistory[pastIdx];

                    const deltaOI = bar.oi - pastBar.oi;
                    const oiPct = pastBar.oi > 0 ? (deltaOI / pastBar.oi) * 100 : 0;
                    const oiAccel = deltaOI / 30;
                    const deltaCVD = bar.cvd - pastBar.cvd;
                    const cvdDominance = volume30m > 0 ? (deltaCVD / volume30m) * 100 : 0;

                    // Форматирование
                    const fmtPct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;

                    // Данные из META (Режим и Корреляция)
                    const regime = res.marketRegime || 'N/A';
                    // Читаем из meta, если есть, иначе N/A
                    const corrStatus = res.meta.isBrokenCorrelation === true ? '⚠️ BROKEN' : '✅ SYNC';

                    console.log(
                        `   📊 [${regime} | BTC: ${corrStatus}] \n` +
                        `      OI: ${fmt(deltaOI)} (${fmtPct(oiPct)}) | Accel: ${fmt(oiAccel)}/min \n` +
                        `      CVD: ${fmt(deltaCVD)} (${fmtPct(cvdDominance)} vol) | Liq: L ${fmt(liqLong30m)} / S ${fmt(liqShort30m)}`
                    );

                } catch (e) {
                    console.log('   ⚠️ Stats calc error');
                }
                // ============================================
            }
        }
    }

    // --- FINAL STATS ---
    console.log('\n=======================================');
    const wins = tradeHistory.filter(t => t.pnl > 0).length;
    const losses = tradeHistory.length - wins;
    const winrate = tradeHistory.length > 0 ? (wins / tradeHistory.length * 100) : 0;

    activePositions.forEach(p => balance += p.margin);

    console.log(`🏁 TRADES: ${tradeHistory.length} (W:${wins} / L:${losses})`);
    console.log(`📊 WINRATE: ${winrate.toFixed(2)}%`);
    console.log(`💰 FINAL BALANCE: $${balance.toFixed(2)}`);
    console.log(`📈 NET PnL: $${(balance - INITIAL_BALANCE).toFixed(2)}`);
    console.log('=======================================');

    await DatabaseModule.close();
}

runRealBacktest();