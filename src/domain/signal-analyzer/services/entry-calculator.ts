import { TradeAction, EntryType, BarData, AggregatedBar, Features } from '../types';
import { DEFAULT_CONFIG } from '../types/config';
import { MarketRegime } from './regime-supervisor'; // <-- Импортируем типы

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
    private readonly MIN_PROFIT_PCT = 0.0025; // 0.25% min target

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

        // [cite_start]// 1. АДАПТАЦИЯ КОЭФФИЦИЕНТОВ (Оставляем как было) [cite: 762]
        let slMultiplier = 1.5;
        let tp1Multiplier = 1.5;
        let tp2Multiplier = 3.0;

        switch (regime) {
            case 'TRENDING':
                slMultiplier = 1.2; tp1Multiplier = 2.0; tp2Multiplier = 5.0;
                break;
            case 'VOLATILE':
                slMultiplier = 2.0; tp1Multiplier = 1.2; tp2Multiplier = 2.5;
                break;
            case 'RANGING':
            default:
                slMultiplier = 1.5; tp1Multiplier = 1.5; tp2Multiplier = 3.0;
                break;
        }

        // =========================================================
        // 2. ВХОД (ENTRY) - ИСПРАВЛЕННАЯ ЛОГИКА
        // =========================================================
        
        // Определяем, насколько быстро движется рынок
        // flowImb > 0.3 означает сильный дисбаланс рыночных ордеров
        // volZ > 2.0 означает аномально высокий объем
        const isHighVelocity = Math.abs(features.flowImb) > 0.3 || features.volZ > 2.0;

        // Мы входим по РЫНКУ (Market), если:
        // А) Общая уверенность высокая (> 0.6) - мы доверяем сигналу целиком.
        // Б) ИЛИ рынок летит очень быстро (isHighVelocity) - ждать отката нельзя, улетит.
        const isUrgent = confidence >= 0.6 || isHighVelocity; 
        
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';

        if (!isUrgent) {
            // Если рынок спокойный и уверенность средняя -> пробуем лимитку
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

        // [cite_start]// 3. СТОП-ЛОСС (Оставляем как было) [cite: 775]
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

        // [cite_start]// 4. ТЕЙК-ПРОФИТ (Оставляем как было) [cite: 779]
        const distSl = Math.abs(entryPrice - sl);
        const greedFactor = 0.95; 

        // TP1
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

        // TP2 (Runner)
        const tp2 = entryPrice + (direction * distSl * tp2Multiplier);
        const tp = [tp1, tp2];
        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        // [cite_start]// 5. VALIDATION [cite: 786]
        if (tpPct[0] < 0.25) { // 0.25% min profit
             return { ...this.emptyResult(), isValid: false, reason: 'RR too low' };
        }

        return {
            entryType,
            entryPrice,
            sl,
            tp,
            tpPct,
            horizonMin: regime === 'VOLATILE' ? 5 : 15,
            riskPct: this.positionConfig.baseRiskPct * confidence, 
            isValid: true
        };
    }

    private emptyResult(): EntryResult {
        return { entryType: 'market', entryPrice: 0, sl: 0, tp: [], tpPct: [], horizonMin: 0, riskPct: 0, isValid: false };
    }
}