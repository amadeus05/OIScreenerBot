// ========================================================================
// FILE: src/domain/signal-analyzer/modules/orderflow.module.ts
// ========================================================================

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { sigmoid, clamp } from '../utils/rolling-stats';
import { OrderflowScenarios } from '../rules/scenarios/orderflow.scenarios';

export class OrderflowModule extends BaseModule {
    readonly name = 'orderflow' as const;
    private readonly config = MODULE_CONFIG.orderflow;
    
    // State
    private dCVDHistory: number[] = [];
    private readonly historySize = 50;
    private lastProcessedTime = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[], marketContext?: any): ModuleOutput {
        const currentBar = bars[bars.length - 1];
        if (!currentBar) return this.createOutput(0, 0, ['no_data']);

        // 1. UPDATE STATE
        if (currentBar.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.dCVDHistory.push(features.dCVD);
                if (this.dCVDHistory.length > this.historySize) this.dCVDHistory.shift();
            }
            this.lastProcessedTime = currentBar.ts;
        }

        // 2. PREPARE CONTEXT
        const rawStd = this.calculateStd(this.dCVDHistory);
        const minStd = Math.max(features.buyVol * 0.05, 5000);
        const effectiveStd = Math.max(rawStd, minStd);

        const flatThreshold = features.atr > 0 
            ? (features.atr * 0.1) / currentBar.c 
            : 0.0005;

        // FIX: Локальный контекст
        const predicateContext = {
            effectiveStd,
            flatThreshold,
            currentPrice: currentBar.c,
            marketContext
        };

        // 3. BASE CALCULATION
        const flowNorm = clamp(features.flowImb, -1, 1);
        const dCVDNorm = features.dCVD / effectiveStd;
        const dCVDComponent = clamp((sigmoid(dCVDNorm) * 2) - 1, -1, 1);
        const volSign = Math.abs(flowNorm) > 0.1 ? Math.sign(flowNorm) : 0;
        const volComponent = clamp(features.volZ, -2, 2) * volSign;

        const rawMathScore = 
            this.config.flowWeight * flowNorm +
            this.config.dcvdWeight * dCVDComponent +
            this.config.volZWeight * volComponent;

        // 4. SCENARIO ENGINE
        let totalScore = Math.tanh(this.config.tanhScale * rawMathScore);
        let maxReliability = 0.6;
        const activeTags = new Set<string>();

        let overrideTriggered = false;

        for (const scenario of OrderflowScenarios) {
            // FIX: Передаем predicateContext
            const isMatch = scenario.conditions.every(c => c(features, predicateContext));
            if (isMatch) {
                if (scenario.tags.includes('hidden_selling_wall') || scenario.tags.includes('hidden_buying_wall')) {
                    totalScore = scenario.baseScore;
                    overrideTriggered = true;
                } else {
                    if (!overrideTriggered) {
                         totalScore = (totalScore + scenario.baseScore) / 2;
                    }
                }

                if (scenario.reliability > maxReliability) maxReliability = scenario.reliability;
                scenario.tags.forEach(t => activeTags.add(t));
            }
        }

        if (features.volZ < -0.5) {
            activeTags.add('low_volume_noise');
            maxReliability -= 0.1;
        }

        return this.createOutput(
            this.clampScore(totalScore),
            this.clampScore(maxReliability),
            Array.from(activeTags)
        );
    }

    private calculateStd(values: number[]): number {
        if (values.length < 2) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const sumSqDiff = values.reduce((sum, val) => sum + (val - mean) ** 2, 0);
        return Math.sqrt(sumSqDiff / (values.length - 1));
    }
    
    reset(): void {
        this.dCVDHistory = [];
        this.lastProcessedTime = 0;
    }
}