// ========================================================================
// FILE: src/domain/signal-analyzer/modules/liquidation.module.ts
// ========================================================================

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { LiquidationScenarios } from '../rules/scenarios/liquidation.scenarios';

export class LiquidationModule extends BaseModule {
    readonly name = 'liquidations' as const;
    private readonly config = MODULE_CONFIG.liquidations;

    private readonly historySize = 1000;
    private historyIntensityLong: number[] = [];
    private historyIntensityShort: number[] = [];
    private lastProcessedTs = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[], marketContext?: any): ModuleOutput {
        if (bars.length < 15) return this.createOutput(0, 0.3, []);

        const currentBar = bars[bars.length - 1];
        const prevBar = bars[bars.length - 2];

        // 1. UPDATE HISTORY
        if (currentBar.ts > this.lastProcessedTs) {
            if (this.lastProcessedTs !== 0) {
                const prevOI = prevBar.oi || prevBar.v || 1;
                this.historyIntensityLong.push((prevBar.liquidations?.long || 0) / prevOI);
                this.historyIntensityShort.push((prevBar.liquidations?.short || 0) / prevOI);
                if (this.historyIntensityLong.length > this.historySize) {
                    this.historyIntensityLong.shift();
                    this.historyIntensityShort.shift();
                }
            }
            this.lastProcessedTs = currentBar.ts;
        }

        const currentOI = currentBar.oi || currentBar.v || 1;
        const liqs = currentBar.liquidations || { long: 0, short: 0 };

        const intensityLong = liqs.long / currentOI;
        const intensityShort = liqs.short / currentOI;

        const threshLong = this.historyIntensityLong.length > 50
            ? this.calculatePercentile(this.historyIntensityLong, 0.98) : Infinity;
        const threshShort = this.historyIntensityShort.length > 50
            ? this.calculatePercentile(this.historyIntensityShort, 0.98) : Infinity;

        const isHugeLong = intensityLong > threshLong;
        const isHugeShort = intensityShort > threshShort;

        // Velocity & Acceleration
        const getSumLiq = (n: number, type: 'short' | 'long') =>
            bars.slice(-n).reduce((acc, b) => acc + (b.liquidations?.[type] || 0), 0);

        const rateShort3m = getSumLiq(3, 'short') / 3;
        const rateShort10m = getSumLiq(10, 'short') / 10;
        const isShortCascadeAccel = rateShort3m > (rateShort10m * 2.5) && isHugeShort;

        const rateLong3m = getSumLiq(3, 'long') / 3;
        const rateLong10m = getSumLiq(10, 'long') / 10;
        const isLongCascadeAccel = rateLong3m > (rateLong10m * 2.5) && isHugeLong;

        // Grinding Up Logic
        const shortBias15m = getSumLiq(15, 'short');
        const longBias15m = getSumLiq(15, 'long');
        const accumulatedThresholdShort = threshShort * 5 * currentOI;
        const isGrindingUp = shortBias15m > longBias15m * 3 && shortBias15m > accumulatedThresholdShort;

        const predicateContext = {
            isHugeLong,
            isHugeShort,
            isCascadeAccel: isShortCascadeAccel || isLongCascadeAccel,
            isGrindingUp,
            marketContext // Можно вложить глобальный контекст внутрь, если понадобится
        };

        // 3. SCENARIO ENGINE
        let totalScore = 0;
        let maxReliability = 0.5;
        const activeTags = new Set<string>();

        if (isHugeLong && isHugeShort) {
            activeTags.add('bi_directional_rekt');
            return this.createOutput(0, 0.2, Array.from(activeTags));
        }

        for (const scenario of LiquidationScenarios) {
            // Передаем predicateContext
            const isMatch = scenario.conditions.every(c => c(features, predicateContext));
            if (isMatch) {
                totalScore += scenario.baseScore;
                if (scenario.reliability > maxReliability) maxReliability = scenario.reliability;
                scenario.tags.forEach(t => activeTags.add(t));
            }
        }

        // 4. FLAG UPDATE
        if (Math.abs(totalScore) > 0.5) features.liquidationSignal = true;

        return this.createOutput(
            this.clampScore(totalScore),
            this.clampScore(maxReliability),
            Array.from(activeTags)
        );
    }

    private calculatePercentile(values: number[], p: number): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.ceil(p * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    reset(): void {
        this.historyIntensityLong = [];
        this.historyIntensityShort = [];
        this.lastProcessedTs = 0;
    }
}