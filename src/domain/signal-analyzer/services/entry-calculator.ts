// ========================================================================
// FILE: src/domain/signal-analyzer/services/entry-calculator.ts
// ========================================================================

import { TradeAction, EntryType, BarData, AggregatedBar, Features } from '../types';
import { DEFAULT_CONFIG, SignalAnalyzerConfig } from '../types/config';
import { MarketRegime } from './regime-supervisor';

export interface EntryResult {
    entryType: EntryType;
    entryPrice: number;
    sl: number;
    tp: number[];
    tpPct: number[];
    horizonMin: number;
    
    // === Данные для исполнения ===
    riskPct: number;          // % риска от депозита
    positionSizeUsd: number;  // Итоговый объем позиции в $
    quantity: number;         // Количество монет
    
    expectedPnL: number;
    feesInfo: {
        entryFee: number;
        exitFeeSl: number;
        exitFeeTp: number;
    };
    
    isValid: boolean;
    reason?: string;
}

export class EntryCalculator {
    private readonly config: SignalAnalyzerConfig;

    constructor(config: SignalAnalyzerConfig = DEFAULT_CONFIG) {
        this.config = config;
    }

    calculate(
        action: TradeAction,
        bars: (BarData | AggregatedBar)[],
        features: Features,
        confidence: number,
        regime: MarketRegime = 'RANGING',
        providedBalance?: number // <--- БАЛАНС ИЗ БЭКТЕСТА/БИРЖИ
    ): EntryResult {
        if (action === 'NO_TRADE' || bars.length < 5) {
            return this.emptyResult();
        }

        const currentBar = bars[bars.length - 1];
        const isLong = action === 'LONG';
        const direction = isLong ? 1 : -1;

        // 1. ENTRY PRICE
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';

        // Лимитный вход (если включен в конфиге)
        if (this.config.technical.entryOffsetAtrMult > 0) {
            const offset = features.atr * this.config.technical.entryOffsetAtrMult;
            entryPrice -= (direction * offset);
            entryType = 'limit';
        }
        
        // 2. STOP LOSS
        const lookback = this.config.technical.slStructuralBars || 2;
        const relevantBars = bars.slice(-lookback);
        const recentHigh = Math.max(...relevantBars.map(b => b.h));
        const recentLow = Math.min(...relevantBars.map(b => b.l));

        let slMultiplier = this.config.technical.slAtrMultMin;
        if (regime === 'VOLATILE') slMultiplier = this.config.technical.slAtrMultMax;

        let slPrice: number;
        if (isLong) {
            const structuralSl = recentLow - (features.atr * slMultiplier);
            const maxSlDist = features.atr * this.config.technical.slAtrMultMax;
            slPrice = Math.max(structuralSl, entryPrice - maxSlDist);
        } else {
            const structuralSl = recentHigh + (features.atr * slMultiplier);
            const maxSlDist = features.atr * this.config.technical.slAtrMultMax;
            slPrice = Math.min(structuralSl, entryPrice + maxSlDist);
        }

        // Min SL Distance protection
        const minSlDist = entryPrice * 0.003;
        if (Math.abs(entryPrice - slPrice) < minSlDist) {
            slPrice = entryPrice - (direction * minSlDist);
        }

        // 3. TAKE PROFIT
        const isPumpPullback = (
            features?.pChange30m !== undefined &&
            Math.abs(features.pChange30m) >= 0.08
        );
        const priceDistanceToSl = Math.abs(entryPrice - slPrice); 
        
        let tp: number[];
        
        if (isPumpPullback) {
            tp = [
                entryPrice + (direction * priceDistanceToSl * 1.5),
                entryPrice + (direction * priceDistanceToSl * 3.0)
            ];
        } else {
            let tpRatios = this.config.technical.tpRatios;
            if (regime === 'TRENDING') tpRatios = [3.0, 6.0];
            tp = tpRatios.map(ratio => entryPrice + (direction * priceDistanceToSl * ratio));
        }
        
        // 4. POSITION SIZING (Compounding Logic)
        // ======================================
        
        // 🔥 Если баланс передан (бэктест/лайв) — используем его. 
        // Иначе — берем дефолт из конфига (для тестов "в вакууме").
        const portfolioBalance = providedBalance || this.config.position.defaultPortfolioSize;

        let riskPct = this.config.position.baseRiskPct;
        riskPct *= confidence;
        if (regime === 'VOLATILE') riskPct *= 0.7;
        
        const riskAmountUsd = portfolioBalance * (riskPct / 100);
        const stopLossPct = priceDistanceToSl / entryPrice;

        // Размер позиции = Риск / %SL
        let positionSizeUsd = riskAmountUsd / stopLossPct;

        // Применяем лимиты
        const maxPos = this.config.position.maxPositionSizeUsd;
        const maxLev = portfolioBalance * this.config.position.leverage;
        positionSizeUsd = Math.min(positionSizeUsd, maxPos, maxLev);
        
        const quantity = positionSizeUsd / entryPrice;
        
        // 5. FEES & PROFITABILITY CHECK
        // =============================
        const entryFee = positionSizeUsd * this.config.fees.taker;
        const exitFeeSl = positionSizeUsd * this.config.fees.taker; // SL is Market
        const exitFeeTp = positionSizeUsd * this.config.fees.maker; // TP is Limit

        const grossProfitTp1 = (Math.abs(entryPrice - tp[0]) / entryPrice) * positionSizeUsd;
        const netProfitTp1 = grossProfitTp1 - (entryFee + exitFeeTp);

        // GUARD: Если расстояние до тейка меньше 0.6%, скорее всего комиссия съест прибыль
        const expectedMovePct = Math.abs(tp[0] - entryPrice) / entryPrice;
        if (expectedMovePct < 0.006) { // Меньше 0.6% движения
             return { ...this.emptyResult(), isValid: false, reason: `Target too close (<0.6%), fees will kill profit` };
        }

        // GUARD: Fees too high relative to profit
        if (entryFee + exitFeeTp > grossProfitTp1 * 0.4) {
             return { ...this.emptyResult(), isValid: false, reason: `Fees too high relative to profit` };
        }
        
        // GUARD: Minimum Profit - $1 или 1% от депозита (выбираем большее)
        const minProfitUsd = 1.0;
        const minProfitPct = portfolioBalance * 0.01; // 1% от депозита
        const minProfitRequired = Math.max(minProfitUsd, minProfitPct);
        
        if (netProfitTp1 < minProfitRequired) {
             return { ...this.emptyResult(), isValid: false, reason: `Net profit too low (${netProfitTp1.toFixed(2)}$ < ${minProfitRequired.toFixed(2)}$)` };
        }
        
        // GUARD: Stop Loss width
        if (stopLossPct * 100 > 8.0) {
            return { ...this.emptyResult(), isValid: false, reason: 'StopLoss too wide (>8%)' };
        }

        // 6. OUTPUT
        const estimatedMinutes = Math.ceil((priceDistanceToSl * 2) / (features.atr || 1));
        const horizonMin = Math.min(Math.max(30, estimatedMinutes), 180);
        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        return {
            entryType,
            entryPrice, 
            sl: slPrice,
            tp,
            tpPct,
            horizonMin,
            riskPct, 
            
            positionSizeUsd,
            quantity,
            expectedPnL: netProfitTp1,
            feesInfo: { entryFee, exitFeeSl, exitFeeTp },
            
            isValid: true
        };
    }

    private emptyResult(): EntryResult {
        return {
            entryType: 'market',
            entryPrice: 0,
            sl: 0,
            tp: [],
            tpPct: [],
            horizonMin: 0,
            riskPct: 0,
            positionSizeUsd: 0,
            quantity: 0,
            expectedPnL: 0,
            feesInfo: { entryFee: 0, exitFeeSl: 0, exitFeeTp: 0 },
            isValid: false
        };
    }
}