// ========================================================================
// FILE: src/domain/signal-analyzer/services/timeframe-aggregator.ts
// ========================================================================

import { BarData, AggregatedBar, Timeframe } from '../types';

const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
};

export class TimeframeAggregator {
    private bars1m: BarData[] = [];
    private bars5m: AggregatedBar[] = [];
    private bars15m: AggregatedBar[] = [];

    private readonly maxBars: number;

    constructor(maxBarsToStore: number = 500) {
        this.maxBars = maxBarsToStore;
    }

    addBar(bar: BarData): void {
        const lastBar = this.bars1m[this.bars1m.length - 1];
        if (lastBar && lastBar.ts === bar.ts) {
            this.bars1m[this.bars1m.length - 1] = bar; 
        } else {
            this.bars1m.push(bar);
        }

        this.trimBars(this.bars1m);

        this.checkAndAggregate('5m', bar);
        this.checkAndAggregate('15m', bar);
    }

    getBars(timeframe: Timeframe, count?: number): (BarData | AggregatedBar)[] {
        let bars: (BarData | AggregatedBar)[];
        switch (timeframe) {
            case '1m': bars = this.bars1m; break;
            case '5m': bars = this.bars5m; break;
            case '15m': bars = this.bars15m; break;
            default: bars = this.bars1m;
        }
        return count ? bars.slice(-count) : bars;
    }

    /**
     * 🔥 UPDATED: Метод для получения времени последней свечи.
     * Нужен для оптимизации подачи данных в analyze.
     */
    getLastTs(): number {
        if (this.bars1m.length === 0) return 0;
        return this.bars1m[this.bars1m.length - 1].ts;
    }

    private checkAndAggregate(tf: Timeframe, currentBar: BarData): void {
        const minutes = TIMEFRAME_MINUTES[tf];
        const periodMs = minutes * 60 * 1000;
        const nextMinuteTs = currentBar.ts + 60000;

        if (nextMinuteTs % periodMs === 0) {
            const periodStart = nextMinuteTs - periodMs;
            this.aggregate(tf, periodStart, currentBar.ts);
        }
    }

    private aggregate(tf: Timeframe, startTime: number, endTime: number): void {
        const sourceBars = this.bars1m.filter(b => b.ts >= startTime && b.ts <= endTime);
        if (sourceBars.length === 0) return;

        const first = sourceBars[0];
        const last = sourceBars[sourceBars.length - 1];

        const aggregated: AggregatedBar = {
            symbol: first.symbol,
            ts: startTime,
            timeframe: tf,
            barCount: sourceBars.length,
            o: first.o,
            h: Math.max(...sourceBars.map(b => b.h)),
            l: Math.min(...sourceBars.map(b => b.l)),
            c: last.c,
            v: sourceBars.reduce((sum, b) => sum + b.v, 0),
            delta: sourceBars.reduce((sum, b) => sum + b.delta, 0),
            cvd: last.cvd,
            oi: last.oi,
            funding: last.funding,
            lastPrice: last.lastPrice,
            liquidations: {
                long: sourceBars.reduce((sum, b) => sum + b.liquidations.long, 0),
                short: sourceBars.reduce((sum, b) => sum + b.liquidations.short, 0),
                countLong: sourceBars.reduce((sum, b) => sum + b.liquidations.countLong, 0),
                countShort: sourceBars.reduce((sum, b) => sum + b.liquidations.countShort, 0),
                maxLong: Math.max(...sourceBars.map(b => b.liquidations.maxLong)),
                maxShort: Math.max(...sourceBars.map(b => b.liquidations.maxShort)),
            },
        };

        if (tf === '5m') {
            this.bars5m.push(aggregated);
            this.trimBars(this.bars5m);
        } else if (tf === '15m') {
            this.bars15m.push(aggregated);
            this.trimBars(this.bars15m);
        }
    }

    private trimBars<T>(bars: T[]): void {
        if (bars.length > this.maxBars) {
            bars.splice(0, bars.length - this.maxBars);
        }
    }

    getBarCounts(): { bars1m: number; bars5m: number; bars15m: number } {
        return {
            bars1m: this.bars1m.length,
            bars5m: this.bars5m.length,
            bars15m: this.bars15m.length,
        };
    }

    reset(): void {
        this.bars1m = [];
        this.bars5m = [];
        this.bars15m = [];
    }
}