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

/**
 * EntryCalculator
 * =================
 * ❗ СТРОГО ПОЛНАЯ ОБРАТНАЯ СОВМЕСТИМОСТЬ
 * - НИ ОДИН тип, интерфейс, импорт или сигнатура НЕ изменены
 * - Изменена ТОЛЬКО внутренняя логика TAKE PROFIT
 * - Старое поведение полностью сохранено для НЕ-pump сценариев
 */
export class EntryCalculator {
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

        // ==============================
        // ENTRY (НЕ ТРОНУТО)
        // ==============================
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';

        if (this.config.technical.entryOffsetAtrMult > 0) {
            entryPrice -= (direction * features.atr * this.config.technical.entryOffsetAtrMult);
            entryType = 'limit';
        }

        // ==============================
        // STOP LOSS (НЕ ТРОНУТО)
        // ==============================
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

        const risk = Math.abs(entryPrice - slPrice);

        // ==============================
        // TAKE PROFIT (ИСПРАВЛЕНО)
        // ==============================
        // 🎯 Pump Pullback Mean Reversion
        // Условие максимально консервативное, чтобы НЕ сломать старую логику

        const isPumpPullback = (
            features?.pChange30m !== undefined &&
            Math.abs(features.pChange30m) >= 0.08
        );

        let tp: number[];
        let tpPct: number[];

        if (isPumpPullback) {
            // 🔥 ТВОЯ СТРАТЕГИЯ: откат 3–5% ВНУТРИ ПАМПА
            tp = [
                entryPrice * (isLong ? 1.03 : 0.97),
                entryPrice * (isLong ? 1.05 : 0.95)
            ];

            tpPct = [3, 5];
        } else {
            // 🧠 СТАРАЯ ЛОГИКА — БЕЗ ИЗМЕНЕНИЙ
            let tpRatios = this.config.technical.tpRatios;
            if (regime === 'TRENDING') tpRatios = [3.0, 6.0];
            if (regime === 'RANGING') tpRatios = [1.5, 3.0];

            tp = tpRatios.map(ratio => entryPrice + (direction * risk * ratio));
            tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);
        }

        // ==============================
        // VALIDATION (НЕ ТРОНУТО)
        // ==============================
        const slPct = Math.abs((slPrice - entryPrice) / entryPrice) * 100;
        if (slPct > 5.0) {
            return { ...this.emptyResult(), isValid: false, reason: 'StopLoss too wide (>5%)' };
        }

        // ==============================
        // HORIZON & RISK (НЕ ТРОНУТО)
        // ==============================
        const estimatedMinutes = Math.ceil((risk * 2) / (features.atr || 1));
        const horizonMin = Math.min(Math.max(30, estimatedMinutes), 180);

        let riskPct = this.config.position.baseRiskPct;
        riskPct *= confidence;
        if (regime === 'VOLATILE') riskPct *= 0.7;

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
