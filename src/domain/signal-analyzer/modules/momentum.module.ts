// ========================================================================
// FILE: src/domain/signal-analyzer/modules/momentum.module.ts
// ========================================================================

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { MomentumScenarios } from '../rules/scenarios/momentum.scenarios';
import { RollingStats, clamp } from '../utils/rolling-stats';

const EPS = 1e-10;

export class MomentumModule extends BaseModule {
    readonly name = 'momentum' as const;
    private readonly config = MODULE_CONFIG.momentum;

    // State
    private lastProcessedTime = 0;
    private lastClosedEmaDiff = 0;
    private currentTickEmaDiff = 0;
    private recentVolatility = new RollingStats(100);

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const currentBar = bars[bars.length - 1];
        const currentPrice = currentBar.c;

        // 1. UPDATE STATE
        if (currentBar.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.lastClosedEmaDiff = this.currentTickEmaDiff;
            }
            this.lastProcessedTime = currentBar.ts;
        }

        // 2. DEAD MARKET FILTER
        const volatilityPct = (features.atr / currentPrice) * 100;
        this.recentVolatility.push(volatilityPct);
        const adaptiveThreshold = Math.max(this.recentVolatility.median() * 0.3, 0.01);
        if (volatilityPct < adaptiveThreshold) {
            return this.createOutput(0, 0.1, ['dead_market']);
        }

        // 3. BASE CALCULATION (Trend)
        const emaDiff = features.emaFast - features.emaSlow;
        this.currentTickEmaDiff = emaDiff;
        const m = emaDiff / Math.max(features.emaSlow, EPS);
        let baseScore = this.scaledTanh(m, this.config.scaleFactor);

        // 4. CONTEXT PREPARATION
        const deviation = (currentPrice - features.emaSlow) / features.atr;
        const context = {
            currentPrice,
            lastClosedEmaDiff: this.lastClosedEmaDiff,
            deviation
        };

        // 5. SCENARIO ENGINE
        let totalScore = baseScore;
        let reliability = 0.5;
        let isReversal = false;
        const activeTags = new Set<string>();

        // Базовые теги структуры
        if (totalScore > 0.2) activeTags.add('bullish_structure');
        if (totalScore < -0.2) activeTags.add('bearish_structure');

        for (const scenario of MomentumScenarios) {
            const isMatch = scenario.conditions.every(c => c(features, context));
            if (isMatch) {
                // Если это Reversal, он заменяет трендовый скор
                if (scenario.tags.includes('mean_reversion')) {
                    totalScore = scenario.baseScore; // Override
                    isReversal = true;
                } else {
                    totalScore += scenario.baseScore; // Additive
                }
                
                if (scenario.reliability > reliability) reliability = scenario.reliability;
                scenario.tags.forEach(t => activeTags.add(t));
            }
        }

        // 6. POST-PROCESSING (Stalling & Alignment)
        // Если мы в тренде, но цена улетела далеко (Stalling), а сигнала на разворот еще нет
        if (!isReversal && Math.abs(deviation) > 1.5) {
            totalScore *= 0.3; // Урезаем оптимизм
            activeTags.add('momentum_stalling');
        }

        // Проверка согласованности цены и импульса (если не разворот)
        if (!isReversal) {
            const isAligned = (totalScore > 0 && currentPrice > features.emaSlow) || 
                              (totalScore < 0 && currentPrice < features.emaSlow);
            if (Math.abs(totalScore) > 0.3 && !isAligned) {
                activeTags.add('price_counter_trend');
                reliability -= 0.2;
            }
        }

        return this.createOutput(
            this.clampScore(totalScore),
            this.clampScore(reliability),
            Array.from(activeTags)
        );
    }

    reset(): void {
        this.lastProcessedTime = 0;
        this.lastClosedEmaDiff = 0;
        this.currentTickEmaDiff = 0;
        this.recentVolatility.reset();
    }
}