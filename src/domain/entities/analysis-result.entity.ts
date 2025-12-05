/**
 * Analysis Result Entity
 * 
 * Stores coin analysis results for retrospective evaluation
 * and weight adaptation.
 */

import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('analysis_results')
export class AnalysisResultEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Index()
    @Column({ type: 'text' })
    symbol!: string;

    @Column({ type: 'text' })
    direction!: 'LONG' | 'SHORT' | 'NEUTRAL';

    @Column({ name: 'confidence', type: 'real' })
    confidence!: number;

    @Column({ name: 'should_trade', type: 'boolean' })
    shouldTrade!: boolean;

    @Column({ name: 'entry_price', type: 'real' })
    entryPrice!: number;

    @Column({ name: 'stop_loss_price', type: 'real' })
    stopLossPrice!: number;

    @Column({ name: 'stop_loss_percent', type: 'real' })
    stopLossPercent!: number;

    @Column({ name: 'entry_timing', type: 'text' })
    entryTiming!: string;

    @Column({ name: 'market_regime', type: 'text' })
    marketRegime!: string;

    // JSON columns for detailed scores
    @Column({ name: 'filter_scores', type: 'text' })
    filterScoresJson!: string;

    @Column({ name: 'strategy_scores', type: 'text' })
    strategyScoresJson!: string;

    @Column({ type: 'text' })
    summary!: string;

    // Retrospective evaluation (filled later)
    @Column({ name: 'actual_price_24h', type: 'real', nullable: true })
    actualPrice24h?: number;

    @Column({ name: 'actual_change_percent', type: 'real', nullable: true })
    actualChangePercent?: number;

    @Column({ name: 'was_correct', type: 'boolean', nullable: true })
    wasCorrect?: boolean;

    @Column({ name: 'evaluated_at', type: 'datetime', nullable: true })
    evaluatedAt?: Date;

    @CreateDateColumn({ name: 'created_at', type: 'datetime' })
    createdAt!: Date;

    // Helper methods for JSON fields
    get filterScores(): Record<string, number> {
        try {
            return JSON.parse(this.filterScoresJson || '{}');
        } catch {
            return {};
        }
    }

    set filterScores(value: Record<string, number>) {
        this.filterScoresJson = JSON.stringify(value);
    }

    get strategyScores(): Record<string, number> {
        try {
            return JSON.parse(this.strategyScoresJson || '{}');
        } catch {
            return {};
        }
    }

    set strategyScores(value: Record<string, number>) {
        this.strategyScoresJson = JSON.stringify(value);
    }
}
