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

    computeFeatures(bars: (BarData | AggregatedBar)[]): Features {
        if (bars.length < 2) {
            return this.emptyFeatures();
        }

        const current = bars[bars.length - 1];
        const prev = bars[bars.length - 2];

        // идемпотентное обновление статистик
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

        const pChange30m = this.computeTwentyMinChange(bars)

        if (pChange30m >= 0.08) {
            // console.log(pChange30m)
        }

        const { isLiqSignal, liqBias, liqStrength } = this.analyzeLiquidations(current, current.oi || 1);
        const { isAbsorption, absorptionBias } = this.analyzeAbsorption(current, deltaZ, volZ);

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
            pChange30m
        };
    }

    private computeTwentyMinChange(bars: (BarData | AggregatedBar)[], interval: number = 30): number {
        const current = bars[bars.length - 1];
        const isUp = current.c >= current.o;

        const currentBase = isUp ? current.o : current.c;

        const targetTs = current.ts - interval * 60 * 1000; // ts в миллисекундах
        const pastBar = [...bars].reverse().find(b => b.ts <= targetTs);

        if (!pastBar) return 0;

        const pastBase = isUp ? pastBar.o : pastBar.c;

        return safeDivide(currentBase - pastBase, pastBase);
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

        // стабильный порог: используем перцентиль и минимальный пол
        const baseThreshold = this.liqStats.size() > 20
            ? this.liqStats.percentile(0.95)
            : currentOI * 0.001;
        const threshold = Math.max(baseThreshold, 1); // не позволяем порогу быть слишком маленьким

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

        // Поглощение покупателей (бычья абсорбция)
        if (deltaZ < -Z_THRESH && closePos > 0.4 && volZ > 0.7 && lowerWickRatio > 0.25 && bodyRatio < 0.6) {
            return { isAbsorption: true, absorptionBias: 1 };
        }

        // Поглощение продавцов (медвежья абсорбция)
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
            pChange30m: 0
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
