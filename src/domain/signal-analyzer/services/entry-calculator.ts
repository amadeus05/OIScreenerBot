import { TradeAction, EntryType, BarData, AggregatedBar, Features } from '../types';
import { DEFAULT_CONFIG } from '../types/config';
import { clamp } from '../utils/rolling-stats';

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
        confidence: number
    ): EntryResult {
        if (action === 'NO_TRADE' || bars.length < 10) {
            return this.emptyResult();
        }

        const currentBar = bars[bars.length - 1];
        const isLong = action === 'LONG';
        const direction = isLong ? 1 : -1;

        // 1. ENTRY LOGIC
        // Для стратегии разворота (Mean Reversion), если уверенность высокая - бьем по рынку,
        // так как цена может быстро улететь от дисбаланса.
        // Если уверенность средняя - пытаемся поймать ретест EMA.
        const isUrgent = confidence >= 0.6; 
        
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';

        if (!isUrgent) {
            entryType = 'limit';
            // Пытаемся взять от emaFast, если она близко, иначе просто небольшой отступ
            const smartPullback = features.emaFast;
            // Проверка, что emaFast не слишком далеко (> 0.5% цены), иначе ордер никогда не исполнится
            const distToEma = Math.abs(currentBar.c - smartPullback) / currentBar.c;
            
            if (distToEma < 0.005) {
                entryPrice = smartPullback;
            } else {
                // Фоллбэк: 0.1 ATR отступ
                entryPrice = currentBar.c - (direction * features.atr * 0.1);
            }
        }

        // 2. STOP LOSS (TIGHT)
        // Для разворотов стоп должен быть коротким. Сразу за экстремумом.
        const lookback = 10;
        const recentHigh = Math.max(...bars.slice(-lookback).map(b => b.h));
        const recentLow = Math.min(...bars.slice(-lookback).map(b => b.l));
        
        let sl = isLong 
            ? Math.min(recentLow, currentBar.l) - (features.atr * 0.5) 
            : Math.max(recentHigh, currentBar.h) + (features.atr * 0.5);

        // Safety check: Don't let SL be closer than 0.2% (noise)
        const minSlDist = entryPrice * 0.002;
        if (Math.abs(entryPrice - sl) < minSlDist) {
            sl = entryPrice - (direction * minSlDist);
        }

        // 3. TAKE PROFIT (Mean Reversion Targets)
        // Цель 1: Возврат к средней (EMA Slow)
        // Цель 2: Противоположный канал (2 ATR)
        const distSl = Math.abs(entryPrice - sl);
        
        // --- FIX: Уменьшаем жадность (Front-running) ---
        // Умножаем дистанцию на 0.9 (или 0.95). 
        // Мы отдаем 10% потенциальной прибыли рынку, но ГАРАНТИРУЕМ исполнение.
        const greedFactor = 0.9; 

        // Рассчитываем идеальную цель
        const idealTargetDist = distSl * 1.5;

        // TP1: Minimal 1.5R or EMA Slow cross (с учетом greedFactor)
        let tp1 = entryPrice + (direction * idealTargetDist * greedFactor);
        
        // Если EMA Slow выгоднее чем 1.5R, ставим её (возврат к средней)
        const distToMean = (features.emaSlow - entryPrice) * direction;
        if (distToMean > distSl * 1.5) {
            // Для EMA Slow также применяем greedFactor
            const emaTargetDist = Math.abs(features.emaSlow - entryPrice);
            tp1 = entryPrice + (direction * emaTargetDist * greedFactor);
        }

        const tp2 = entryPrice + (direction * distSl * 3.0); // Runner

        const tp = [tp1, tp2];
        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        // 4. VALIDATION
        if (tpPct[0] < this.MIN_PROFIT_PCT * 100) {
             return this.invalidResult('RR too low (Target too close)');
        }

        return {
            entryType,
            entryPrice,
            sl,
            tp,
            tpPct,
            horizonMin: 15, // Reversals are usually quick
            riskPct: this.positionConfig.baseRiskPct * confidence,
            isValid: true
        };
    }

    private emptyResult(): EntryResult {
        return { entryType: 'market', entryPrice: 0, sl: 0, tp: [], tpPct: [], horizonMin: 0, riskPct: 0, isValid: false };
    }

    private invalidResult(reason: string): EntryResult {
        return { ...this.emptyResult(), isValid: false, reason };
    }
}