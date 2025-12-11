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

        if (current.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.updateRollingStats(prev);
            }
            this.lastProcessedTime = current.ts;
        }

        const buyVol = (current.v + current.delta) / 2;
        const sellVol = (current.v - current.delta) / 2;
        const flowImb = safeDivide(current.delta, Math.max(current.v, EPS));
        
        const volZ = this.volStats.zscore(current.v);
        const deltaZ = this.deltaStats.zscore(current.delta);

        const dCVD = this.computeDelta(bars, 'cvd', this.lookbacks.dCVD);
        const dOI = this.computeDelta(bars, 'oi', this.lookbacks.dOI);

        const oiMean = this.oiStats.mean();
        const oiFlow = safeDivide(dOI, Math.max(oiMean, EPS));

        const priceReturn = safeDivide(current.c - current.o, current.o);
        const lastPriceGap = safeDivide(current.lastPrice - prev.c, prev.c);

        const closes = bars.map(b => b.c);
        const highs = bars.map(b => b.h);
        const lows = bars.map(b => b.l);

        const atr = calculateATR(highs, lows, closes, this.technical.atrPeriod);
        const emaFast = calculateEMA(closes, this.technical.emaFastPeriod);
        const emaSlow = calculateEMA(closes, this.technical.emaSlowPeriod);

        // 🔥 НОВЫЙ РАСЧЕТ: Глобальный тренд (EMA 200 на 1м)
        const trendEma = calculateEMA(closes, 200);

        const { isLiqSignal, liqBias } = this.analyzeLiquidations(current, current.oi || 1);
        const { isAbsorption, absorptionBias } = this.analyzeAbsorption(current, deltaZ);

        return {
            buyVol,
            sellVol,
            flowImb: clamp(flowImb, -1, 1),
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
            
            trendEma, // <--- ВОЗВРАЩАЕМ ТРЕНД

            liquidationSignal: isLiqSignal,
            liquidationBias: liqBias,
            absorptionFlag: isAbsorption,
            absorptionBias: absorptionBias
        };
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

    private analyzeLiquidations(bar: BarData | AggregatedBar, currentOI: number): { isLiqSignal: boolean, liqBias: number } {
        const l = bar.liquidations || { long: 0, short: 0 };
        const totalLiq = l.long + l.short;
        const threshold = this.liqStats.size() > 20
            ? this.liqStats.percentile(0.95)
            : currentOI * 0.001;

        if (totalLiq < threshold) {
            return { isLiqSignal: false, liqBias: 0 };
        }

        let bias = 0;
        if (l.long > l.short * 1.5) bias = -1;
        else if (l.short > l.long * 1.5) bias = 1;

        return { isLiqSignal: true, liqBias: bias };
    }

    private analyzeAbsorption(bar: BarData | AggregatedBar, deltaZ: number): { isAbsorption: boolean, absorptionBias: number } {
        const range = bar.h - bar.l;
        if (range < EPS) return { isAbsorption: false, absorptionBias: 0 };
        
        const closePos = (bar.c - bar.l) / range;
        const Z_THRESH = 1.5;

        if (deltaZ < -Z_THRESH && closePos > 0.4) {
            return { isAbsorption: true, absorptionBias: 1 };
        }

        if (deltaZ > Z_THRESH && closePos < 0.6) {
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
            absorptionBias: 0
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