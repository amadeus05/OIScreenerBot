// ========================================================================
// FILE: src/domain/signal-analyzer/services/entry-calculator.ts
// ========================================================================

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
    private readonly positionConfig = DEFAULT_CONFIG.position;
    
    calculate(
        action: TradeAction,
        bars: (BarData | AggregatedBar)[],
        features: Features,
        confidence: number,
        regime: MarketRegime = 'RANGING'
    ): EntryResult {
        if (action === 'NO_TRADE' || bars.length < 10) {
            return this.emptyResult();
        }

        const currentBar = bars[bars.length - 1];
        const isLong = action === 'LONG';
        const direction = isLong ? 1 : -1;

        // =========================================================
        // 1. АДАПТАЦИЯ КОЭФФИЦИЕНТОВ (RISK/REWARD)
        // =========================================================
        let slMultiplier = 2.0; 
        let tp1Multiplier = 1.0;
        let tp2Multiplier = 2.0;

        switch (regime) {
            case 'TRENDING':
                // 🔥 НОВЫЕ НАСТРОЙКИ: Широкий стоп (2.0), достижимый тейк (1.5)
                slMultiplier = 2.0; 
                tp1Multiplier = 1.5; 
                tp2Multiplier = 3.0; 
                break;
            case 'VOLATILE':
                slMultiplier = 3.0; 
                tp1Multiplier = 1.0; 
                tp2Multiplier = 2.0;
                break;
            case 'RANGING':
            default:
                slMultiplier = 2.0; 
                tp1Multiplier = 1.0; 
                tp2Multiplier = 2.0;
                break;
        }

        // =========================================================
        // 2. ВХОД (ENTRY)
        // =========================================================
        const isHighVelocity = Math.abs(features.flowImb) > 0.3 || features.volZ > 2.0;
        const isUrgent = confidence >= 0.6 || isHighVelocity; 
        
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';

        if (!isUrgent) {
            entryType = 'limit';
            const smartPullback = features.emaFast;
            const distToEma = Math.abs(currentBar.c - smartPullback) / currentBar.c;
            
            if (distToEma < 0.008) { 
                entryPrice = smartPullback;
            } else {
                entryPrice = currentBar.c - (direction * features.atr * 0.1);
            }
        }

        // =========================================================
        // 3. СТОП-ЛОСС (STOP LOSS)
        // =========================================================
        const lookback = 10;
        const recentHigh = Math.max(...bars.slice(-lookback).map(b => b.h));
        const recentLow = Math.min(...bars.slice(-lookback).map(b => b.l));

        let sl = isLong 
            ? Math.min(recentLow, currentBar.l) - (features.atr * slMultiplier) 
            : Math.max(recentHigh, currentBar.h) + (features.atr * slMultiplier);

        const minSlDist = entryPrice * 0.002;
        if (Math.abs(entryPrice - sl) < minSlDist) {
            sl = entryPrice - (direction * minSlDist);
        }

        // =========================================================
        // 4. ТЕЙК-ПРОФИТ (TAKE PROFIT)
        // =========================================================
        const distSl = Math.abs(entryPrice - sl);
        const greedFactor = 0.95;

        let tp1 = entryPrice + (direction * distSl * tp1Multiplier * greedFactor);
        
        if (regime === 'RANGING') {
            const distToMean = (features.emaSlow - entryPrice) * direction;
            if (distToMean > distSl * 1.0) { 
                const emaTarget = features.emaSlow - (direction * features.atr * 0.1);
                if (Math.abs(entryPrice - emaTarget) < Math.abs(entryPrice - tp1)) {
                    tp1 = emaTarget;
                }
            }
        }

        const tp2 = entryPrice + (direction * distSl * tp2Multiplier);
        const tp = [tp1, tp2];
        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        if (tpPct[0] < 0.25) { 
             return { ...this.emptyResult(), isValid: false, reason: 'RR too low' };
        }

        // =========================================================
        // 6. 🔥 ДИНАМИЧЕСКИЙ ГОРИЗОНТ (TIME TO TARGET)
        // =========================================================
        
        const distToTp = Math.abs(tp[0] - entryPrice);
        // Скорость движения в минуту (через ATR)
        const speedPerMinute = features.atr > 0 ? features.atr : (currentBar.c * 0.001);
        let estimatedMinutes = distToTp / speedPerMinute;

        // Коэффициент зигзага (рынок не идет по прямой)
        const zigZagFactor = regime === 'VOLATILE' ? 2.0 : (regime === 'TRENDING' ? 3.0 : 4.0);
        estimatedMinutes *= zigZagFactor;

        // Ускорители (Объем и Поток)
        if (features.volZ > 2.0) estimatedMinutes *= 0.7; 
        if (Math.abs(features.flowImb) > 0.3) estimatedMinutes *= 0.8;

        // Лимиты: от 10 мин до 4 часов
        const dynamicHorizon = Math.ceil(Math.max(10, Math.min(estimatedMinutes, 240)));

        return {
            entryType,
            entryPrice,
            sl,
            tp,
            tpPct,
            horizonMin: dynamicHorizon, // Рассчитанное время
            riskPct: this.positionConfig.baseRiskPct * confidence, 
            isValid: true
        };
    }

    private emptyResult(): EntryResult {
        return { entryType: 'market', entryPrice: 0, sl: 0, tp: [], tpPct: [], horizonMin: 0, riskPct: 0, isValid: false };
    }
}