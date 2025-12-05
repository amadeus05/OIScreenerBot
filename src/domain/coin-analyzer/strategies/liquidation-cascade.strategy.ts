/**
 * Liquidation Cascade Strategy
 * 
 * Analyzes liquidation imbalance to follow momentum:
 * - High long liquidations = bearish momentum, shorts winning
 * - High short liquidations = bullish momentum, longs winning
 * - Imbalance ratio > 3:1 = strong directional signal
 */

import { BaseStrategy } from './base.strategy';
import { AnalysisContext, StrategyResult } from '../types';

export class LiquidationCascadeStrategy extends BaseStrategy {
    readonly name = 'LiquidationCascadeStrategy';
    readonly defaultWeight = 1.0;

    // Configuration
    private readonly MIN_TOTAL_LIQUIDATIONS = 10000;  // $10K minimum volume
    private readonly STRONG_IMBALANCE_RATIO = 3.0;   // 3:1 ratio is strong
    private readonly MODERATE_IMBALANCE_RATIO = 2.0; // 2:1 ratio is moderate

    async evaluate(context: AnalysisContext): Promise<StrategyResult> {
        const longLiq = context.liquidations.longTotal;
        const shortLiq = context.liquidations.shortTotal;
        const totalLiq = longLiq + shortLiq;

        // Not enough liquidation activity
        if (totalLiq < this.MIN_TOTAL_LIQUIDATIONS) {
            return this.neutral(
                `Low liquidation volume: $${this.formatUSD(totalLiq)} (min $${this.formatUSD(this.MIN_TOTAL_LIQUIDATIONS)})`,
                { longLiq, shortLiq, totalLiq }
            );
        }

        // Calculate ratio (avoid division by zero)
        const ratio = context.liquidations.ratio; // longLiq / shortLiq
        const inverseRatio = shortLiq > 0 ? shortLiq / longLiq : Infinity;

        // Strong long liquidations = BEARISH (shorts winning)
        if (ratio >= this.STRONG_IMBALANCE_RATIO) {
            const strength = Math.min(ratio / 5, 1);
            return this.short(
                strength,
                0.8,
                `Strong long liquidations: $${this.formatUSD(longLiq)} vs $${this.formatUSD(shortLiq)} (${ratio.toFixed(1)}:1) - bearish cascade`,
                { longLiq, shortLiq, ratio, cascade: 'BEARISH' }
            );
        }

        // Strong short liquidations = BULLISH (longs winning)
        if (inverseRatio >= this.STRONG_IMBALANCE_RATIO) {
            const strength = Math.min(inverseRatio / 5, 1);
            return this.long(
                strength,
                0.8,
                `Strong short liquidations: $${this.formatUSD(shortLiq)} vs $${this.formatUSD(longLiq)} (1:${inverseRatio.toFixed(1)}) - bullish cascade`,
                { longLiq, shortLiq, ratio, cascade: 'BULLISH' }
            );
        }

        // Moderate imbalance
        if (ratio >= this.MODERATE_IMBALANCE_RATIO) {
            return this.short(
                0.4,
                0.6,
                `Moderate long liquidations: $${this.formatUSD(longLiq)} vs $${this.formatUSD(shortLiq)} (${ratio.toFixed(1)}:1)`,
                { longLiq, shortLiq, ratio, cascade: 'MODERATE_BEARISH' }
            );
        }

        if (inverseRatio >= this.MODERATE_IMBALANCE_RATIO) {
            return this.long(
                0.4,
                0.6,
                `Moderate short liquidations: $${this.formatUSD(shortLiq)} vs $${this.formatUSD(longLiq)} (1:${inverseRatio.toFixed(1)})`,
                { longLiq, shortLiq, ratio, cascade: 'MODERATE_BULLISH' }
            );
        }

        // Balanced liquidations
        return this.neutral(
            `Balanced liquidations: $${this.formatUSD(longLiq)} longs vs $${this.formatUSD(shortLiq)} shorts`,
            { longLiq, shortLiq, ratio, cascade: 'BALANCED' }
        );
    }

    /**
     * Format USD value (K/M).
     */
    private formatUSD(value: number): string {
        if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
        if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
        return value.toFixed(0);
    }
}
