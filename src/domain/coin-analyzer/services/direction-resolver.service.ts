/**
 * Direction Resolver Service
 * 
 * Aggregates strategy results into a final trade direction.
 */

import { Injectable } from '../../../shared/decorators';
import { IDirectionResolver } from '../interfaces';
import { StrategyResult, TradeDirection } from '../types';

@Injectable()
export class DirectionResolver implements IDirectionResolver {

    /**
     * Threshold for considering a direction signal significant.
     * If weighted score is below this, return NEUTRAL.
     */
    private readonly SIGNIFICANCE_THRESHOLD = 0.15;

    resolve(results: StrategyResult[]): {
        direction: TradeDirection;
        confidence: number;
        reason: string;
    } {
        if (results.length === 0) {
            return {
                direction: TradeDirection.NEUTRAL,
                confidence: 0,
                reason: 'No strategy results to evaluate',
            };
        }

        // Calculate weighted score
        let totalWeightedScore = 0;
        let totalWeight = 0;
        let totalConfidence = 0;

        for (const result of results) {
            const weight = 1; // Default weight, can be customized
            totalWeightedScore += result.score * result.confidence * weight;
            totalWeight += weight;
            totalConfidence += result.confidence;
        }

        const avgScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;
        const avgConfidence = results.length > 0 ? totalConfidence / results.length : 0;

        // Determine direction based on score
        let direction: TradeDirection;
        let reason: string;

        if (Math.abs(avgScore) < this.SIGNIFICANCE_THRESHOLD) {
            direction = TradeDirection.NEUTRAL;
            reason = `Mixed signals (score: ${avgScore.toFixed(3)}), no clear direction`;
        } else if (avgScore > 0) {
            direction = TradeDirection.LONG;
            reason = `Bullish consensus (score: +${avgScore.toFixed(3)})`;
        } else {
            direction = TradeDirection.SHORT;
            reason = `Bearish consensus (score: ${avgScore.toFixed(3)})`;
        }

        // Build detailed reason
        const contributions = results
            .map(r => `${r.strategyName}: ${r.score > 0 ? '+' : ''}${r.score.toFixed(2)}`)
            .join(', ');

        return {
            direction,
            confidence: Math.abs(avgScore) * avgConfidence * 100, // Convert to percentage
            reason: `${reason}. Contributions: [${contributions}]`,
        };
    }
}
