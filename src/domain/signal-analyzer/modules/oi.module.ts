// ========================================================================
// FILE: src/domain/signal-analyzer/modules/oi.module.ts
// ========================================================================

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { OiScenarios } from '../rules/scenarios/oi.scenarios'; // <-- Импорт сценариев

export class OIModule extends BaseModule {
    readonly name = 'oi' as const;
    private readonly config = MODULE_CONFIG.oi;

    // История для расчета медианы (для strength)
    private absDOIHistory: number[] = [];
    private readonly historySize = 200;
    private lastProcessedTime = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const currentBar = bars[bars.length - 1];

        // --- 0. VALIDATION & STATE ---
        if (!currentBar || features.dOI === undefined) return this.createOutput(0, 0, ['no_data']);
        
        this.updateState(currentBar, features);

        if (this.absDOIHistory.length < 20) return this.createOutput(0, 0, ['warming_up']);

        // --- 1. PREPARE CONTEXT ---
        // Рассчитываем силу движения (Strength)
        const currentOI = currentBar.oi || 1;
        const fallbackMedian = currentOI * 0.001;
        const medianAbsDOI = this.calculateMedian(this.absDOIHistory) || fallbackMedian;
        
        // Cap at 2.5x to prevent insane scores
        const strength = Math.min(2.5, Math.abs(features.dOI) / medianAbsDOI);

        // Фильтр шума
        if (strength < 0.25) return this.createOutput(0, 0, ['oi_neutral']);

        // Дополнительный контекст для предикатов (если нужно)
        const context = { price: currentBar.c };

        // --- 2. SCENARIO ENGINE (ДВИЖОК) ---
        let totalScore = 0;
        let maxReliability = 0;
        const activeTags = new Set<string>();

        for (const scenario of OiScenarios) {
            // Проверяем все условия сценария
            const isMatch = scenario.conditions.every(condition => condition(features, context));

            if (isMatch) {
                // Рассчитываем вклад сценария
                let scenarioScore = scenario.baseScore;
                
                if (scenario.useStrengthMultiplier) {
                    scenarioScore *= strength;
                }

                // Агрегация
                totalScore += scenarioScore;
                
                // Надежность берем максимальную из сработавших (или можно усреднять)
                if (scenario.reliability > maxReliability) {
                    maxReliability = scenario.reliability;
                }

                scenario.tags.forEach(t => activeTags.add(t));
                
                // Дебаг лог (можно включить при необходимости)
                // console.log(`Matched Scenario: ${scenario.name}, Score: ${scenarioScore}`);
            }
        }

        // --- 3. FINAL OUTPUT ---
        // Clamp score to [-1, 1]
        const finalScore = this.clampScore(totalScore);
        
        return this.createOutput(
            finalScore,
            maxReliability > 0 ? maxReliability : 0.5, // Default reliability
            Array.from(activeTags)
        );
    }

    private updateState(bar: BarData | AggregatedBar, features: Features): void {
        if (bar.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.absDOIHistory.push(Math.abs(features.dOI));
                if (this.absDOIHistory.length > this.historySize) {
                    this.absDOIHistory.shift();
                }
            }
            this.lastProcessedTime = bar.ts;
        }
    }

    private calculateMedian(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    public reset(): void {
        this.absDOIHistory = [];
        this.lastProcessedTime = 0;
    }
}