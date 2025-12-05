/**
 * Multi-Timeframe Service
 * 
 * Aggregates 1-minute candles into higher timeframes and provides
 * trend detection and S/R level analysis.
 */

import { Injectable, Inject } from '../../../shared/decorators';
import { IMultiTimeframeService } from '../interfaces';
import { IMarketDataRepository } from '../../interfaces/services.interface';
import { SmartCandle } from '../../interfaces/market-data.interface';
import { MultiTimeframeData, TimeframeCandles, TrendDirection } from '../types';

@Injectable()
export class MultiTimeframeService implements IMultiTimeframeService {

    constructor(
        @Inject('IMarketDataRepository')
        private readonly marketDataRepo: IMarketDataRepository
    ) { }

    async buildMultiTimeframeData(symbol: string): Promise<MultiTimeframeData> {
        // Get raw 1-minute candles
        const raw1m = this.marketDataRepo.getHistory(symbol, 1000);

        // Build each timeframe
        const tf1m = this.buildTimeframe(raw1m, '1m', 1);
        const tf5m = this.buildTimeframe(raw1m, '5m', 5);
        const tf15m = this.buildTimeframe(raw1m, '15m', 15);
        const tf1h = this.buildTimeframe(raw1m, '1h', 60);

        return { tf1m, tf5m, tf15m, tf1h };
    }

    /**
     * Aggregate candles and analyze.
     */
    private buildTimeframe(
        raw: SmartCandle[],
        timeframe: TimeframeCandles['timeframe'],
        periodMinutes: number
    ): TimeframeCandles {
        const candles = periodMinutes === 1
            ? raw
            : this.aggregateCandles(raw, periodMinutes);

        const trend = this.detectTrend(candles);
        const atr = this.calculateATR(candles);
        const { support, resistance } = this.findKeyLevels(candles);

        return {
            timeframe,
            candles,
            trend,
            atr,
            supportLevels: support,
            resistanceLevels: resistance,
        };
    }

    /**
     * Aggregate 1m candles into higher timeframe.
     */
    private aggregateCandles(raw: SmartCandle[], periodMinutes: number): SmartCandle[] {
        if (raw.length === 0) return [];

        const result: SmartCandle[] = [];
        const periodMs = periodMinutes * 60 * 1000;

        // Group candles by period
        let currentPeriodStart = Math.floor(raw[0].ts / periodMs) * periodMs;
        let periodCandles: SmartCandle[] = [];

        for (const candle of raw) {
            const candlePeriod = Math.floor(candle.ts / periodMs) * periodMs;

            if (candlePeriod === currentPeriodStart) {
                periodCandles.push(candle);
            } else {
                // Finalize previous period
                if (periodCandles.length > 0) {
                    result.push(this.mergeCandles(periodCandles, currentPeriodStart));
                }

                // Start new period
                currentPeriodStart = candlePeriod;
                periodCandles = [candle];
            }
        }

        // Don't forget last period
        if (periodCandles.length > 0) {
            result.push(this.mergeCandles(periodCandles, currentPeriodStart));
        }

        return result;
    }

    /**
     * Merge multiple candles into one.
     */
    private mergeCandles(candles: SmartCandle[], timestamp: number): SmartCandle {
        const first = candles[0];
        const last = candles[candles.length - 1];

        return {
            ts: timestamp,
            ohlc: {
                o: first.ohlc.o,
                h: Math.max(...candles.map(c => c.ohlc.h)),
                l: Math.min(...candles.map(c => c.ohlc.l)),
                c: last.ohlc.c,
                v: candles.reduce((sum, c) => sum + c.ohlc.v, 0),
            },
            futures: {
                oi: last.futures.oi,
                funding: last.futures.funding,
            },
            orderFlow: {
                cvd: last.orderFlow.cvd,
                delta: candles.reduce((sum, c) => sum + c.orderFlow.delta, 0),
                liquidations: {
                    long: candles.reduce((sum, c) => sum + c.orderFlow.liquidations.long, 0),
                    short: candles.reduce((sum, c) => sum + c.orderFlow.liquidations.short, 0),
                    countLong: candles.reduce((sum, c) => sum + c.orderFlow.liquidations.countLong, 0),
                    countShort: candles.reduce((sum, c) => sum + c.orderFlow.liquidations.countShort, 0),
                    maxLong: Math.max(...candles.map(c => c.orderFlow.liquidations.maxLong)),
                    maxShort: Math.max(...candles.map(c => c.orderFlow.liquidations.maxShort)),
                },
            },
        };
    }

    /**
     * Detect trend direction using Higher Highs / Lower Lows.
     */
    private detectTrend(candles: SmartCandle[]): TrendDirection {
        if (candles.length < 10) return TrendDirection.SIDEWAYS;

        // Use last 10 candles for trend detection
        const recent = candles.slice(-10);

        let higherHighs = 0;
        let lowerLows = 0;

        for (let i = 1; i < recent.length; i++) {
            if (recent[i].ohlc.h > recent[i - 1].ohlc.h) higherHighs++;
            if (recent[i].ohlc.l < recent[i - 1].ohlc.l) lowerLows++;
        }

        const totalComparisons = recent.length - 1;
        const hhRatio = higherHighs / totalComparisons;
        const llRatio = lowerLows / totalComparisons;

        // Clear uptrend: many HH, few LL
        if (hhRatio > 0.6 && llRatio < 0.4) return TrendDirection.UP;

        // Clear downtrend: many LL, few HH
        if (llRatio > 0.6 && hhRatio < 0.4) return TrendDirection.DOWN;

        return TrendDirection.SIDEWAYS;
    }

    /**
     * Calculate Average True Range.
     */
    private calculateATR(candles: SmartCandle[], period: number = 14): number {
        if (candles.length < period + 1) {
            // Fallback: use simple high-low range
            if (candles.length === 0) return 0;
            return candles.slice(-5).reduce((sum, c) => sum + (c.ohlc.h - c.ohlc.l), 0) / 5;
        }

        const trueRanges: number[] = [];

        for (let i = 1; i < candles.length; i++) {
            const current = candles[i];
            const previous = candles[i - 1];

            const tr = Math.max(
                current.ohlc.h - current.ohlc.l,
                Math.abs(current.ohlc.h - previous.ohlc.c),
                Math.abs(current.ohlc.l - previous.ohlc.c)
            );

            trueRanges.push(tr);
        }

        // Simple Moving Average of TR for initial period
        const recentTRs = trueRanges.slice(-period);
        return recentTRs.reduce((sum, tr) => sum + tr, 0) / recentTRs.length;
    }

    /**
     * Find key support and resistance levels using swing points.
     */
    private findKeyLevels(candles: SmartCandle[]): { support: number[]; resistance: number[] } {
        const support: number[] = [];
        const resistance: number[] = [];

        if (candles.length < 5) return { support, resistance };

        // Find swing highs and lows (using 2-candle lookback/lookahead)
        for (let i = 2; i < candles.length - 2; i++) {
            const current = candles[i];
            const leftHigh = Math.max(candles[i - 1].ohlc.h, candles[i - 2].ohlc.h);
            const rightHigh = Math.max(candles[i + 1].ohlc.h, candles[i + 2].ohlc.h);
            const leftLow = Math.min(candles[i - 1].ohlc.l, candles[i - 2].ohlc.l);
            const rightLow = Math.min(candles[i + 1].ohlc.l, candles[i + 2].ohlc.l);

            // Swing high = resistance
            if (current.ohlc.h > leftHigh && current.ohlc.h > rightHigh) {
                resistance.push(current.ohlc.h);
            }

            // Swing low = support  
            if (current.ohlc.l < leftLow && current.ohlc.l < rightLow) {
                support.push(current.ohlc.l);
            }
        }

        // Keep only unique levels (within 0.5% tolerance)
        return {
            support: this.deduplicateLevels(support).slice(-5), // Keep 5 most recent
            resistance: this.deduplicateLevels(resistance).slice(-5),
        };
    }

    /**
     * Remove duplicate levels that are too close to each other.
     */
    private deduplicateLevels(levels: number[]): number[] {
        if (levels.length === 0) return [];

        const sorted = [...levels].sort((a, b) => a - b);
        const result: number[] = [sorted[0]];

        for (let i = 1; i < sorted.length; i++) {
            const prev = result[result.length - 1];
            const current = sorted[i];

            // If more than 0.5% apart, keep it
            if ((current - prev) / prev > 0.005) {
                result.push(current);
            }
        }

        return result;
    }
}
