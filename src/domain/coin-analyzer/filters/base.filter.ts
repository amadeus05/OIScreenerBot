/**
 * Base Analysis Filter
 * 
 * Abstract base class for all analysis filters.
 * Provides common functionality and ensures consistent interface.
 */

import { Logger } from '../../../shared/logger';
import { IAnalysisFilter } from '../interfaces';
import { AnalysisContext, FilterResult } from '../types';

export abstract class BaseFilter implements IAnalysisFilter {
    protected readonly logger: Logger;

    abstract readonly name: string;
    abstract readonly defaultWeight: number;

    private _weight: number = 0;

    constructor() {
        this.logger = new Logger(this.constructor.name);
    }

    get weight(): number {
        return this._weight || this.defaultWeight;
    }

    set weight(value: number) {
        this._weight = Math.max(0, Math.min(2, value)); // Clamp between 0 and 2
    }

    /**
     * Main analysis method to be implemented by subclasses.
     */
    abstract analyze(context: AnalysisContext): Promise<FilterResult>;

    /**
     * Helper to create a passing filter result.
     */
    protected pass(
        score: number,
        confidence: number,
        reason: string,
        details?: Record<string, number | string>
    ): FilterResult {
        return {
            filterName: this.name,
            score: this.clampScore(score),
            confidence: this.clampConfidence(confidence),
            passed: true,
            reason,
            details,
        };
    }

    /**
     * Helper to create a failing filter result.
     */
    protected fail(
        score: number,
        confidence: number,
        reason: string,
        details?: Record<string, number | string>
    ): FilterResult {
        return {
            filterName: this.name,
            score: this.clampScore(score),
            confidence: this.clampConfidence(confidence),
            passed: false,
            reason,
            details,
        };
    }

    /**
     * Helper to create a neutral result (neither pass nor fail strongly).
     */
    protected neutral(
        reason: string,
        details?: Record<string, number | string>
    ): FilterResult {
        return {
            filterName: this.name,
            score: 0,
            confidence: 0.5,
            passed: true, // Neutral = allow, but with low confidence
            reason,
            details,
        };
    }

    /**
     * Clamp score to valid range [-1, 1].
     */
    private clampScore(score: number): number {
        return Math.max(-1, Math.min(1, score));
    }

    /**
     * Clamp confidence to valid range [0, 1].
     */
    private clampConfidence(confidence: number): number {
        return Math.max(0, Math.min(1, confidence));
    }
}
