/**
 * Trend Alignment Filter
 * 
 * Multi-timeframe analysis to check trend alignment across 5m/15m/1h.
 * All timeframes moving in the same direction = stronger signal.
 */

import { BaseFilter } from './base.filter';
import { AnalysisContext, FilterResult, TrendDirection } from '../types';

export class TrendAlignmentFilter extends BaseFilter {
    readonly name = 'TrendAlignmentFilter';
    readonly defaultWeight = 1.2; // Slightly higher weight for MTF analysis

    async analyze(context: AnalysisContext): Promise<FilterResult> {
        const tf5m = context.multiTF.tf5m.trend;
        const tf15m = context.multiTF.tf15m.trend;
        const tf1h = context.multiTF.tf1h.trend;

        // Count trends
        const trends = [tf5m, tf15m, tf1h];
        const upCount = trends.filter(t => t === TrendDirection.UP).length;
        const downCount = trends.filter(t => t === TrendDirection.DOWN).length;
        const sidewaysCount = trends.filter(t => t === TrendDirection.SIDEWAYS).length;

        // Perfect alignment (all same direction)
        if (upCount === 3) {
            return this.pass(
                0.9,
                0.9,
                'All timeframes bullish (5m/15m/1h ↑↑↑)',
                { tf5m, tf15m, tf1h, alignment: 'PERFECT_UP' }
            );
        }

        if (downCount === 3) {
            return this.pass(
                -0.9, // Negative = bearish bias
                0.9,
                'All timeframes bearish (5m/15m/1h ↓↓↓)',
                { tf5m, tf15m, tf1h, alignment: 'PERFECT_DOWN' }
            );
        }

        // Strong alignment (2 out of 3)
        if (upCount === 2) {
            const misaligned = tf5m !== TrendDirection.UP ? '5m' :
                tf15m !== TrendDirection.UP ? '15m' : '1h';
            return this.pass(
                0.6,
                0.7,
                `Mostly bullish (${misaligned} not aligned)`,
                { tf5m, tf15m, tf1h, alignment: 'STRONG_UP', misaligned }
            );
        }

        if (downCount === 2) {
            const misaligned = tf5m !== TrendDirection.DOWN ? '5m' :
                tf15m !== TrendDirection.DOWN ? '15m' : '1h';
            return this.pass(
                -0.6,
                0.7,
                `Mostly bearish (${misaligned} not aligned)`,
                { tf5m, tf15m, tf1h, alignment: 'STRONG_DOWN', misaligned }
            );
        }

        // All sideways
        if (sidewaysCount === 3) {
            return this.neutral(
                'All timeframes ranging, no clear trend',
                { tf5m, tf15m, tf1h, alignment: 'RANGING' }
            );
        }

        // Mixed/conflicting signals
        return this.pass(
            0,
            0.5,
            `Mixed trends (5m:${tf5m} 15m:${tf15m} 1h:${tf1h})`,
            { tf5m, tf15m, tf1h, alignment: 'MIXED' }
        );
    }
}
