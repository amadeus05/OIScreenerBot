/**
 * Signal Analyzer Adapter
 * Converts SmartCandle from MarketDataRepository to BarData for SignalAnalyzer
 */

import { SmartCandle } from '../../../domain/interfaces/market-data.interface';
import { BarData } from '../types';

/**
 * Convert SmartCandle to BarData format
 */
export function smartCandleToBarData(candle: SmartCandle, symbol: string): BarData {
    return {
        symbol,
        ts: candle.ts,

        // OHLCV
        o: candle.ohlc.o,
        h: candle.ohlc.h,
        l: candle.ohlc.l,
        c: candle.ohlc.c,
        v: candle.ohlc.v,

        // Indicators
        delta: candle.orderFlow.delta,
        cvd: candle.orderFlow.cvd,
        oi: candle.futures.oi,
        funding: candle.futures.funding,
        lastPrice: candle.ohlc.c, // Use close as last price

        // Liquidations
        liquidations: {
            long: candle.orderFlow.liquidations.long,
            short: candle.orderFlow.liquidations.short,
            countLong: candle.orderFlow.liquidations.countLong,
            countShort: candle.orderFlow.liquidations.countShort,
            maxLong: candle.orderFlow.liquidations.maxLong,
            maxShort: candle.orderFlow.liquidations.maxShort,
        },
    };
}

/**
 * Convert array of SmartCandles to BarData
 */
export function smartCandlesToBarData(candles: SmartCandle[], symbol: string): BarData[] {
    return candles.map(candle => smartCandleToBarData(candle, symbol));
}
