/**
 * Base Entry Strategy
 * 
 * Abstract base class for all entry strategies.
 * Provides common functionality and ensures consistent interface.
 */

import { Logger } from '../../../shared/logger';
import { IEntryStrategy } from '../interfaces';
import { AnalysisContext, StrategyResult, TradeDirection } from '../types';

export abstract class BaseStrategy implements IEntryStrategy {
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
     * Main evaluation method to be implemented by subclasses.
     */
    abstract evaluate(context: AnalysisContext): Promise<StrategyResult>;

    /**
     * Helper to create a LONG signal.
     */
    protected long(
        score: number,
        confidence: number,
        reason: string,
        details?: Record<string, number | string>
    ): StrategyResult {
        return {
            strategyName: this.name,
            score: this.clampScore(Math.abs(score)), // Positive for long
            confidence: this.clampConfidence(confidence),
            direction: TradeDirection.LONG,
            reason,
            details,
        };
    }

    /**
     * Helper to create a SHORT signal.
     */
    protected short(
        score: number,
        confidence: number,
        reason: string,
        details?: Record<string, number | string>
    ): StrategyResult {
        return {
            strategyName: this.name,
            score: -this.clampScore(Math.abs(score)), // Negative for short
            confidence: this.clampConfidence(confidence),
            direction: TradeDirection.SHORT,
            reason,
            details,
        };
    }

    /**
     * Helper to create a NEUTRAL signal.
     */
    protected neutral(
        reason: string,
        details?: Record<string, number | string>
    ): StrategyResult {
        return {
            strategyName: this.name,
            score: 0,
            confidence: 0.5,
            direction: TradeDirection.NEUTRAL,
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
