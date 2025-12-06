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

    /**
     * Add a new 1m bar and update aggregations
     * Assumes bar.ts is the OPEN time of the candle
     */
    addBar(bar: BarData): void {
        // Проверяем дубликаты (на всякий случай)
        const lastBar = this.bars1m[this.bars1m.length - 1];
        if (lastBar && lastBar.ts === bar.ts) {
            this.bars1m[this.bars1m.length - 1] = bar; // Update existing
        } else {
            this.bars1m.push(bar);
        }

        this.trimBars(this.bars1m);

        // Пытаемся закрыть периоды
        // Передаем текущий бар, чтобы проверить, является ли он последним в блоке
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

    // ... (getters for specific arrays remain same)

    /**
     * Check if the added bar concludes a timeframe period
     */
    private checkAndAggregate(tf: Timeframe, currentBar: BarData): void {
        const minutes = TIMEFRAME_MINUTES[tf];
        const periodMs = minutes * 60 * 1000;

        // Логика: Если (TS + 1 мин) кратно периоду, значит текущий бар - последний в периоде.
        // Пример для 5m: 
        // Bar 12:04. Next is 12:05. 12:05 % 5 == 0. -> ЭТО КОНЕЦ СВЕЧИ 12:00
        const nextMinuteTs = currentBar.ts + 60000;

        if (nextMinuteTs % periodMs === 0) {
            const periodStart = nextMinuteTs - periodMs;
            this.aggregate(tf, periodStart, currentBar.ts);
        }
    }

    /**
     * Aggregate bars within a specific time range
     */
    private aggregate(tf: Timeframe, startTime: number, endTime: number): void {
        // Фильтруем строго по диапазону [Start, End]
        // Это защищает от смешивания баров при пропусках данных
        const sourceBars = this.bars1m.filter(b => b.ts >= startTime && b.ts <= endTime);

        if (sourceBars.length === 0) return;

        // Если баров слишком мало (например, < 50% от нормы), можно либо пропускать, 
        // либо создавать "дырявую" свечу. Здесь создаем, что есть.

        const first = sourceBars[0];
        const last = sourceBars[sourceBars.length - 1];
        const minutes = TIMEFRAME_MINUTES[tf];

        const aggregated: AggregatedBar = {
            symbol: first.symbol,
            ts: startTime, // ВАЖНО: TS всегда строго по сетке (12:00, 12:05), даже если первый бар был 12:01
            timeframe: tf,
            barCount: sourceBars.length, // Полезно для дебага качества данных

            // OHLCV
            o: first.o, // Open первого доступного бара
            h: Math.max(...sourceBars.map(b => b.h)),
            l: Math.min(...sourceBars.map(b => b.l)),
            c: last.c,  // Close последнего доступного бара
            v: sourceBars.reduce((sum, b) => sum + b.v, 0),

            // Indicators
            delta: sourceBars.reduce((sum, b) => sum + b.delta, 0),
            cvd: last.cvd, // CVD кумулятивный, берем последний
            oi: last.oi,   // OI - snapshot, берем последний
            funding: last.funding,
            lastPrice: last.lastPrice,

            // Liquidations
            liquidations: {
                long: sourceBars.reduce((sum, b) => sum + b.liquidations.long, 0),
                short: sourceBars.reduce((sum, b) => sum + b.liquidations.short, 0),
                countLong: sourceBars.reduce((sum, b) => sum + b.liquidations.countLong, 0),
                countShort: sourceBars.reduce((sum, b) => sum + b.liquidations.countShort, 0),
                // Max of Maxes - корректно
                maxLong: Math.max(...sourceBars.map(b => b.liquidations.maxLong)),
                maxShort: Math.max(...sourceBars.map(b => b.liquidations.maxShort)),
            },
        };

        // Сохраняем
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
            // Удаляем старые, оставляем новые (slice(len - max)) - более производительно чем splice(0, diff) для больших массивов,
            // но splice работает in-place, что для const массива важно.
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