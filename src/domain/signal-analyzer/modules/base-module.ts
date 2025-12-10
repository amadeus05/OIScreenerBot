// ========================================================================
// FILE: src/domain/signal-analyzer/modules/base-module.ts
// ========================================================================

import { Features, ModuleOutput, ModuleName, BarData, AggregatedBar } from '../types';

export interface AnalysisContext {
    regime: string;      // 'RANGING' | 'TRENDING' | 'VOLATILE'
    globalTrend: string; // 'UP' | 'DOWN' | 'FLAT'
    currentPrice: number;
    // Можно расширять
}

export abstract class BaseModule {
    abstract readonly name: ModuleName;

    /**
     * Analyze features and return score with reliability
     * @param features Computed features for current bar
     * @param bars Recent bars for additional context
     * @param context Global market context (Regime, BTC Trend, etc.)
     */
    abstract analyze(
        features: Features,
        bars: (BarData | AggregatedBar)[],
        context?: AnalysisContext // <-- НОВЫЙ АРГУМЕНТ
    ): ModuleOutput;

    protected createOutput(
        score: number,
        reliability: number,
        tags: string[] = []
    ): ModuleOutput {
        return {
            name: this.name,
            score: this.clampScore(score),
            reliability: Math.max(0, Math.min(1, reliability)),
            tags,
        };
    }

    protected clampScore(score: number): number {
        return Math.max(-1, Math.min(1, score));
    }

    protected scaledTanh(value: number, scale: number): number {
        return Math.tanh(scale * value);
    }

    protected sign(value: number): number {
        if (value > 0) return 1;
        if (value < 0) return -1;
        return 0;
    }
}