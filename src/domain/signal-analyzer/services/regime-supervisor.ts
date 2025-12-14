// ========================================================================
// FILE: src/domain/signal-analyzer/services/regime-supervisor.ts
// ИСПРАВЛЕНО: Правильная сортировка сценариев + улучшенные условия
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
        // 1. Сначала проверяем, есть ли ДОКАЗАТЕЛЬСТВА НЕ-боковика
        const activeScenarios = [...RegimeScenarios]
            .filter(s => s.regime !== 'RANGING') // Исключаем ranging из гонки
            .sort((a, b) => b.priority - a.priority);
    
        for (const scenario of activeScenarios) {
            const isMatch = scenario.conditions.every(condition => {
                try {
                    return condition(features, currentPrice);
                } catch (e) {
                    return false;
                }
            });
    
            if (isMatch) {
                return {
                    regime: scenario.regime,
                    confidence: 1.0,
                    reason: `${scenario.id} (strong evidence)`,
                    adjustedWeights: scenario.weights
                };
            }
        }
    
        // 2. Если НИЧЕГО не доказало тренд/волатильность → это RANGING
        const rangingScenario = RegimeScenarios.find(s => s.regime === 'RANGING');
        if (!rangingScenario) {
            console.warn('No RANGING scenario defined!');
        }
    
        return {
            regime: 'RANGING',
            confidence: 1.0,
            reason: 'No evidence of trend/volatility',
            adjustedWeights: rangingScenario?.weights || this.baseWeights
        };
    }
}