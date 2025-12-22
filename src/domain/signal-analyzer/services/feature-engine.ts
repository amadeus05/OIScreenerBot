// ========================================================================
// FILE: src/domain/signal-analyzer/services/feature-engine.ts
// ========================================================================

import { BarData, Features, AggregatedBar } from '../types';
import { DEFAULT_CONFIG, LookbackConfig, TechnicalConfig } from '../types/config';
import {
    RollingStats,
    calculateEMA,
    calculateATR,
    safeDivide,
    clamp,
} from '../utils/rolling-stats';

const EPS = 1e-10;
const TREND_EMA_PERIOD = 200;

export class FeatureEngine {
    private readonly lookbacks: LookbackConfig;
    private readonly technical: TechnicalConfig;

    private volStats: RollingStats;
    private deltaStats: RollingStats;
    private oiStats: RollingStats;
    private liqStats: RollingStats;

    private lastProcessedTime = 0;

    constructor(config = DEFAULT_CONFIG) {
        this.lookbacks = config.lookbacks;
        this.technical = config.technical;

        this.volStats = new RollingStats(this.lookbacks.volZ);
        this.deltaStats = new RollingStats(this.lookbacks.deltaZ);
        this.oiStats = new RollingStats(this.lookbacks.oiMean);
        this.liqStats = new RollingStats(100);
    }

    /**
     * 🔥 UPDATED: Метод для принудительной загрузки истории (Cold Start Fix)
     * Прогоняет исторические бары через статистику, чтобы Z-Score был готов сразу.
     */
    public hydrate(bars: (BarData | AggregatedBar)[]): void {
        this.reset();
        
        if (bars.length < 2) return;

        // Гарантируем хронологический порядок
        const sorted = [...bars].sort((a, b) => a.ts - b.ts);

        // Прогоняем через updateRollingStats
        // Это заполнит окна (window) значениями, и z-score будет считаться корректно
        for (const bar of sorted) {
            this.updateRollingStats(bar);
            this.lastProcessedTime = bar.ts;
        }
    }

    computeFeatures(bars: (BarData | AggregatedBar)[]): Features {
        if (bars.length < 2) {
            return this.emptyFeatures();
        }

        const current = bars[bars.length - 1];
        const prev = bars[bars.length - 2];

        // Идемпотентное обновление статистик для Live режима
        if (current.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.updateRollingStats(prev);
            }
            this.lastProcessedTime = current.ts;
        }

        // --- Volume & Flow ---
        const buyVol = clamp((current.v + current.delta) / 2, 0, current.v);
        const sellVol = clamp((current.v - current.delta) / 2, 0, current.v);
        const flowImb = clamp(safeDivide(current.delta, Math.max(current.v, EPS)), -0.5, 0.5);

        const volZ = this.volStats.zscore(current.v);
        const deltaZ = this.deltaStats.zscore(current.delta);

        const dCVD = this.computeDelta(bars, 'cvd', this.lookbacks.dCVD);
        const dOI = this.computeDelta(bars, 'oi', this.lookbacks.dOI);

        const oiMean = this.oiStats.mean();
        const oiFlowRaw = safeDivide(dOI, Math.max(oiMean, EPS));
        const oiFlow = clamp(oiFlowRaw, -2.0, 2.0); // стабилизация всплесков

        const priceReturn = safeDivide(current.c - current.o, current.o);
        const lastPriceGap = safeDivide((current.lastPrice || current.c) - prev.c, prev.c);

        const closes = bars.map(b => b.c);
        const highs = bars.map(b => b.h);
        const lows = bars.map(b => b.l);

        const atr = calculateATR(highs, lows, closes, this.technical.atrPeriod);
        const emaFast = calculateEMA(closes, this.technical.emaFastPeriod);
        const emaSlow = calculateEMA(closes, this.technical.emaSlowPeriod);

        // --- Trend EMA (гибкий период из конфига) ---
        const trendEma = calculateEMA(closes, TREND_EMA_PERIOD || 200);

        const pChange30m = this.computeTwentyMinChange(bars);
        const pChangeUpTo30m = this.computeFlexibleChangeUpTo(bars);

        const { isLiqSignal, liqBias, liqStrength } = this.analyzeLiquidations(current, current.oi || 1);
        const { isAbsorption, absorptionBias } = this.analyzeAbsorption(current, deltaZ, volZ);


        let sumVol30 = 0;
        let sumDelta30 = 0;
        const lookback30 = Math.min(bars.length, 30);
        
        for (let i = 0; i < lookback30; i++) {
            const b = bars[bars.length - 1 - i];
            
            // 🔴 ОШИБКА БЫЛА ЗДЕСЬ: sumVol30 += b.v; 
            // Мы должны привести объем к долларам, так как дельта в долларах!
            
            // 🟢 ИСПРАВЛЕНИЕ: Умножаем объем на цену закрытия
            sumVol30 += (b.v * b.c); 
            
            sumDelta30 += b.delta;
        }
        
        const cvdDominance30m = safeDivide(sumDelta30, Math.max(sumVol30, EPS));

        return {
            buyVol,
            sellVol,
            flowImb,
            volZ,
            deltaZ,
            dCVD,
            dOI,
            oiFlow,
            priceReturn,
            lastPriceGap,
            atr,
            emaFast,
            emaSlow,
            trendEma,
            liquidationSignal: isLiqSignal,
            liquidationBias: liqBias,
            absorptionFlag: isAbsorption,
            absorptionBias,
            pChange30m,
            pChangeUpTo30m,
            cvdDominance30m,
        };
    }

    private computeTwentyMinChange(bars: (BarData | AggregatedBar)[], interval: number = 30): number {
        const current = bars[bars.length - 1];
        // Для точного расчета берем Open, если свеча зеленая, иначе Close (консервативно)
        // Или просто Close для простоты. Оставим текущую логику.
        const isUp = current.c >= current.o;
        const currentBase = isUp ? current.o : current.c;

        const targetTs = current.ts - interval * 60 * 1000;
        // Ищем бар, который был 30 минут назад (или ближайший к нему)
        // Reverse поиск быстрее, так как ищем с конца
        const pastBar = [...bars].reverse().find(b => b.ts <= targetTs);

        if (!pastBar) return 0;

        const pastBase = isUp ? pastBar.o : pastBar.c; // Сравниваем сравнимое

        return safeDivide(currentBase - pastBase, pastBase);
    }

    /**
     * Максимальное ценовое движение за любое окно до 30 минут (текущее время - любое время внутри окна).
     * Стартовая точка — текущая цена. Для каждой пред. свечи используем только O/C:
     * - если свеча полностью ниже текущей — берем ее минимальное (между O и C)
     * - если полностью выше — берем максимальное (между O и C)
     * - если текущая цена внутри тела — игнорируем (движение ~0)
     */
    private computeFlexibleChangeUpTo(bars: (BarData | AggregatedBar)[], interval: number = 30): number {
        if (bars.length < 2) return 0;

        const current = bars[bars.length - 1];
        const currentPrice = current.c;
        const cutoffTs = current.ts - interval * 60 * 1000;

        let bestChange = 0;

        for (let i = bars.length - 2; i >= 0; i--) {
            const bar = bars[i];
            if (bar.ts < cutoffTs) break;

            const bodyLow = Math.min(bar.o, bar.c);
            const bodyHigh = Math.max(bar.o, bar.c);

            let anchor = currentPrice;

            if (currentPrice > bodyHigh) {
                // Предыдущая свеча полностью ниже текущей цены — берем нижнюю точку тела.
                anchor = bodyLow;
            } else if (currentPrice < bodyLow) {
                // Предыдущая свеча полностью выше — берем верхнюю точку тела.
                anchor = bodyHigh;
            } else {
                // Текущая цена внутри тела — такое движение считаем шумом.
                continue;
            }

            const change = safeDivide(currentPrice - anchor, anchor);
            if (Math.abs(change) > Math.abs(bestChange)) {
                bestChange = change;
            }
        }

        return bestChange;
    }

    private updateRollingStats(bar: BarData | AggregatedBar): void {
        this.volStats.push(bar.v);
        this.deltaStats.push(bar.delta);
        this.oiStats.push(bar.oi);
        const totalLiq = (bar.liquidations?.long || 0) + (bar.liquidations?.short || 0);
        this.liqStats.push(totalLiq);
    }

    private computeDelta(
        bars: (BarData | AggregatedBar)[],
        field: 'cvd' | 'oi',
        shift: number
    ): number {
        if (bars.length <= shift) return 0;
        const currentVal = bars[bars.length - 1][field];
        const prevVal = bars[bars.length - 1 - shift][field];
        return currentVal - prevVal;
    }

    private analyzeLiquidations(bar: BarData | AggregatedBar, currentOI: number): { isLiqSignal: boolean, liqBias: number, liqStrength: number } {
        const l = bar.liquidations || { long: 0, short: 0 };
        const totalLiq = l.long + l.short;

        const baseThreshold = this.liqStats.size() > 20
            ? this.liqStats.percentile(0.95)
            : currentOI * 0.001;
        const threshold = Math.max(baseThreshold, 1);

        if (totalLiq < threshold) {
            return { isLiqSignal: false, liqBias: 0, liqStrength: 0 };
        }

        let bias = 0;
        if (l.long > l.short * 1.5) bias = -1;
        else if (l.short > l.long * 1.5) bias = 1;

        const strength = safeDivide(totalLiq, threshold);

        return { isLiqSignal: true, liqBias: bias, liqStrength: strength };
    }

    private analyzeAbsorption(bar: BarData | AggregatedBar, deltaZ: number, volZ: number): { isAbsorption: boolean, absorptionBias: number } {
        const range = bar.h - bar.l;
        if (range < EPS) return { isAbsorption: false, absorptionBias: 0 };

        const closePos = (bar.c - bar.l) / range;
        const bodyRatio = Math.abs(bar.c - bar.o) / (range + EPS);
        const upperWick = bar.h - Math.max(bar.c, bar.o);
        const lowerWick = Math.min(bar.c, bar.o) - bar.l;
        const upperWickRatio = upperWick / (range + EPS);
        const lowerWickRatio = lowerWick / (range + EPS);

        const Z_THRESH = 1.2;

        if (deltaZ < -Z_THRESH && closePos > 0.4 && volZ > 0.7 && lowerWickRatio > 0.25 && bodyRatio < 0.6) {
            return { isAbsorption: true, absorptionBias: 1 };
        }

        if (deltaZ > Z_THRESH && closePos < 0.6 && volZ > 0.7 && upperWickRatio > 0.25 && bodyRatio < 0.6) {
            return { isAbsorption: true, absorptionBias: -1 };
        }

        return { isAbsorption: false, absorptionBias: 0 };
    }

    private emptyFeatures(): Features {
        return {
            buyVol: 0, sellVol: 0, flowImb: 0, volZ: 0, deltaZ: 0,
            dCVD: 0, dOI: 0, oiFlow: 0, priceReturn: 0, lastPriceGap: 0,
            atr: 0, emaFast: 0, emaSlow: 0,
            trendEma: 0,
            liquidationSignal: false,
            liquidationBias: 0,
            absorptionFlag: false,
            absorptionBias: 0,
            pChange30m: 0,
            pChangeUpTo30m: 0,
            cvdDominance30m: 0,
        };
    }

    reset(): void {
        this.volStats.reset();
        this.deltaStats.reset();
        this.oiStats.reset();
        this.liqStats.reset();
        this.lastProcessedTime = 0;
    }
}