/**
 * Entry Timing Resolver Service
 * 
 * Determines optimal entry timing based on market structure.
 */

import { Injectable } from '../../../shared/decorators';
import { IEntryTimingResolver } from '../interfaces';
import { AnalysisContext, EntryTiming, EntryTimingResult, TradeDirection } from '../types';

@Injectable()
export class EntryTimingResolver implements IEntryTimingResolver {

    /**
     * ATR multiplier for pullback calculation.
     */
    private readonly PULLBACK_ATR_MULTIPLIER = 0.5;

    /**
     * Minimum ATR % to consider market active enough for immediate entry.
     */
    private readonly MIN_ATR_PERCENT_FOR_IMMEDIATE = 0.3;

    resolve(context: AnalysisContext, direction: TradeDirection): EntryTimingResult {
        if (direction === TradeDirection.NEUTRAL) {
            return {
                timing: EntryTiming.WAIT_CONFIRMATION,
                reason: 'Direction is neutral, wait for clearer signal',
            };
        }

        const tf15m = context.multiTF.tf15m;
        const atrPercent = (tf15m.atr / context.currentPrice) * 100;

        // Check if current price is at support/resistance
        const nearSupport = this.isNearLevel(context.currentPrice, tf15m.supportLevels, atrPercent);
        const nearResistance = this.isNearLevel(context.currentPrice, tf15m.resistanceLevels, atrPercent);

        // LONG scenarios
        if (direction === TradeDirection.LONG) {
            // At support = good entry
            if (nearSupport) {
                return {
                    timing: EntryTiming.IMMEDIATE,
                    reason: 'Price at support level, good long entry',
                };
            }

            // Near resistance = wait for breakout
            if (nearResistance) {
                const resistanceLevel = this.findNearestLevel(context.currentPrice, tf15m.resistanceLevels);
                return {
                    timing: EntryTiming.WAIT_CONFIRMATION,
                    confirmationLevel: resistanceLevel * 1.002, // 0.2% above resistance
                    reason: `Wait for breakout above ${resistanceLevel.toFixed(2)}`,
                };
            }

            // In the middle = wait for pullback
            const pullbackPercent = atrPercent * this.PULLBACK_ATR_MULTIPLIER;
            return {
                timing: EntryTiming.WAIT_PULLBACK,
                pullbackPercent,
                reason: `Wait for ${pullbackPercent.toFixed(1)}% pullback for better entry`,
            };
        }

        // SHORT scenarios
        if (direction === TradeDirection.SHORT) {
            // At resistance = good entry
            if (nearResistance) {
                return {
                    timing: EntryTiming.IMMEDIATE,
                    reason: 'Price at resistance level, good short entry',
                };
            }

            // Near support = wait for breakdown
            if (nearSupport) {
                const supportLevel = this.findNearestLevel(context.currentPrice, tf15m.supportLevels);
                return {
                    timing: EntryTiming.WAIT_CONFIRMATION,
                    confirmationLevel: supportLevel * 0.998, // 0.2% below support
                    reason: `Wait for breakdown below ${supportLevel.toFixed(2)}`,
                };
            }

            // In the middle = wait for bounce
            const bouncePercent = atrPercent * this.PULLBACK_ATR_MULTIPLIER;
            return {
                timing: EntryTiming.WAIT_PULLBACK,
                pullbackPercent: bouncePercent,
                reason: `Wait for ${bouncePercent.toFixed(1)}% bounce for better entry`,
            };
        }

        // Fallback
        return {
            timing: EntryTiming.IMMEDIATE,
            reason: 'Default immediate entry',
        };
    }

    /**
     * Check if price is within ATR distance of any level.
     */
    private isNearLevel(price: number, levels: number[], atrPercent: number): boolean {
        const threshold = price * (atrPercent / 100) * 0.5; // Half ATR
        return levels.some(level => Math.abs(price - level) <= threshold);
    }

    /**
     * Find the nearest level to current price.
     */
    private findNearestLevel(price: number, levels: number[]): number {
        if (levels.length === 0) return price;

        return levels.reduce((nearest, level) =>
            Math.abs(level - price) < Math.abs(nearest - price) ? level : nearest
        );
    }
}
