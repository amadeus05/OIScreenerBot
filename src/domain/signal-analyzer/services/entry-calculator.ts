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
    isValid: boolean; // Флаг: стоит ли открывать сделку (проверка RR и комиссий)
    reason?: string;
}

export class EntryCalculator {
    private readonly config = DEFAULT_CONFIG.technical;
    private readonly positionConfig = DEFAULT_CONFIG.position;

    // Минимальный профит, чтобы перекрыть комиссии (0.06% taker * 2 + проскальзывание)
    private readonly MIN_PROFIT_PCT = 0.002; // 0.2%

    /**
     * Calculate entry parameters for a trade
     */
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

        // 1. Определение типа входа
        // Если уверенность высокая (>0.7) - бьем по рынку, чтобы не упустить движение.
        // Если средняя - пробуем лимитку (pullback).
        const isUrgent = confidence >= 0.7;

        const { entryType, entryPrice } = this.calculateEntry(
            currentBar.lastPrice,
            features.atr,
            direction,
            isUrgent
        );

        // 2. Расчет Stop Loss
        const sl = this.calculateSmartStopLoss(bars, entryPrice, features.atr, isLong);
        const riskDist = Math.abs(entryPrice - sl);

        // Проверка: Если стоп слишком близко (шум) или слишком далеко (риск)
        const riskPct = riskDist / entryPrice;
        if (riskPct < 0.001) { // Стоп < 0.1% - это самоубийство об спред
            return this.invalidResult('Stop Loss too tight (spread risk)');
        }

        // 3. Расчет Take Profit
        const { tp, tpPct } = this.calculateTakeProfit(entryPrice, riskDist, isLong, confidence);

        // 4. Финальная валидация (RR Check)
        // Первый тейк должен быть больше минимального порога рентабельности
        if (tpPct[0] < this.MIN_PROFIT_PCT * 100) {
            return this.invalidResult('Potential profit covers only fees');
        }

        // 5. Горизонт и Риск на сделку
        const horizonMin = this.calculateHorizon(features.atr, bars);
        const positionRiskPct = this.positionConfig.baseRiskPct * confidence;

        return {
            entryType,
            entryPrice,
            sl,
            tp,
            tpPct,
            horizonMin,
            riskPct: positionRiskPct,
            isValid: true
        };
    }

    private calculateEntry(
        lastPrice: number,
        atr: number,
        direction: number,
        isUrgent: boolean
    ): { entryType: EntryType; entryPrice: number } {
        // High Confidence -> Market Order
        if (isUrgent) {
            return {
                entryType: 'market',
                entryPrice: lastPrice, // Для бэктеста считаем по текущей, в реале будет проскальзывание
            };
        }

        // Medium Confidence -> Limit Order (Smart Pullback)
        // Ставим лимитку чуть лучше текущей цены, но не слишком далеко
        const offset = atr > 0 ? atr * 0.15 : lastPrice * 0.0005;
        return {
            entryType: 'limit',
            entryPrice: lastPrice - (direction * offset),
        };
    }

    private calculateSmartStopLoss(
        bars: (BarData | AggregatedBar)[],
        entryPrice: number,
        atr: number,
        isLong: boolean
    ): number {
        const direction = isLong ? 1 : -1;

        // 1. Поиск локального фрактала (Pivot)
        // Ищем Low/High, который окружен более высокими Low (для лонга)
        // Берем окно 20 баров
        const lookback = Math.min(bars.length, 20);
        const relevantBars = bars.slice(-lookback);

        let structuralPrice: number | null = null;

        if (isLong) {
            // Ищем минимальный Low
            structuralPrice = Math.min(...relevantBars.map(b => b.l));
        } else {
            // Ищем максимальный High
            structuralPrice = Math.max(...relevantBars.map(b => b.h));
        }

        // 2. Валидация через ATR (Clamp)
        const distToStructure = Math.abs(entryPrice - structuralPrice);
        const minDist = atr * 0.8; // Минимум 0.8 ATR (поднял с 0.5, чтобы избежать шума)
        const maxDist = atr * 3.0; // Максимум 3 ATR

        let finalDistance = distToStructure;

        // Если структурный стоп слишком близко -> расширяем до ATR
        if (distToStructure < minDist) {
            finalDistance = minDist;
        }
        // Если структурный стоп слишком далеко -> поджимаем до 3 ATR
        else if (distToStructure > maxDist) {
            finalDistance = maxDist;
        }

        // 3. Буфер на сквиз
        // Добавляем 5% от размера стопа про запас
        finalDistance *= 1.05;

        return entryPrice - (direction * finalDistance);
    }

    private calculateTakeProfit(
        entryPrice: number,
        riskDist: number, // Расстояние до стопа
        isLong: boolean,
        confidence: number
    ): { tp: number[]; tpPct: number[] } {
        const direction = isLong ? 1 : -1;

        // Динамический RR в зависимости от уверенности
        // Low Conf: 1:1, 1:1.5
        // High Conf: 1:1.5, 1:2.5
        let ratios = [1.0, 1.5];

        if (confidence > 0.75) {
            ratios = [1.3, 2.5]; // Требуем больше от хорошей сделки
        }

        const tp: number[] = [];
        const tpPct: number[] = [];

        for (const ratio of ratios) {
            const price = entryPrice + (direction * riskDist * ratio);
            const pct = Math.abs((price - entryPrice) / entryPrice) * 100;

            tp.push(price);
            tpPct.push(pct);
        }

        return { tp, tpPct };
    }

    private calculateHorizon(atr: number, bars: (BarData | AggregatedBar)[]): number {
        // Если волатильность дикая (ATR растет), горизонт сокращаем (скальпинг)
        // Если флэт, горизонт увеличиваем
        if (bars.length < 20) return 15;

        const recentATRs = bars.slice(-10).map(b => b.h - b.l);
        const avgRecentAtr = recentATRs.reduce((a, b) => a + b) / recentATRs.length;

        let horizon = 15; // Base

        if (avgRecentAtr > 0 && atr > 0) {
            const volatilityRatio = atr / avgRecentAtr;
            // Если текущая волатильность в 2 раза выше средней -> горизонт 7 минут
            // Если в 2 раза ниже -> горизонт 30 минут
            horizon = Math.round(15 / volatilityRatio);
        }

        return clamp(horizon, 5, 60);
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

    private invalidResult(reason: string): EntryResult {
        return {
            ...this.emptyResult(),
            isValid: false,
            reason
        };
    }
}