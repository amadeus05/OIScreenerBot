// ========================================================================
// FILE: src/domain/signal-analyzer/services/regime-supervisor.ts
// ========================================================================

import { Features, ModuleName } from '../types';
import { ModuleWeights, DEFAULT_CONFIG } from '../types/config';
import { RegimeScenarios, RegimeScenario } from '../rules/scenarios/regime.scenarios';

export type MarketRegime = 'RANGING' | 'TRENDING' | 'VOLATILE' | 'EXTREME';

export interface RegimeAnalysis {
    regime: MarketRegime;
    confidence: number;
    adjustedWeights: ModuleWeights;
    reason: string;
}

interface ScoredScenario {
    scenario: RegimeScenario;
    ratio: number;  // % совпадения условий (0..1)
    score: number;  // Итоговый балл (Priority * Ratio)
}

export class RegimeSupervisor {
    private readonly baseWeights: ModuleWeights;
    // Максимальный приоритет для нормализации скора
    private readonly MAX_PRIORITY = 100; 

    constructor(baseWeights: ModuleWeights = DEFAULT_CONFIG.weights) {
        this.baseWeights = baseWeights;
    }

    public analyze(features: Features, currentPrice: number): RegimeAnalysis {
        // 1. Evaluate ALL scenarios (кроме явного fallback, если он есть в массиве без условий)
        const candidates: ScoredScenario[] = [];

        for (const scenario of RegimeScenarios) {
            // Пропускаем "пустые" сценарии (fallback обрабатываем отдельно)
            if (scenario.conditions.length === 0) continue;

            let matches = 0;
            for (const condition of scenario.conditions) {
                try {
                    if (condition(features, currentPrice)) matches++;
                } catch (e) {
                    // Логируем ошибку предиката, но не крашимся
                }
            }

            const ratio = matches / scenario.conditions.length;
            
            // 🛑 CRITICAL FILTER: Если совпадений недостаточно — игнорируем сценарий
            const threshold = scenario.minMatchRatio ?? 0.6; // Default 60%
            if (ratio >= threshold) {
                // 🧮 Score Calculation: Priority имеет вес, но Ratio уточняет силу
                const score = scenario.priority * ratio;
                candidates.push({ scenario, ratio, score });
            }
        }

        // 2. Determine Winner
        if (candidates.length === 0) {
            return this.createRangingFallback(features);
        }

        // Сортируем: побеждает самый высокий Score (Priority * Ratio)
        candidates.sort((a, b) => b.score - a.score);
        const winner = candidates[0];

        // 3. Calculate Dynamic Confidence
        // Формула: Base(0.4) + RatioContribution(0.4) + PriorityContribution(0.2)
        // Если 100% совпадение по VOLATILE (P=100) -> 0.4 + 0.4 + 0.2 = 1.0
        // Если 60% совпадение по TRENDING (P=50) -> 0.4 + 0.24 + 0.1 = 0.74
        const priorityNorm = winner.scenario.priority / this.MAX_PRIORITY;
        
        let confidence = 0.4 + (winner.ratio * 0.4) + (priorityNorm * 0.2);
        confidence = Math.min(1, Math.max(0, confidence));

        // 4. Weight Blending (Lerp)
        // adjusted = base * (1 - conf) + target * conf
        // Чем выше уверенность, тем сильнее мы смещаем веса в сторону сценария
        const adjustedWeights = this.blendWeights(
            this.baseWeights,
            winner.scenario.weights,
            confidence
        );

        return {
            regime: winner.scenario.regime,
            confidence: parseFloat(confidence.toFixed(2)),
            reason: `${winner.scenario.id} (score: ${winner.score.toFixed(1)}, match: ${(winner.ratio*100).toFixed(0)}%)`,
            adjustedWeights
        };
    }

    /**
     * Fallback, когда ни один сценарий не сработал.
     * Уверенность в RANGING зависит от отсутствия волатильности.
     */
    private createRangingFallback(features: Features): RegimeAnalysis {
        // Если волатильность низкая (volZ < 1), мы уверены, что это RANGING.
        // Если волатильность есть, но паттерны не совпали — уверенность ниже.
        const volatilityPenalty = Math.max(0, Math.min(0.5, features.volZ * 0.2));
        const confidence = 0.8 - volatilityPenalty;

        // Ищем дефолтные веса для Ranging (можно взять из конфига или константы)
        const rangingWeights: ModuleWeights = { 
            meanReversion: 0.0,
            orderflow: 0.40,
            liquidations: 0.10,
            levels: 0.40,
            momentum: 0.05,
            oi: 0.05,
        };

        return {
            regime: 'RANGING',
            confidence: parseFloat(confidence.toFixed(2)),
            reason: 'No scenario matched (Default to Ranging)',
            adjustedWeights: this.blendWeights(this.baseWeights, rangingWeights, confidence)
        };
    }

    /**
     * Linear Interpolation (Lerp) for weights.
     * W_final = W_base + (W_target - W_base) * alpha
     */
    private blendWeights(base: ModuleWeights, target: ModuleWeights, alpha: number): ModuleWeights {
        const result: Partial<ModuleWeights> = {};
        const modules = Object.keys(base) as ModuleName[];

        let sum = 0;
        for (const mod of modules) {
            const b = base[mod] || 0;
            const t = target[mod] || 0;
            // Lerp
            const val = b + (t - b) * alpha;
            result[mod] = val;
            sum += val;
        }

        // Normalize checks to ensure sum is approx 1.0 (optional logic/sanity check)
        // Но для простоты вернем как есть, DecisionAggregator сам делит на сумму весов.
        return result as ModuleWeights;
    }
}