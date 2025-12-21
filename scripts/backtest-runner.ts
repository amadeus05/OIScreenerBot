import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import {
    SignalAnalyzerService,
    BarData,
    SignalResult,
    SignalAnalyzerConfig,
    DEFAULT_CONFIG,
} from '../src/domain/signal-analyzer';
import { MeanReversionModule, OrderflowModule, MomentumModule, OIModule } from '../src/domain/signal-analyzer/modules';
import { TradeGatekeeper } from '../src/domain/signal-analyzer/gatekeeper/trade-gatekeeper';
import { TrendAlignmentGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trend-alignment.gate';
import { MeanReversionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate';
import { AntiSpamGate } from '../src/domain/signal-analyzer/gatekeeper/gates/anti-spam.gate';
import { MarketContext, TrendState } from '../src/domain/signal-analyzer/types/context';

type TradeAction = SignalResult['action'];

export interface BacktestOptions {
    configOverride?: Partial<SignalAnalyzerConfig>;
    symbols?: string[];
    maxSymbols?: number;
    startTs?: number;
    endTs?: number;
    initialBalance?: number;
    skipWarmup?: boolean;
    maxTrades?: number;
    skipCharts?: boolean; // kept for compatibility, ignored here
    silent?: boolean;
}

export interface TradeRecord {
    symbol: string;
    action: TradeAction;
    pnl: number;
    reason: string;
    openedAt: number;
    closedAt: number;
    entry: number;
    exit: number;
    regime?: string;
    rawScore?: number;
    moduleAgreement?: number;
}

export interface BacktestMetrics {
    trades: number;
    wins: number;
    losses: number;
    winrate: number;
    finalBalance: number;
    netPnl: number;
    maxDrawdown: number;
    expectancy: number;
    avgR?: number;
    pnlByRegime: Record<string, { trades: number; pnl: number; wins: number; losses: number }>;
}

export interface BacktestResult {
    metrics: BacktestMetrics;
    trades: TradeRecord[];
}

const FUNDING_RATE = 0.0001;
const FUNDING_INTERVAL = 28800000;
const MAINT_MARGIN_RATE = 0.005;
const LIQUIDATION_FEE = 0.01;

const BLACKLIST = new Set([
    'USDTUSDT', 'USDCUSDT', 'BUSDUSDT', 'TUSDUSDT', 'USDPUSDT', 'DAIUSDT', 'FRAXUSDT', 'USTCUSDT', 'FDUSDUSDT', 'PYUSDUSDT',
    'EURUSDT', 'EUROCUSDT', 'GBPUSDT', 'AUDUSDT',
]);

const fmtNum = (n: number) => Number.isFinite(n) ? n : 0;

function mergeConfig(base: SignalAnalyzerConfig, override?: Partial<SignalAnalyzerConfig>): SignalAnalyzerConfig {
    if (!override) return base;
    return {
        ...base,
        ...override,
        lookbacks: { ...base.lookbacks, ...override.lookbacks },
        weights: { ...base.weights, ...override.weights },
        decision: { ...base.decision, ...override.decision },
        position: { ...base.position, ...override.position },
        levels: { ...base.levels, ...override.levels },
        safety: { ...base.safety, ...override.safety },
        technical: { ...base.technical, ...override.technical },
        fees: { ...base.fees, ...override.fees },
    };
}

function computeMarketContext(
    btcBars: BarData[] | undefined,
    ethBars: BarData[] | undefined
): MarketContext {
    const getTrend = (bars: BarData[] | undefined): { trend: TrendState; changePct5m: number } => {
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
    let globalTrend = btcTrend.trend;
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
    regime?: string;
    rawScore?: number;
    moduleAgreement?: number;
}

export async function runBacktest(options: BacktestOptions = {}): Promise<BacktestResult> {
    const initialBalance = options.initialBalance ?? 100;
    const config = mergeConfig(DEFAULT_CONFIG, options.configOverride);
    const POS_CFG = config.position;
    const FEES_CFG = config.fees;
    const MIN_SCORE_THRESHOLD = config.decision.threshold || 0.01;

    await DatabaseModule.initialize();
    const historyRepo = AppDataSource.getRepository(HistoryCandle);

    const modules = [new MeanReversionModule(), new OrderflowModule(), new MomentumModule(), new OIModule()];
    const gates = [new TrendAlignmentGate(), new MeanReversionGate(), new AntiSpamGate()];
    const gatekeeper = new TradeGatekeeper(gates);
    const analyzer = new SignalAnalyzerService(modules, gatekeeper, config);

    const allSymbolsRaw = await historyRepo.createQueryBuilder('c').select('DISTINCT(c.symbol)', 'symbol').getRawMany();
    const allSymbols = allSymbolsRaw.map((r: any) => r.symbol).filter((s: string) => !BLACKLIST.has(s));
    const selectedSymbols = options.symbols?.length ? allSymbols.filter(s => options.symbols!.includes(s)) : allSymbols;
    const limitedSymbols = options.maxSymbols ? selectedSymbols.slice(0, options.maxSymbols) : selectedSymbols;

    const marketData = new Map<string, BarData[]>();
    const timelineSet = new Set<number>();

    for (const symbol of limitedSymbols) {
        const qb = historyRepo
            .createQueryBuilder('h')
            .select('h.data')
            .where('h.symbol = :symbol', { symbol })
            .orderBy('h.ts', 'ASC');

        const rawResults = await qb.getMany();
        const bars = rawResults.map(r => r.data as unknown as BarData)
            .filter(b => (options.startTs ? b.ts >= options.startTs : true) && (options.endTs ? b.ts <= options.endTs : true));

        if (bars.length < 200) continue;

        const durationH = (bars[bars.length - 1].ts - bars[0].ts) / 3600000;
        const totalVol = bars.reduce((sum, b) => sum + (b.v * b.c), 0);
        if ((totalVol / Math.max(durationH, 1)) * 24 < 50_000_000) continue;

        marketData.set(symbol, bars);
        bars.forEach(b => timelineSet.add(b.ts));

        if (!options.skipWarmup) {
            analyzer.warmUp(symbol, bars.slice(0, 150));
        }
    }

    const timeline = Array.from(timelineSet).sort((a, b) => a - b);

    let balance = initialBalance;
    let maxEquity = balance;
    let maxDrawdown = 0;
    let activePositions: ActivePosition[] = [];
    const tradeHistory: TradeRecord[] = [];

    const cursorIndices = new Map<string, number>();
    for (const sym of marketData.keys()) cursorIndices.set(sym, 0);

    for (const ts of timeline) {
        if (options.maxTrades && tradeHistory.length >= options.maxTrades) break;

        const currentMarket: { symbol: string; bar: BarData }[] = [];
        for (const [sym, bars] of marketData.entries()) {
            let idx = cursorIndices.get(sym) || 0;
            while (idx < bars.length - 1 && bars[idx].ts < ts) idx++;
            cursorIndices.set(sym, idx);
            if (bars[idx].ts === ts) currentMarket.push({ symbol: sym, bar: bars[idx] });
        }

        // Manage open positions
        for (let i = activePositions.length - 1; i >= 0; i--) {
            const pos = activePositions[i];
            const marketItem = currentMarket.find(m => m.symbol === pos.symbol);
            if (!marketItem) continue;

            const bar = marketItem.bar;
            if (bar.ts === pos.openTime) continue;

            const isLong = pos.action === 'LONG';
            const positionValue = pos.quantity * bar.c;

            // Funding
            if (ts - pos.lastFundingTime >= FUNDING_INTERVAL) {
                const fundingCost = positionValue * FUNDING_RATE;
                balance -= fundingCost;
                pos.lastFundingTime = ts;
            }

            // Liquidation
            const worstPrice = isLong ? bar.l : bar.h;
            const worstPnl = (worstPrice - pos.entryPrice) * pos.quantity * (isLong ? 1 : -1);
            const currentMargin = pos.margin + worstPnl;
            const maintenanceMargin = (pos.entryPrice * pos.quantity) * MAINT_MARGIN_RATE;

            if (currentMargin <= maintenanceMargin) {
                const liquidationLoss = pos.margin + (positionValue * LIQUIDATION_FEE);
                balance -= liquidationLoss;
                tradeHistory.push({
                    symbol: pos.symbol,
                    action: pos.action,
                    pnl: -liquidationLoss,
                    reason: 'LIQUIDATION',
                    openedAt: pos.openTime,
                    closedAt: ts,
                    entry: pos.entryPrice,
                    exit: worstPrice,
                    regime: pos.regime,
                    rawScore: pos.rawScore,
                    moduleAgreement: pos.moduleAgreement,
                });
                activePositions.splice(i, 1);
                maxEquity = Math.max(maxEquity, balance);
                maxDrawdown = Math.max(maxDrawdown, (maxEquity - balance));
                continue;
            }

            // SL / TP / Expiry
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

                tradeHistory.push({
                    symbol: pos.symbol,
                    action: pos.action,
                    pnl: netPnl,
                    reason,
                    openedAt: pos.openTime,
                    closedAt: ts,
                    entry: pos.entryPrice,
                    exit: closePrice,
                    regime: pos.regime,
                    rawScore: pos.rawScore,
                    moduleAgreement: pos.moduleAgreement,
                });

                activePositions.splice(i, 1);
                maxEquity = Math.max(maxEquity, balance);
                maxDrawdown = Math.max(maxDrawdown, (maxEquity - balance));
            }
        }

        // Find new trades
        if (activePositions.length < POS_CFG.maxOpenTrades && balance > 10) {
            const candidates: { sym: string; res: SignalResult; bar: BarData }[] = [];

            for (const { symbol, bar } of currentMarket) {
                if (activePositions.find(p => p.symbol === symbol)) continue;
                const idx = cursorIndices.get(symbol)!;
                if (idx < 50) continue;
                const allBars = marketData.get(symbol)!;
                const slice = allBars.slice(Math.max(0, idx - 200), idx);

                const btcIdx = cursorIndices.get('BTCUSDT') || 0;
                const ethIdx = cursorIndices.get('ETHUSDT') || 0;
                const btcBars = marketData.get('BTCUSDT')?.slice(Math.max(0, btcIdx - 35), btcIdx + 1);
                const ethBars = marketData.get('ETHUSDT')?.slice(Math.max(0, ethIdx - 35), ethIdx + 1);
                const marketContext = computeMarketContext(btcBars, ethBars);

                const result = analyzer.analyze(symbol, slice, marketContext, balance);

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
                    positionSizeUsd = Math.min(riskUsd / Math.max(slPct, 1e-9), balance * POS_CFG.leverage);
                    quantity = positionSizeUsd / res.entryPrice;
                }

                if (positionSizeUsd < 5) continue;

                let entryPriceReal = res.entryPrice;
                let isFilled = true;
                let isMaker = res.entryType === 'limit';

                if (res.entryType === 'limit') {
                    const canFillLong = res.action === 'LONG' && bar.l <= res.entryPrice;
                    const canFillShort = res.action === 'SHORT' && bar.h >= res.entryPrice;
                    isFilled = canFillLong || canFillShort;
                    if (!isFilled) continue;
                    entryPriceReal = res.entryPrice;
                } else {
                    const slipDir = res.action === 'LONG' ? 1 : -1;
                    entryPriceReal = bar.o * (1 + FEES_CFG.slippage * slipDir);
                    isMaker = false;
                }

                const requiredMargin = positionSizeUsd / POS_CFG.leverage;
                const entryFeeRate = isMaker ? FEES_CFG.maker : FEES_CFG.taker;
                const entryFee = (entryPriceReal * quantity) * entryFeeRate;

                if (balance < (requiredMargin + entryFee)) continue;
                balance -= (requiredMargin + entryFee);

                const isLong = res.action === 'LONG';
                const direction = isLong ? 1 : -1;
                const originalSlDistance = Math.abs(res.entryPrice - res.sl);
                const slPct = originalSlDistance / res.entryPrice;
                const adjustedSl = entryPriceReal - (direction * entryPriceReal * slPct);
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
                    quantity,
                    margin: requiredMargin,
                    leverage: POS_CFG.leverage,
                    tp: adjustedTp,
                    sl: adjustedSl,
                    openTime: ts,
                    lastFundingTime: ts,
                    regime: res.marketRegime,
                    rawScore: res.meta.rawScore,
                    moduleAgreement: res.meta.moduleAgreement,
                });
            }
        }
    }

    activePositions.forEach(p => balance += p.margin);

    const wins = tradeHistory.filter(t => t.pnl > 0).length;
    const losses = tradeHistory.filter(t => t.pnl <= 0).length;
    const winrate = tradeHistory.length > 0 ? wins / tradeHistory.length * 100 : 0;
    const netPnl = balance - initialBalance;
    const expectancy = tradeHistory.length > 0 ? tradeHistory.reduce((s, t) => s + t.pnl, 0) / tradeHistory.length : 0;

    const pnlByRegime: BacktestMetrics['pnlByRegime'] = {};
    for (const t of tradeHistory) {
        const regime = t.regime || 'UNKNOWN';
        if (!pnlByRegime[regime]) pnlByRegime[regime] = { trades: 0, pnl: 0, wins: 0, losses: 0 };
        pnlByRegime[regime].trades += 1;
        pnlByRegime[regime].pnl += fmtNum(t.pnl);
        if (t.pnl > 0) pnlByRegime[regime].wins += 1; else pnlByRegime[regime].losses += 1;
    }

    await DatabaseModule.close();

    return {
        metrics: {
            trades: tradeHistory.length,
            wins,
            losses,
            winrate: parseFloat(winrate.toFixed(2)),
            finalBalance: parseFloat(balance.toFixed(2)),
            netPnl: parseFloat(netPnl.toFixed(2)),
            maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
            expectancy: parseFloat(expectancy.toFixed(4)),
            pnlByRegime,
        },
        trades: tradeHistory,
    };
}

// CLI usage: node -r ts-node/register scripts/backtest-runner.ts
if (require.main === module) {
    (async () => {
        const result = await runBacktest();
        console.log('Trades:', result.metrics.trades);
        console.log('Winrate:', result.metrics.winrate.toFixed(2), '%');
        console.log('Net PnL:', result.metrics.netPnl.toFixed(2));
        console.log('Max DD:', result.metrics.maxDrawdown.toFixed(2));
    })().catch(err => {
        console.error('Backtest failed', err);
        process.exit(1);
    });
}

