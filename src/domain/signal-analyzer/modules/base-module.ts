// ========================================================================
// FILE: src/domain/signal-analyzer/modules/base-module.ts
// ========================================================================

import { Features, ModuleOutput, ModuleName, BarData, AggregatedBar } from '../types';

export interface AnalysisContext {
    regime: string;      // 'RANGING' | 'TRENDING' | 'VOLATILE'
    globalTrend: string; // 'UP' | 'DOWN' | 'FLAT'
    currentPrice: number;
}

export abstract class BaseModule {
    abstract readonly name: ModuleName;

    /**
     * Analyze features and return score with reliability
     */
    abstract analyze(
        features: Features,
        bars: (BarData | AggregatedBar)[],
        context?: AnalysisContext
    ): ModuleOutput;

    /**
     * 🔥 UPDATED: Метод для гидратации состояния модуля из истории.
     * Модули, имеющие внутренний стейт (OI, Levels), обязаны переопределить это.
     */
    public hydrate(bars: (BarData | AggregatedBar)[]): void {
        // По умолчанию ничего не делаем, если модуль stateless (без состояния)
    }

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