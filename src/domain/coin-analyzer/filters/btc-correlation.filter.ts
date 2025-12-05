/**
 * BTC Correlation Filter
 * 
 * Checks correlation with BTC to avoid trading against the market leader.
 * If BTC is moving strongly in one direction, altcoins typically follow.
 */

import { BaseFilter } from './base.filter';
import { AnalysisContext, FilterResult } from '../types';

export class BTCCorrelationFilter extends BaseFilter {
    readonly name = 'BTCCorrelationFilter';
    readonly defaultWeight = 1.0;

    // Configuration
    private readonly STRONG_BTC_MOVE_PERCENT = 1.0; // 1% move is significant
    private readonly DIVERGENCE_PENALTY = 0.5;       // Penalty for moving against BTC

    async analyze(context: AnalysisContext): Promise<FilterResult> {
        const btcChange = context.btcData.priceChange1h;
        const symbolChange = this.calculateSymbolChange1h(context);

        const absBtcChange = Math.abs(btcChange);
        const isBtcMovingStrong = absBtcChange >= this.STRONG_BTC_MOVE_PERCENT;

        // Check if symbol is diverging from BTC
        const isSameDirection = (btcChange >= 0) === (symbolChange >= 0);
        const isDiverging = isBtcMovingStrong && !isSameDirection;

        // Calculate correlation coefficient (simplified)
        const correlation = this.calculateCorrelation(context);

        if (isDiverging) {
            return this.fail(
                -this.DIVERGENCE_PENALTY,
                0.8,
                `Diverging from BTC: BTC ${btcChange > 0 ? '+' : ''}${btcChange.toFixed(2)}%, ${context.symbol} ${symbolChange > 0 ? '+' : ''}${symbolChange.toFixed(2)}%`,
                {
                    btcChange1h: btcChange,
                    symbolChange1h: symbolChange,
                    correlation,
                }
            );
        }

        // BTC not moving strongly OR moving together
        let score = 0.5;
        let confidence = 0.6;
        let reason: string;

        if (!isBtcMovingStrong) {
            reason = `BTC stable (${btcChange > 0 ? '+' : ''}${btcChange.toFixed(2)}%), safe to trade`;
            score = 0.6;
        } else {
            // Moving together with BTC
            reason = `Aligned with BTC: both ${btcChange > 0 ? 'up' : 'down'}`;
            score = 0.8;
            confidence = 0.8;
        }

        // Bonus for high positive correlation
        if (correlation > 0.7) {
            score += 0.1;
        }

        return this.pass(score, confidence, reason, {
            btcChange1h: btcChange,
            symbolChange1h: symbolChange,
            correlation,
            aligned: isSameDirection.toString(),
        });
    }

    /**
     * Calculate 1h price change for the symbol.
     */
    private calculateSymbolChange1h(context: AnalysisContext): number {
        const candles = context.rawCandles;
        if (candles.length < 60) return 0;

        const hourAgoIndex = Math.max(0, candles.length - 60);
        const hourAgoPrice = candles[hourAgoIndex].ohlc.c;
        const currentPrice = context.currentPrice;

        return ((currentPrice - hourAgoPrice) / hourAgoPrice) * 100;
    }

    /**
     * Calculate Pearson correlation coefficient between symbol and BTC.
     */
    private calculateCorrelation(context: AnalysisContext): number {
        const symbolCandles = context.rawCandles.slice(-60); // Last hour
        const btcCandles = context.btcData.candles.slice(-60);

        if (symbolCandles.length < 30 || btcCandles.length < 30) return 0;

        // Use the minimum length
        const len = Math.min(symbolCandles.length, btcCandles.length);

        // Calculate returns
        const symbolReturns: number[] = [];
        const btcReturns: number[] = [];

        for (let i = 1; i < len; i++) {
            const symbolReturn = (symbolCandles[i].ohlc.c - symbolCandles[i - 1].ohlc.c) / symbolCandles[i - 1].ohlc.c;
            const btcReturn = (btcCandles[i].ohlc.c - btcCandles[i - 1].ohlc.c) / btcCandles[i - 1].ohlc.c;

            symbolReturns.push(symbolReturn);
            btcReturns.push(btcReturn);
        }

        // Calculate means
        const meanSymbol = symbolReturns.reduce((a, b) => a + b, 0) / symbolReturns.length;
        const meanBtc = btcReturns.reduce((a, b) => a + b, 0) / btcReturns.length;

        // Calculate correlation
        let numerator = 0;
        let denomSymbol = 0;
        let denomBtc = 0;

        for (let i = 0; i < symbolReturns.length; i++) {
            const diffSymbol = symbolReturns[i] - meanSymbol;
            const diffBtc = btcReturns[i] - meanBtc;

            numerator += diffSymbol * diffBtc;
            denomSymbol += diffSymbol ** 2;
            denomBtc += diffBtc ** 2;
        }

        const denominator = Math.sqrt(denomSymbol * denomBtc);
        if (denominator === 0) return 0;

        return numerator / denominator;
    }
}
