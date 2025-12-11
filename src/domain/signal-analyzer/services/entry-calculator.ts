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

        // 1. ВХОД (ENTRY)
        // Для скальпинга входим сразу по рынку или с минимальным отступом
        let entryPrice = currentBar.c;
        const entryType: EntryType = 'market';

        if (this.config.technical.entryOffsetAtrMult > 0) {
             // Лимитка чуть лучше рынка (на откате)
             entryPrice -= (direction * features.atr * this.config.technical.entryOffsetAtrMult);
        }

        // 2. СТОП-ЛОСС (STOP LOSS) - ИСПРАВЛЕННАЯ ЛОГИКА
        // Используем настройку из конфига, а не хардкод
        const lookback = this.config.technical.slStructuralBars || 2; 
        
        // Берем последние N баров (включая текущий)
        const relevantBars = bars.slice(-lookback);
        const recentHigh = Math.max(...relevantBars.map(b => b.h));
        const recentLow = Math.min(...relevantBars.map(b => b.l));

        // Выбираем множитель ATR в зависимости от режима (адаптивность)
        let slMultiplier = this.config.technical.slAtrMultMin;
        if (regime === 'VOLATILE') {
            slMultiplier = this.config.technical.slAtrMultMax;
        }

        // Расчет уровня стопа
        let slPrice: number;
        if (isLong) {
            // SL под локальным минимумом
            const structuralSl = recentLow - (features.atr * slMultiplier);
            // Хард кап стопа: не дальше чем entry - slAtrMultMax * ATR
            const maxSlDist = features.atr * this.config.technical.slAtrMultMax;
            slPrice = Math.max(structuralSl, entryPrice - maxSlDist);
        } else {
            // SL над локальным максимумом
            const structuralSl = recentHigh + (features.atr * slMultiplier);
            const maxSlDist = features.atr * this.config.technical.slAtrMultMax;
            slPrice = Math.min(structuralSl, entryPrice + maxSlDist);
        }

        // Защита от слишком близкого стопа (шум)
        const minSlDist = entryPrice * 0.003; // Минимум 0.3%
        if (Math.abs(entryPrice - slPrice) < minSlDist) {
            slPrice = entryPrice - (direction * minSlDist);
        }

        // 3. ТЕЙК-ПРОФИТ (TAKE PROFIT)
        const risk = Math.abs(entryPrice - slPrice);
        
        // Используем коэффициенты из конфига [2.0, 4.0]
        const tp = this.config.technical.tpRatios.map(ratio => {
            return entryPrice + (direction * risk * ratio);
        });

        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        // Sanity Check: Если стоп > 5%, отменяем сделку (слишком опасно для скальпа)
        const slPct = Math.abs((slPrice - entryPrice) / entryPrice) * 100;
        if (slPct > 5.0) {
            return { ...this.emptyResult(), isValid: false, reason: 'StopLoss too wide (>5%)' };
        }

        // 4. ГОРИЗОНТ И РИСК
        // Динамический расчет времени удержания
        const estimatedMinutes = Math.ceil((risk * 2) / (features.atr || 1));
        const horizonMin = Math.min(Math.max(15, estimatedMinutes), 120);

        return {
            entryType,
            entryPrice,
            sl: slPrice,
            tp,
            tpPct,
            horizonMin,
            riskPct: this.config.position.baseRiskPct, // 1%
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