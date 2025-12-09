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
        regime: MarketRegime = 'RANGING' // <-- Добавляем аргумент
    ): EntryResult {
        if (action === 'NO_TRADE' || bars.length < 10) {
            return this.emptyResult();
        }

        const currentBar = bars[bars.length - 1];
        const isLong = action === 'LONG';
        const direction = isLong ? 1 : -1;

        // 1. АДАПТАЦИЯ КОЭФФИЦИЕНТОВ ПОД РЕЖИМ (Пункт 3 из ревью)
        let slMultiplier = 1.5; // База
        let tp1Multiplier = 1.5;
        let tp2Multiplier = 3.0;

        switch (regime) {
            case 'TRENDING':
                // В тренде стоп можно поближе (тренд защищает), а тейк - в космос
                slMultiplier = 1.2; 
                tp1Multiplier = 2.0; 
                tp2Multiplier = 5.0; // Let winners run!
                break;
            case 'VOLATILE':
                // В волатильности (новости/сквизы) стоп должен быть широким
                slMultiplier = 2.0; 
                tp1Multiplier = 1.2; // Быстро забираем свое
                tp2Multiplier = 2.5;
                break;
            case 'RANGING':
            default:
                // В боковике стандарт
                slMultiplier = 1.5;
                tp1Multiplier = 1.5;
                tp2Multiplier = 3.0;
                break;
        }

        // 2. ВХОД (ENTRY)
        const isUrgent = confidence >= 0.6; // Вернул 0.6 (исправление ошибки из прошлого чата)
        
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';

        if (!isUrgent) {
            entryType = 'limit';
            const smartPullback = features.emaFast;
            const distToEma = Math.abs(currentBar.c - smartPullback) / currentBar.c;
            
            // Если EMA близко, пробуем от нее. Если далеко - просто отступ.
            if (distToEma < 0.008) { // Чуть расширил окно для лимитки
                entryPrice = smartPullback;
            } else {
                entryPrice = currentBar.c - (direction * features.atr * 0.1);
            }
        }

        // 3. СТОП-ЛОСС (Адаптивный)
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

        // 4. ТЕЙК-ПРОФИТ (Адаптивный)
        const distSl = Math.abs(entryPrice - sl);
        const greedFactor = 0.95; // 0.9 было слишком щедро, 0.95 оптимально

        // TP1
        let tp1 = entryPrice + (direction * distSl * tp1Multiplier * greedFactor);
        
        // В Тренде мы НЕ ограничиваем TP1 уровнем EMA Slow, мы хотим пробить его.
        // В Боковике (Ranging) мы уважаем среднюю.
        if (regime === 'RANGING') {
            const distToMean = (features.emaSlow - entryPrice) * direction;
            if (distToMean > distSl * 1.0) { // Если до средней есть хотя бы 1R
                // Ставим тейк перед средней
                const emaTarget = features.emaSlow - (direction * features.atr * 0.1);
                // Выбираем что ближе: расчетный TP1 или EMA
                if (Math.abs(entryPrice - emaTarget) < Math.abs(entryPrice - tp1)) {
                    tp1 = emaTarget;
                }
            }
        }

        // TP2 (Runner)
        const tp2 = entryPrice + (direction * distSl * tp2Multiplier);

        const tp = [tp1, tp2];
        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        // 5. VALIDATION
        if (tpPct[0] < this.MIN_PROFIT_PCT * 100) {
             return { ...this.emptyResult(), isValid: false, reason: 'RR too low' };
        }

        return {
            entryType,
            entryPrice,
            sl,
            tp,
            tpPct,
            horizonMin: regime === 'VOLATILE' ? 5 : 15, // На сквизах все быстро
            riskPct: this.positionConfig.baseRiskPct * confidence, // Пока оставим так (пункт 1 отложили)
            isValid: true
        };
    }

    private emptyResult(): EntryResult {
        return { entryType: 'market', entryPrice: 0, sl: 0, tp: [], tpPct: [], horizonMin: 0, riskPct: 0, isValid: false };
    }
}