/**
 * Funding Rate Extreme Filter
 * 
 * Checks if funding rate is at extreme levels, indicating crowded trades.
 * Extreme funding often precedes reversals as one side gets squeezed.
 */

import { BaseFilter } from './base.filter';
import { AnalysisContext, FilterResult } from '../types';

export class FundingExtremeFilter extends BaseFilter {
    readonly name = 'FundingExtremeFilter';
    readonly defaultWeight = 1.0;

    // Configuration (funding rate thresholds in %)
    private readonly WARNING_THRESHOLD = 0.05;  // 0.05% = elevated
    private readonly EXTREME_THRESHOLD = 0.1;   // 0.1% = extreme (8h rate)
    private readonly CRITICAL_THRESHOLD = 0.2;  // 0.2% = very dangerous

    async analyze(context: AnalysisContext): Promise<FilterResult> {
        const fundingRate = context.fundingRate;
        const absFunding = Math.abs(fundingRate);

        // Critical level - do not trade
        if (absFunding >= this.CRITICAL_THRESHOLD) {
            const side = fundingRate > 0 ? 'longs' : 'shorts';
            return this.fail(
                -0.9,
                0.95,
                `Critical funding ${fundingRate > 0 ? '+' : ''}${(fundingRate * 100).toFixed(3)}%: ${side} extremely crowded, reversal likely`,
                { fundingRate, level: 'CRITICAL' }
            );
        }

        // Extreme level - trade with caution against the crowd
        if (absFunding >= this.EXTREME_THRESHOLD) {
            const side = fundingRate > 0 ? 'longs' : 'shorts';
            return this.pass(
                -0.3, // Negative score = suggests opposite direction
                0.7,
                `Extreme funding ${fundingRate > 0 ? '+' : ''}${(fundingRate * 100).toFixed(3)}%: ${side} crowded, watch for squeeze`,
                { fundingRate, level: 'EXTREME', crowdedSide: side }
            );
        }

        // Warning level - slightly elevated
        if (absFunding >= this.WARNING_THRESHOLD) {
            const side = fundingRate > 0 ? 'longs' : 'shorts';
            return this.pass(
                0.3,
                0.6,
                `Elevated funding ${fundingRate > 0 ? '+' : ''}${(fundingRate * 100).toFixed(3)}%: ${side} loading`,
                { fundingRate, level: 'WARNING' }
            );
        }

        // Normal funding - neutral conditions
        return this.pass(
            0.6,
            0.7,
            `Normal funding ${fundingRate > 0 ? '+' : ''}${(fundingRate * 100).toFixed(3)}%: balanced market`,
            { fundingRate, level: 'NORMAL' }
        );
    }
}
