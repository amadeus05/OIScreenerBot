// ========================================================================
// FILE: src/domain/signal-analyzer/services/decision-aggregator.ts
// ========================================================================

import { ModuleOutput, TradeAction, ModuleName, Features } from '../types';
import { DEFAULT_CONFIG, ModuleWeights } from '../types/config';
import { MarketContext } from '../types/context';

export interface AggregationResult {
    rawScore: number;
    action: TradeAction;
    moduleAgreement: number; // % of weight agreeing with the direction
    vetoReason?: string;
}

export class DecisionAggregator {
    private weights: ModuleWeights;
    private readonly threshold: number;

    constructor(
        weights: ModuleWeights = DEFAULT_CONFIG.weights,
        threshold: number = DEFAULT_CONFIG.decision.threshold
    ) {
        this.weights = weights;
        this.threshold = threshold;
    }

    public setWeights(weights: ModuleWeights): void {
        this.weights = weights;
    }

    /**
     * Pure mathematical aggregation.
     * No magic flips, no complex tag parsing.
     * Scenarios define the direction (Sign of Score) and Logic (Predicates).
     */
    public aggregate(
        moduleOutputs: ModuleOutput[],
        features: Features,
        context?: MarketContext
    ): AggregationResult {
        if (moduleOutputs.length === 0) {
            return this.createEmptyResult();
        }

        // 1. Calculate Weighted Sum
        let weightedSum = 0;
        let totalActiveWeight = 0;
        let agreeingWeight = 0;

        for (const output of moduleOutputs) {
            const weight = this.weights[output.name] || 0;

            // If module has no weight or score is 0, skip
            if (weight === 0 || output.score === 0) continue;

            // Effective weight includes the module's own reliability/confidence
            // In Scenario architecture, reliability is usually high (0.7 - 0.9)
            const effectiveWeight = weight * output.reliability;

            weightedSum += output.score * effectiveWeight;
            totalActiveWeight += effectiveWeight;
        }

        // 2. Normalize Score (-1.0 to 1.0)
        const rawScore = totalActiveWeight > 0 ? weightedSum / totalActiveWeight : 0;

        // 3. Determine Action
        let action: TradeAction = 'NO_TRADE';
        if (Math.abs(rawScore) >= this.threshold) {
            action = rawScore > 0 ? 'LONG' : 'SHORT';
        }

        // 4. Calculate Agreement (Metadata)
        // Helps to know if modules contradicted each other
        if (totalActiveWeight > 0 && action !== 'NO_TRADE') {
            const finalSign = Math.sign(rawScore);
            for (const output of moduleOutputs) {
                if (output.score !== 0 && Math.sign(output.score) === finalSign) {
                    const w = (this.weights[output.name] || 0) * output.reliability;
                    agreeingWeight += w;
                }
            }
        }
        const moduleAgreement = totalActiveWeight > 0 ? agreeingWeight / totalActiveWeight : 0;

        // 5. GLOBAL PERMISSIONS CHECK (The only "Veto" left)
        // Checks config settings like "Allow Longs" / "Allow Shorts"
        if (context && action !== 'NO_TRADE') {
            const isLongRestricted = action === 'LONG' && !context.permissions.allowLong;
            const isShortRestricted = action === 'SHORT' && !context.permissions.allowShort;

            if (isLongRestricted || isShortRestricted) {
                return {
                    rawScore: 0,
                    action: 'NO_TRADE',
                    moduleAgreement: 0,
                    vetoReason: `GLOBAL_PERMISSION_${context.permissions.reason.toUpperCase()}`
                };
            }
        }

        return {
            rawScore,
            action,
            moduleAgreement,
            vetoReason: undefined
        };
    }

    // --- Helpers ---

    public getModuleScoresRecord(moduleOutputs: ModuleOutput[]): Record<ModuleName, number> {
        const record: any = {};
        for (const output of moduleOutputs) {
            record[output.name] = output.score;
        }
        return record;
    }

    public collectReasonTags(moduleOutputs: ModuleOutput[]): string[] {
        const tags = new Set<string>();
        // Sort by weight importance for better readability
        const sortedOutputs = [...moduleOutputs].sort((a, b) => {
            return (this.weights[b.name] || 0) - (this.weights[a.name] || 0);
        });

        for (const output of sortedOutputs) {
            if (output.score !== 0) {
                output.tags.forEach(t => tags.add(t));
            }
        }
        return Array.from(tags);
    }

    private createEmptyResult(): AggregationResult {
        return {
            rawScore: 0,
            action: 'NO_TRADE',
            moduleAgreement: 0
        };
    }
}