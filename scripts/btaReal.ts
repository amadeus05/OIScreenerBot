import 'reflect-metadata';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { SignalAnalyzerService, BarData, TradeAction, SignalResult } from '../src/domain/signal-analyzer';
import { MeanReversionModule } from '../src/domain/signal-analyzer/modules';
import { TradeGatekeeper } from '../src/domain/signal-analyzer/gatekeeper/trade-gatekeeper';
import { TrendAlignmentGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trend-alignment.gate';
import { MeanReversionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate';
import { AntiSpamGate } from '../src/domain/signal-analyzer/gatekeeper/gates/anti-spam.gate';
import { TradingSessionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trading-session.gate';
import { DEFAULT_CONFIG } from '../src/domain/signal-analyzer/types/config';

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
    if (abs >= 1_000_000) return `${sign}${(abs/1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}${(abs/1_000).toFixed(1)}K`;
    return `${sign}${abs.toFixed(0)}`;
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

    const modules = [new MeanReversionModule()];
    const gates = [new TrendAlignmentGate(), new MeanReversionGate(), new TradingSessionGate(), new AntiSpamGate()];
    const gatekeeper = new TradeGatekeeper(gates);
    const analyzer = new SignalAnalyzerService(modules, gatekeeper, DEFAULT_CONFIG);

    console.log('💀 Starting SYNCED Portfolio Backtest...');
    console.log(`💰 Balance: $${INITIAL_BALANCE}`);
    console.log(`⚙️ Mode: ${TECH_CFG.entryOffsetAtrMult > 0 ? 'LIMIT ENTRY (Offset)' : 'MARKET ENTRY'}`);
    console.log(`⚙️ Config: Lev x${POS_CFG.leverage} | Max Trades: ${POS_CFG.maxOpenTrades} | Risk: ${POS_CFG.baseRiskPct}%`);

    // --- LOAD DATA ---
    console.log('📥 Loading market data...');
    const allSymbols = await historyRepo.createQueryBuilder('c').select('DISTINCT(c.symbol)', 'symbol').getRawMany();
    const marketData = new Map<string, BarData[]>();
    const timelineSet = new Set<number>();
    
    // Черный список для теста
    const BLACKLIST = ['GUSDT', 'USDCUSDT', 'FDUSDUSDT', '1000WHYUSDT', 'COAIUSDT', 'SWARMSUSDT'];

    for (const { symbol } of allSymbols) {
        if (BLACKLIST.includes(symbol)) continue;
        const rawResults = await historyRepo.createQueryBuilder('h').select('h.data').where('h.symbol = :symbol', { symbol }).orderBy('h.ts', 'ASC').getMany();
        const bars = rawResults.map(r => r.data as unknown as BarData);
        
        if (bars.length < 200) continue;
        
        // Фильтр ликвидности (20M/day)
        const durationH = (bars[bars.length - 1].ts - bars[0].ts) / 3600000;
        const totalVol = bars.reduce((sum, b) => sum + (b.v * b.c), 0);
        if ((totalVol / durationH) * 24 < 20_000_000) continue;

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

                const result = analyzer.analyze(symbol, slice) as ExtendedSignalResult;

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

                activePositions.push({
                    id: `${res.symbol}-${ts}`,
                    symbol: res.symbol,
                    action: res.action,
                    entryPrice: entryPriceReal,
                    quantity: quantity,
                    margin: requiredMargin,
                    leverage: POS_CFG.leverage,
                    tp: res.tp,
                    sl: res.sl,
                    openTime: ts,
                    lastFundingTime: ts
                });

                console.log(`⚡ OPEN [${res.symbol}] ${res.action} (${res.entryType}) @ ${entryPriceReal.toFixed(4)}. Size: $${positionSizeUsd.toFixed(0)}`);

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

                    while(pastIdx >= 0 && fullHistory[pastIdx].ts > startTime) {
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

                } catch(e) {
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