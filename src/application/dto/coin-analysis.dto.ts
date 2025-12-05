/**
 * Coin Analysis DTO
 * 
 * Data Transfer Object for coin analysis results.
 * Used for communication between layers and Telegram responses.
 */

import { TradeDirection, EntryTiming, MarketRegime, TrendDirection } from '../../domain/coin-analyzer/types';

export class CoinAnalysisDto {
    constructor(
        public readonly symbol: string,
        public readonly timestamp: Date,

        // Core recommendation
        public readonly direction: TradeDirection,
        public readonly confidence: number,
        public readonly shouldTrade: boolean,

        // Entry details
        public readonly entryPrice: number,
        public readonly stopLossPrice: number,
        public readonly stopLossPercent: number,
        public readonly entryTiming: EntryTiming,
        public readonly entryTimingReason: string,

        // Market context
        public readonly marketRegime: MarketRegime,
        public readonly trendAlignment: {
            tf5m: TrendDirection;
            tf15m: TrendDirection;
            tf1h: TrendDirection;
            aligned: boolean;
        },

        // Component scores
        public readonly filterSummaries: Array<{
            name: string;
            passed: boolean;
            score: number;
            reason: string;
        }>,
        public readonly strategySummaries: Array<{
            name: string;
            direction: TradeDirection;
            score: number;
            reason: string;
        }>,

        // Overall summary
        public readonly summary: string,
    ) { }

    /**
     * Create from CoinAnalysisResult.
     */
    static fromResult(result: import('../../domain/coin-analyzer/types').CoinAnalysisResult): CoinAnalysisDto {
        return new CoinAnalysisDto(
            result.symbol,
            result.timestamp,

            result.direction,
            result.confidence,
            result.shouldTrade,

            result.entryPrice,
            result.stopLoss.price,
            result.stopLoss.distancePercent,
            result.entryTiming.timing,
            result.entryTiming.reason,

            result.marketRegime,
            result.trendAlignment,

            result.filterResults.map(f => ({
                name: f.filterName,
                passed: f.passed,
                score: f.score,
                reason: f.reason,
            })),

            result.strategyResults.map(s => ({
                name: s.strategyName,
                direction: s.direction,
                score: s.score,
                reason: s.reason,
            })),

            result.summary,
        );
    }
}
