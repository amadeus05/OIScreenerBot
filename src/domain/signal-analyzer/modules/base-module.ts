/**
 * Signal Analyzer Module - Base Module
 * Abstract base class for all analysis modules
 */

import { Features, ModuleOutput, ModuleName, BarData, AggregatedBar } from '../types';

/**
 * Abstract base class for analysis modules
 * Each module analyzes features and returns a score [-1, 1] with reliability [0, 1]
 */
export abstract class BaseModule {
    abstract readonly name: ModuleName;

    /**
     * Analyze features and return score with reliability
     * @param features Computed features for current bar
     * @param bars Recent bars for additional context
     */
    abstract analyze(
        features: Features,
        bars: (BarData | AggregatedBar)[]
    ): ModuleOutput;

    /**
     * Create module output with consistent structure
     */
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

    /**
     * Clamp score to [-1, 1] range
     */
    protected clampScore(score: number): number {
        return Math.max(-1, Math.min(1, score));
    }

    /**
     * Tanh with scale factor for score normalization
     */
    protected scaledTanh(value: number, scale: number): number {
        return Math.tanh(scale * value);
    }

    /**
     * Sign function
     */
    protected sign(value: number): number {
        if (value > 0) return 1;
        if (value < 0) return -1;
        return 0;
    }
}
