// ========================================================================
// FILE: src/domain/signal-analyzer/services/regime-supervisor.ts
// ========================================================================

import { Features } from '../types';
import { ModuleWeights, DEFAULT_CONFIG } from '../types/config';
import { RegimeScenarios } from '../rules/scenarios/regime.scenarios';

export type MarketRegime = 'RANGING' | 'TRENDING' | 'VOLATILE';

export interface RegimeAnalysis {
    regime: MarketRegime;
    confidence: number;
    adjustedWeights: ModuleWeights;
    reason: string;
}

export class RegimeSupervisor {
    private readonly baseWeights: ModuleWeights;

    constructor(baseWeights: ModuleWeights = DEFAULT_CONFIG.weights) {
        this.baseWeights = baseWeights;
    }

    public analyze(features: Features, currentPrice: number): RegimeAnalysis {
        // 1. Сортируем сценарии по приоритету (от важного к неважному)
        const sortedScenarios = [...RegimeScenarios].sort((a, b) => b.priority - a.priority);

        // 2. Ищем первое совпадение
        for (const scenario of sortedScenarios) {
            // Если условий нет (пустой массив), считаем это Fallback (всегда true)
            const isMatch = scenario.conditions.length === 0 || 
                            scenario.conditions.every(condition => condition(features, currentPrice));

            if (isMatch) {
                return {
                    regime: scenario.regime,
                    confidence: 1.0, // Сценарии детерминированы
                    reason: `Matched: ${scenario.id}`,
                    adjustedWeights: scenario.weights
                };
            }
        }

        // 3. Safety Fallback (если вдруг удалили default сценарий)
        return {
            regime: 'RANGING',
            confidence: 0,
            reason: 'Fallback (No scenario matched)',
            adjustedWeights: this.baseWeights
        };
    }
}