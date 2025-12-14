// src/domain/signal-analyzer/services/entry-calculator.ts

import { TradeAction, EntryType, BarData, AggregatedBar, Features } from '../types';
import { DEFAULT_CONFIG } from '../types/config';
import { MarketRegime } from './regime-supervisor';

export interface EntryResult {
    entryType: EntryType;
    entryPrice: number;
    sl: number;
    tp: number[];
    tpPct: number[];
    horizonMin: number;
    riskPct: number;
    isValid: boolean;
    reason?: string;
}

export class EntryCalculator {
    // Внедряем зависимости через конструктор или используем дефолт
    // Лучше передавать конфиг в метод calculate, но пока берем из импорта для совместимости
    private readonly config = DEFAULT_CONFIG;

    calculate(
        action: TradeAction,
        bars: (BarData | AggregatedBar)[],
        features: Features,
        confidence: number,
        regime: MarketRegime = 'RANGING'
    ): EntryResult {
        if (action === 'NO_TRADE' || bars.length < 5) {
            return this.emptyResult();
        }

        const currentBar = bars[bars.length - 1];
        const isLong = action === 'LONG';
        const direction = isLong ? 1 : -1;

        // --- ENTRY ---
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';

        if (this.config.technical.entryOffsetAtrMult > 0) {
            entryPrice -= (direction * features.atr * this.config.technical.entryOffsetAtrMult);
            entryType = 'limit'; // корректно выставляем тип
        }

        // --- STOP LOSS ---
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

        const minSlDist = entryPrice * 0.003;
        if (Math.abs(entryPrice - slPrice) < minSlDist) {
            slPrice = entryPrice - (direction * minSlDist);
        }

        // --- TAKE PROFIT ---
        const risk = Math.abs(entryPrice - slPrice);

        // Адаптивные TP множители
        let tpRatios = this.config.technical.tpRatios;
        if (regime === 'TRENDING') tpRatios = [3.0, 6.0];
        if (regime === 'RANGING') tpRatios = [1.5, 3.0];

        const tp = tpRatios.map(ratio => entryPrice + (direction * risk * ratio));
        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        const slPct = Math.abs((slPrice - entryPrice) / entryPrice) * 100;
        if (slPct > 5.0) {
            return { ...this.emptyResult(), isValid: false, reason: 'StopLoss too wide (>5%)' };
        }

        // --- HORIZON & RISK ---
        const estimatedMinutes = Math.ceil((risk * 2) / (features.atr || 1));
        const horizonMin = Math.min(Math.max(30, estimatedMinutes), 180);

        // Адаптивный риск: масштабируем от confidence
        let riskPct = this.config.position.baseRiskPct;
        riskPct *= confidence; // при низком confidence риск снижается
        if (regime === 'VOLATILE') riskPct *= 0.7; // в волатильном режиме ещё меньше

        return {
            entryType,
            entryPrice,
            sl: slPrice,
            tp,
            tpPct,
            horizonMin,
            riskPct,
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
            isValid: false
        };
    }
}