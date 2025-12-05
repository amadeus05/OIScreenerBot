/**
 * Confidence Scorer Service
 * 
 * Calculates overall confidence from all component scores.
 */

import { Injectable } from '../../../shared/decorators';
import { IConfidenceScorer } from '../interfaces';
import { FilterResult, StrategyResult } from '../types';

@Injectable()
export class ConfidenceScorer implements IConfidenceScorer {

    /**
     * Weight multiplier for filter results (filters are pre-conditions).
     */
    private readonly FILTER_WEIGHT_MULTIPLIER = 0.4;

    /**
     * Weight multiplier for strategy results (strategies are signals).
     */
    private readonly STRATEGY_WEIGHT_MULTIPLIER = 0.6;

    calculate(
        filterResults: FilterResult[],
        strategyResults: StrategyResult[]
    ): number {
        if (filterResults.length === 0 && strategyResults.length === 0) {
            return 0;
        }

        // Calculate filter score component
        const filterScore = this.calculateFilterScore(filterResults);

        // Calculate strategy score component
        const strategyScore = this.calculateStrategyScore(strategyResults);

        // Combine with weights
        const rawConfidence =
            filterScore * this.FILTER_WEIGHT_MULTIPLIER +
            strategyScore * this.STRATEGY_WEIGHT_MULTIPLIER;

        // Apply penalties for failed filters
        const failedFilters = filterResults.filter(f => !f.passed).length;
        const filterPenalty = failedFilters > 0 ? 0.5 ** failedFilters : 1;

        // Final confidence (0-100%)
        const confidence = rawConfidence * filterPenalty * 100;

        return Math.max(0, Math.min(100, confidence));
    }

    /**
     * Calculate aggregate filter score.
     */
    private calculateFilterScore(results: FilterResult[]): number {
        if (results.length === 0) return 0.5; // Neutral if no filters

        let weightedSum = 0;
        let totalWeight = 0;

        for (const result of results) {
            // For filters, we care about:
            // - passed = 1, failed = 0
            // - confidence as weight
            const passScore = result.passed ? 1 : 0;
            const weight = result.confidence;

            weightedSum += passScore * weight;
            totalWeight += weight;
        }

        return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
    }

    /**
     * Calculate aggregate strategy score.
     */
    private calculateStrategyScore(results: StrategyResult[]): number {
        if (results.length === 0) return 0.5; // Neutral if no strategies

        let weightedSum = 0;
        let totalWeight = 0;

        for (const result of results) {
            // For strategies, we care about:
            // - absolute score magnitude (how strong the signal is)
            // - confidence as weight
            const signalStrength = Math.abs(result.score);
            const weight = result.confidence;

            weightedSum += signalStrength * weight;
            totalWeight += weight;
        }

        return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
    }
}
