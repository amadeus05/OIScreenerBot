/**
 * Coin Analyzer Module - Interfaces (Contracts)
 * 
 * Defines the contracts for all pluggable components:
 * - Filters (pre-trade checks)
 * - Strategies (direction signals)
 * - Core services
 */

import {
    AnalysisContext,
    FilterResult,
    StrategyResult,
    CoinAnalysisResult,
    StopLossResult,
    EntryTimingResult,
    TradeDirection,
    ComponentWeights,
    StoredAnalysis,
} from './types';

// ============================================================================
// FILTER INTERFACE
// ============================================================================

/**
 * Analysis filter contract.
 * 
 * Filters are pre-trade checks that determine if conditions are favorable.
 * Each filter returns a score and whether it "passes" (allows trading).
 * 
 * Examples: MarketRegimeFilter, BTCCorrelationFilter, FundingExtremeFilter
 */
export interface IAnalysisFilter {
    /** Unique name for this filter */
    readonly name: string;

    /** Current weight (adjusted by adaptation service) */
    weight: number;

    /** Default weight (initial value) */
    readonly defaultWeight: number;

    /**
     * Analyze the market context and return a filter result.
     * 
     * @param context Full analysis context with all market data
     * @returns FilterResult with score, confidence, and pass/fail
     */
    analyze(context: AnalysisContext): Promise<FilterResult>;
}

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

/**
 * Entry strategy contract.
 * 
 * Strategies evaluate the market and provide directional signals.
 * Each strategy returns a score indicating long/short bias.
 * 
 * Examples: OIDivergenceStrategy, LiquidationCascadeStrategy
 */
export interface IEntryStrategy {
    /** Unique name for this strategy */
    readonly name: string;

    /** Current weight (adjusted by adaptation service) */
    weight: number;

    /** Default weight (initial value) */
    readonly defaultWeight: number;

    /**
     * Evaluate the market and return a directional signal.
     * 
     * @param context Full analysis context with all market data
     * @returns StrategyResult with score and direction
     */
    evaluate(context: AnalysisContext): Promise<StrategyResult>;
}

// ============================================================================
// CORE SERVICE INTERFACES
// ============================================================================

/**
 * Resolves overall trade direction from strategy scores
 */
export interface IDirectionResolver {
    /**
     * Aggregate strategy results into a final direction.
     * 
     * @param results Array of strategy results
     * @returns Final trade direction with confidence
     */
    resolve(results: StrategyResult[]): {
        direction: TradeDirection;
        confidence: number;
        reason: string;
    };
}

/**
 * Determines optimal entry timing
 */
export interface IEntryTimingResolver {
    /**
     * Calculate entry timing recommendation.
     * 
     * @param context Analysis context
     * @param direction Resolved trade direction
     * @returns Entry timing details
     */
    resolve(context: AnalysisContext, direction: TradeDirection): EntryTimingResult;
}

/**
 * Calculates stop loss level
 */
export interface IStopLossCalculator {
    /**
     * Calculate stop loss based on ATR and market structure.
     * 
     * @param context Analysis context
     * @param direction Trade direction
     * @param entryPrice Entry price
     * @returns Stop loss details
     */
    calculate(
        context: AnalysisContext,
        direction: TradeDirection,
        entryPrice: number
    ): StopLossResult;
}

/**
 * Calculates overall confidence score
 */
export interface IConfidenceScorer {
    /**
     * Calculate weighted confidence from all component scores.
     * 
     * @param filterResults All filter results
     * @param strategyResults All strategy results
     * @returns Confidence percentage (0-100)
     */
    calculate(
        filterResults: FilterResult[],
        strategyResults: StrategyResult[]
    ): number;
}

/**
 * Multi-timeframe data aggregation service
 */
export interface IMultiTimeframeService {
    /**
     * Build multi-timeframe data from raw 1-minute candles.
     * 
     * @param symbol Symbol to analyze
     * @returns Aggregated multi-timeframe data
     */
    buildMultiTimeframeData(symbol: string): Promise<AnalysisContext['multiTF']>;
}

// ============================================================================
// COORDINATOR INTERFACE
// ============================================================================

/**
 * Main coin analyzer coordinator.
 * 
 * Orchestrates all filters, strategies, and services to produce
 * a comprehensive analysis result.
 */
export interface ICoinAnalyzer {
    /**
     * Perform full coin analysis.
     * 
     * @param symbol Symbol to analyze (e.g., 'BTCUSDT')
     * @returns Complete analysis result
     */
    analyze(symbol: string): Promise<CoinAnalysisResult>;

    /**
     * Register a new filter (plugin architecture).
     */
    registerFilter(filter: IAnalysisFilter): void;

    /**
     * Register a new strategy (plugin architecture).
     */
    registerStrategy(strategy: IEntryStrategy): void;

    /**
     * Get current component weights.
     */
    getWeights(): ComponentWeights;

    /**
     * Update component weights (called by adaptation service).
     */
    updateWeights(weights: ComponentWeights): void;
}

// ============================================================================
// PERSISTENCE INTERFACES
// ============================================================================

/**
 * Repository for storing analysis results
 */
export interface IAnalysisResultRepository {
    /**
     * Save a new analysis result.
     */
    save(analysis: StoredAnalysis): Promise<StoredAnalysis>;

    /**
     * Get analyses that haven't been evaluated yet.
     * 
     * @param olderThan Only get analyses older than this date
     */
    getUnevaluated(olderThan: Date): Promise<StoredAnalysis[]>;

    /**
     * Update analysis with actual outcome.
     */
    updateOutcome(
        id: number,
        actualPrice: number,
        actualChangePercent: number,
        wasCorrect: boolean
    ): Promise<void>;

    /**
     * Get recent analyses for weight calculation.
     * 
     * @param days Number of days to look back
     */
    getEvaluatedRecent(days: number): Promise<StoredAnalysis[]>;
}

/**
 * Service for automatic weight adaptation
 */
export interface IWeightAdaptationService {
    /**
     * Run the daily weight adaptation process.
     * 
     * 1. Fetch old analyses
     * 2. Compare predictions vs actual outcomes
     * 3. Adjust weights based on success rate
     */
    runAdaptation(): Promise<void>;

    /**
     * Get current optimized weights.
     */
    getCurrentWeights(): ComponentWeights;

    /**
     * Start the daily adaptation scheduler.
     */
    startScheduler(): void;

    /**
     * Stop the scheduler.
     */
    stopScheduler(): void;
}
