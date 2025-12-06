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

    // Rolling stats
    private volStats: RollingStats;
    private deltaStats: RollingStats;
    private oiStats: RollingStats;
    private liqStats: RollingStats; // Добавил статистику именно для ликвидаций

    // State protection
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

        // 1. STATE MANAGEMENT (Critical Fix)
        // Обновляем статистику ТОЛЬКО если бар закрылся (пришел новый времени)
        if (current.ts > this.lastProcessedTime) {
            // Важно: в статистику пишем ПРЕДЫДУЩИЙ (завершенный) бар,
            // либо текущий, но только один раз.
            // Обычно безопаснее писать prev, когда появился current.
            if (this.lastProcessedTime !== 0) {
                this.updateRollingStats(prev);
            }
            this.lastProcessedTime = current.ts;
        }

        // 2. BASIC CALCULATIONS
        const buyVol = (current.v + current.delta) / 2;
        const sellVol = (current.v - current.delta) / 2;
        const flowImb = safeDivide(current.delta, Math.max(current.v, EPS));

        // Z-scores (считаем относительно уже накопленной истории)
        const volZ = this.volStats.zscore(current.v);
        const deltaZ = this.deltaStats.zscore(current.delta);

        // Deltas
        const dCVD = this.computeDelta(bars, 'cvd', this.lookbacks.dCVD);
        const dOI = this.computeDelta(bars, 'oi', this.lookbacks.dOI);

        const oiMean = this.oiStats.mean();
        const oiFlow = safeDivide(dOI, Math.max(oiMean, EPS));

        // Price Features
        const priceReturn = safeDivide(current.c - current.o, current.o);

        // Gap: (Last - SMA) / SMA (более надежно, чем от закрытия)
        // Или (Last - PreviousClose) / PreviousClose
        const lastPriceGap = safeDivide(current.lastPrice - prev.c, prev.c);

        // Technicals
        const closes = bars.map(b => b.c);
        const highs = bars.map(b => b.h);
        const lows = bars.map(b => b.l);

        const atr = calculateATR(highs, lows, closes, this.technical.atrPeriod);
        const emaFast = calculateEMA(closes, this.technical.emaFastPeriod);
        const emaSlow = calculateEMA(closes, this.technical.emaSlowPeriod);

        // 3. ADVANCED LOGIC (Bias Calculation)

        // Liquidation Analysis
        const { isLiqSignal, liqBias } = this.analyzeLiquidations(current, current.oi || 1);

        // Absorption Analysis
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

            // New Fields
            liquidationSignal: isLiqSignal,
            liquidationBias: liqBias, // 1 (Squeeze), -1 (Cascade)

            absorptionFlag: isAbsorption,
            absorptionBias: absorptionBias // 1 (Bid Wall), -1 (Ask Wall)
        };
    }

    private updateRollingStats(bar: BarData | AggregatedBar): void {
        this.volStats.push(bar.v);
        this.deltaStats.push(bar.delta);
        this.oiStats.push(bar.oi);

        // Пишем сумму ликвидаций в статистику
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

    /**
     * Analyze Liquidations with Direction
     */
    private analyzeLiquidations(bar: BarData | AggregatedBar, currentOI: number): { isLiqSignal: boolean, liqBias: number } {
        const l = bar.liquidations || { long: 0, short: 0 };
        const totalLiq = l.long + l.short;

        // Если истории мало, считаем сигналом ликвидации > 0.1% от OI
        const threshold = this.liqStats.size() > 20
            ? this.liqStats.percentile(0.95)
            : currentOI * 0.001;

        if (totalLiq < threshold) {
            return { isLiqSignal: false, liqBias: 0 };
        }

        // Определяем направление
        // Много лонгов умерло -> Cascade (Цена падает) -> Bias -1 (Bearish env)
        // Много шортов умерло -> Squeeze (Цена растет) -> Bias 1 (Bullish env)
        let bias = 0;
        if (l.long > l.short * 1.5) bias = -1;
        else if (l.short > l.long * 1.5) bias = 1;

        return { isLiqSignal: true, liqBias: bias };
    }

    /**
     * Detect Absorption with Direction
     * Logic: Aggressive Delta vs Price Movement
     */
    private analyzeAbsorption(bar: BarData | AggregatedBar, deltaZ: number): { isAbsorption: boolean, absorptionBias: number } {
        const range = bar.h - bar.l;
        if (range < EPS) return { isAbsorption: false, absorptionBias: 0 };

        // Где закрылась свеча (0 = Low, 1 = High)
        const closePos = (bar.c - bar.l) / range;

        // Z-Score порог для "сильной дельты"
        const Z_THRESH = 1.5;

        // 1. Bid Absorption (Стена покупателя)
        // Агрессивные продажи (Negative Delta), но цена не падает (закрылась высоко)
        // Или просто огромная продажа в узком диапазоне
        if (deltaZ < -Z_THRESH && closePos > 0.4) {
            return { isAbsorption: true, absorptionBias: 1 }; // Поддержка
        }

        // 2. Ask Absorption (Стена продавца)
        // Агрессивные покупки (Positive Delta), но цена не растет (закрылась низко)
        if (deltaZ > Z_THRESH && closePos < 0.6) {
            return { isAbsorption: true, absorptionBias: -1 }; // Сопротивление
        }

        return { isAbsorption: false, absorptionBias: 0 };
    }

    private emptyFeatures(): Features {
        // ... (возврат нулей, как в твоем коде)
        return {
            buyVol: 0, sellVol: 0, flowImb: 0, volZ: 0, deltaZ: 0,
            dCVD: 0, dOI: 0, oiFlow: 0, priceReturn: 0, lastPriceGap: 0,
            atr: 0, emaFast: 0, emaSlow: 0,
            liquidationSignal: false,
            liquidationBias: 0,
            absorptionFlag: false,
            absorptionBias: 0
        };
    }

    // Метод для внешнего сброса при рестарте
    reset(): void {
        this.volStats.reset();
        this.deltaStats.reset();
        this.oiStats.reset();
        this.liqStats.reset();
        this.lastProcessedTime = 0;
    }
}