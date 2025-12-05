/**
 * OI Divergence Strategy
 * 
 * Detects divergence between Open Interest and Price:
 * - OI↑ + Price↓ = Shorts accumulating, potential short squeeze
 * - OI↓ + Price↑ = Weak rally (longs taking profit), potential reversal
 * - OI↑ + Price↑ = New longs entering, trend continuation
 * - OI↓ + Price↓ = Longs exiting, capitulation
 */

import { BaseStrategy } from './base.strategy';
import { AnalysisContext, StrategyResult, TradeDirection } from '../types';

export class OIDivergenceStrategy extends BaseStrategy {
    readonly name = 'OIDivergenceStrategy';
    readonly defaultWeight = 1.2; // Higher weight - this is a key strategy

    // Configuration
    private readonly SIGNIFICANT_OI_CHANGE = 2.0;    // 2% OI change is significant
    private readonly SIGNIFICANT_PRICE_CHANGE = 0.5; // 0.5% price change

    async evaluate(context: AnalysisContext): Promise<StrategyResult> {
        const oiChange = context.openInterest.changePercent1h;
        const priceChange = this.calculatePriceChange1h(context);

        const absOiChange = Math.abs(oiChange);
        const absPriceChange = Math.abs(priceChange);

        // Not enough movement for a signal
        if (absOiChange < this.SIGNIFICANT_OI_CHANGE && absPriceChange < this.SIGNIFICANT_PRICE_CHANGE) {
            return this.neutral(
                `Insufficient movement: OI ${oiChange > 0 ? '+' : ''}${oiChange.toFixed(2)}%, Price ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(2)}%`,
                { oiChange, priceChange }
            );
        }

        const oiUp = oiChange > 0;
        const priceUp = priceChange > 0;

        // Scenario 1: OI↑ + Price↓ = SHORT SQUEEZE POTENTIAL (BULLISH)
        if (oiUp && !priceUp) {
            const strength = Math.min((absOiChange / 5) + (absPriceChange / 2), 1);
            return this.long(
                strength,
                0.75,
                `Bearish divergence: OI +${oiChange.toFixed(2)}% while Price ${priceChange.toFixed(2)}% - shorts loading, squeeze potential`,
                { oiChange, priceChange, scenario: 'SHORT_SQUEEZE_POTENTIAL' }
            );
        }

        // Scenario 2: OI↓ + Price↑ = WEAK RALLY (BEARISH)
        if (!oiUp && priceUp) {
            const strength = Math.min((absOiChange / 5) + (absPriceChange / 2), 1);
            return this.short(
                strength,
                0.7,
                `Bullish divergence: OI ${oiChange.toFixed(2)}% while Price +${priceChange.toFixed(2)}% - weak rally, shorts covering`,
                { oiChange, priceChange, scenario: 'WEAK_RALLY' }
            );
        }

        // Scenario 3: OI↑ + Price↑ = NEW LONGS (BULLISH CONTINUATION)
        if (oiUp && priceUp) {
            const strength = Math.min((absOiChange / 5) + (absPriceChange / 2), 1) * 0.7; // Lower confidence
            return this.long(
                strength,
                0.6,
                `Bullish confirmation: OI +${oiChange.toFixed(2)}% + Price +${priceChange.toFixed(2)}% - new longs, trend continuation`,
                { oiChange, priceChange, scenario: 'BULLISH_CONTINUATION' }
            );
        }

        // Scenario 4: OI↓ + Price↓ = CAPITULATION (BULLISH REVERSAL POTENTIAL)
        if (!oiUp && !priceUp) {
            const strength = Math.min((absOiChange / 5) + (absPriceChange / 2), 1) * 0.5;
            return this.long(
                strength,
                0.55,
                `Capitulation: OI ${oiChange.toFixed(2)}% + Price ${priceChange.toFixed(2)}% - longs exiting, potential bottom`,
                { oiChange, priceChange, scenario: 'CAPITULATION' }
            );
        }

        return this.neutral('No clear OI divergence pattern', { oiChange, priceChange });
    }

    /**
     * Calculate 1h price change percentage.
     */
    private calculatePriceChange1h(context: AnalysisContext): number {
        const candles = context.rawCandles;
        if (candles.length < 60) return 0;

        const hourAgoIndex = Math.max(0, candles.length - 60);
        const hourAgoPrice = candles[hourAgoIndex].ohlc.c;
        const currentPrice = context.currentPrice;

        return ((currentPrice - hourAgoPrice) / hourAgoPrice) * 100;
    }
}
