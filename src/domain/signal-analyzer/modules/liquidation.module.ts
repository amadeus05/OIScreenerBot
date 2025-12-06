/**
 * Signal Analyzer Module - Liquidation Module V2
 * 
 * Enhanced liquidation cascade detection with:
 * - Intensity-based thresholds (Volume/OI normalized)
 * - Velocity/Acceleration analysis
 * - 15-minute bias & absorption detection
 * - Proper state management (no duplicates)
 */

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG, DEFAULT_CONFIG } from '../types/config';
import { BaseModule } from './base-module';

export class LiquidationModule extends BaseModule {
    readonly name = 'liquidations' as const;

    private readonly config = MODULE_CONFIG.liquidations;
    private readonly safetyConfig = DEFAULT_CONFIG.safety;

    // История хранится в виде "Интенсивности" (Volume / OI), чтобы убрать зависимость от роста рынка
    private historyIntensityLong: number[] = [];
    private historyIntensityShort: number[] = [];

    // 1000 минут ~ 16 часов для формирования статистики внутри дня
    private readonly historySize = 1000;

    // Защита от дублирования данных при каждом тике
    private lastProcessedTs = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];

        // Нужно минимум 15 свечей для расчета bias15m
        if (bars.length < 15) {
            return this.createOutput(0, 0.3, tags);
        }

        const currentBar = bars[bars.length - 1];
        const prevBar = bars[bars.length - 2];

        // ====================================================================
        // 1. УПРАВЛЕНИЕ ИСТОРИЕЙ (State Management)
        // ====================================================================
        // Обновляем статистику ТОЛЬКО при закрытии бара (появлении нового времени)
        if (currentBar.ts > this.lastProcessedTs) {
            if (this.lastProcessedTs !== 0) {
                // Берем OI предыдущего бара. Если OI нет, пытаемся взять Volume, или 1
                const prevOI = prevBar.oi || prevBar.v || 1;

                const normLong = (prevBar.liquidations?.long || 0) / prevOI;
                const normShort = (prevBar.liquidations?.short || 0) / prevOI;

                this.historyIntensityLong.push(normLong);
                this.historyIntensityShort.push(normShort);

                if (this.historyIntensityLong.length > this.historySize) {
                    this.historyIntensityLong.shift();
                    this.historyIntensityShort.shift();
                }
            }
            this.lastProcessedTs = currentBar.ts;
        }

        // ====================================================================
        // 2. РАСЧЕТ ТЕКУЩИХ МЕТРИК (Real-Time)
        // ====================================================================
        const currentOI = currentBar.oi || currentBar.v || 1;
        const liqs = currentBar.liquidations || { long: 0, short: 0, countLong: 0, countShort: 0, maxLong: 0, maxShort: 0 };

        // Интенсивность: Сколько % от Открытого Интереса ликвидировано прямо сейчас
        const intensityLong = liqs.long / currentOI;
        const intensityShort = liqs.short / currentOI;

        // Пороги: 98-й перцентиль (только редкие события)
        const threshLong = this.historyIntensityLong.length > 50
            ? this.calculatePercentile(this.historyIntensityLong, 0.98)
            : Infinity;
        const threshShort = this.historyIntensityShort.length > 50
            ? this.calculatePercentile(this.historyIntensityShort, 0.98)
            : Infinity;

        const isHugeLong = intensityLong > threshLong;
        const isHugeShort = intensityShort > threshShort;

        // ====================================================================
        // 3. АНАЛИЗ УСКОРЕНИЯ (Velocity / Acceleration)
        // ====================================================================
        const getSumLiq = (n: number, type: 'short' | 'long') => {
            return bars.slice(-n).reduce((acc, b) => acc + (b.liquidations?.[type] || 0), 0);
        };

        const shortVol3m = getSumLiq(3, 'short');
        const shortVol10m = getSumLiq(10, 'short');

        const rateShort3m = shortVol3m / 3;
        const rateShort10m = shortVol10m / 10;

        // Каскад = Скорость на последних 3 минутах в 2.5 раза выше средней за 10 минут
        const isShortCascadeAccel = rateShort3m > (rateShort10m * 2.5) && isHugeShort;

        const longVol3m = getSumLiq(3, 'long');
        const longVol10m = getSumLiq(10, 'long');
        const rateLong3m = longVol3m / 3;
        const rateLong10m = longVol10m / 10;
        const isLongCascadeAccel = rateLong3m > (rateLong10m * 2.5) && isHugeLong;

        // ====================================================================
        // 4. СКОРИНГ (Scoring Logic)
        // ====================================================================
        let score = 0;
        let reliability = 0.5;

        // --- A. Short Squeeze Logic (Bullish) ---
        if (isHugeShort && !isHugeLong) {
            tags.push('high_short_liq_intensity');

            if (isShortCascadeAccel) {
                score = 0.9;
                reliability = 0.85;
                tags.push('short_cascade_acceleration');
            } else {
                score = 0.6;
                reliability = 0.6;
            }

            // Panic Filter
            if (liqs.countShort > 300) {
                score = Math.min(0.95, score + 0.1);
                tags.push('retail_short_panic');
            }
        }

        // --- B. Long Flush Logic (Bearish) ---
        else if (isHugeLong && !isHugeShort) {
            tags.push('high_long_liq_intensity');

            if (isLongCascadeAccel) {
                score = -0.9;
                reliability = 0.85;
                tags.push('long_cascade_acceleration');
            } else {
                score = -0.6;
                reliability = 0.6;
            }

            if (liqs.countLong > 300) {
                score = Math.max(-0.95, score - 0.1);
                tags.push('retail_long_panic');
            }
        }

        // --- C. Конфликт (High Volatility / Chop) ---
        else if (isHugeLong && isHugeShort) {
            score = 0;
            tags.push('bi_directional_rekt');
            tags.push('chop_warning');
            reliability = 0.2;
        }

        // ====================================================================
        // 5. НАКОПИТЕЛЬНЫЙ АНАЛИЗ (15m Bias & Absorption)
        // ====================================================================

        const shortBias15m = getSumLiq(15, 'short');
        const longBias15m = getSumLiq(15, 'long');

        const priceOpen15m = bars[bars.length - 15].o;
        const priceClose = currentBar.c;

        // FIX: Normalize price move through ATR for universal comparison
        const priceMoveInAtr = (priceClose - priceOpen15m) / features.atr;

        const accumulatedThresholdShort = threshShort * 5 * currentOI;

        // Логика "Grinding Up" (Медленное выдавливание шортов)
        // ATR-normalized: moved at least 0.3 ATR up
        const isGrindingUp =
            shortBias15m > longBias15m * 3 &&
            shortBias15m > accumulatedThresholdShort &&
            priceMoveInAtr > 0.3;

        if (isGrindingUp) {
            // Проверка на "Стенку" (Absorption)
            const isAbsorption = shortBias15m > (accumulatedThresholdShort * 4) && priceMoveInAtr < 0.5;

            if (isAbsorption) {
                score = -0.6;
                tags.push('bullish_absorption_wall');
                reliability = 0.7;
            } else {
                score = Math.max(score, 0.75);
                tags.push('short_fuel_grinding_up');
                reliability = Math.max(reliability, 0.75);
            }
        }

        // Зеркальная логика для Grinding Down (ATR-normalized)
        const accumulatedThresholdLong = threshLong * 5 * currentOI;
        const isGrindingDown =
            longBias15m > shortBias15m * 3 &&
            longBias15m > accumulatedThresholdLong &&
            priceMoveInAtr < -0.3;

        if (isGrindingDown) {
            const isAbsorption = longBias15m > (accumulatedThresholdLong * 4) && priceMoveInAtr > -0.5;
            if (isAbsorption) {
                score = 0.6;
                tags.push('bearish_absorption_wall');
                reliability = 0.7;
            } else {
                score = Math.min(score, -0.75);
                tags.push('long_fuel_grinding_down');
                reliability = Math.max(reliability, 0.75);
            }
        }

        // Warning флаг для других модулей
        if (Math.abs(score) > 0.5) {
            features.liquidationSignal = true;
        }

        return this.createOutput(score, reliability, tags);
    }

    private calculatePercentile(values: number[], p: number): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.ceil(p * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    reset(): void {
        this.historyIntensityLong = [];
        this.historyIntensityShort = [];
        this.lastProcessedTs = 0;
    }
}