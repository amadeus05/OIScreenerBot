/**
 * Coin Analyzer Module - Types and Enums
 * 
 * Defines all core types used across the coin analysis system.
 */

import { SmartCandle } from '../interfaces/market-data.interface';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Trade direction recommendation
 */
export enum TradeDirection {
    LONG = 'LONG',
    SHORT = 'SHORT',
    NEUTRAL = 'NEUTRAL',
}

/**
 * Market regime classification
 */
export enum MarketRegime {
    TRENDING_UP = 'TRENDING_UP',
    TRENDING_DOWN = 'TRENDING_DOWN',
    RANGING = 'RANGING',
    HIGH_VOLATILITY = 'HIGH_VOLATILITY',
    LOW_LIQUIDITY = 'LOW_LIQUIDITY',
}

/**
 * Entry timing recommendation
 */
export enum EntryTiming {
    IMMEDIATE = 'IMMEDIATE',           // Enter now
    WAIT_PULLBACK = 'WAIT_PULLBACK',   // Wait for X% pullback
    WAIT_CONFIRMATION = 'WAIT_CONFIRMATION', // Wait for level breakout
}

/**
 * Trend direction for multi-timeframe analysis
 */
export enum TrendDirection {
    UP = 'UP',
    DOWN = 'DOWN',
    SIDEWAYS = 'SIDEWAYS',
}

// ============================================================================
// FILTER & STRATEGY RESULTS
// ============================================================================

/**
 * Result from an analysis filter
 */
export interface FilterResult {
    /** Filter name for identification */
    filterName: string;

    /** 
     * Score from -1.0 (strong negative) to +1.0 (strong positive)
     * - Negative = bearish signal / don't trade
     * - Zero = neutral
     * - Positive = bullish signal / ok to trade
     */
    score: number;

    /** Confidence in this score (0.0 to 1.0) */
    confidence: number;

    /** Whether this filter passed (allows trading) */
    passed: boolean;

    /** Human-readable explanation */
    reason: string;

    /** Optional detailed metrics for debugging */
    details?: Record<string, number | string>;
}

/**
 * Result from an entry strategy
 */
export interface StrategyResult {
    /** Strategy name for identification */
    strategyName: string;

    /** 
     * Score from -1.0 (strong short) to +1.0 (strong long)
     */
    score: number;

    /** Confidence in this score (0.0 to 1.0) */
    confidence: number;

    /** Recommended direction based on this strategy */
    direction: TradeDirection;

    /** Human-readable explanation */
    reason: string;

    /** Optional detailed metrics */
    details?: Record<string, number | string>;
}

// ============================================================================
// ANALYSIS CONTEXT (Input)
// ============================================================================

/**
 * Aggregated candle data for a specific timeframe
 */
export interface TimeframeCandles {
    timeframe: '1m' | '5m' | '15m' | '1h';
    candles: SmartCandle[];
    trend: TrendDirection;
    atr: number;
    supportLevels: number[];
    resistanceLevels: number[];
}

/**
 * Multi-timeframe data structure
 */
export interface MultiTimeframeData {
    tf1m: TimeframeCandles;
    tf5m: TimeframeCandles;
    tf15m: TimeframeCandles;
    tf1h: TimeframeCandles;
}

/**
 * BTC reference data for correlation analysis
 */
export interface BTCReferenceData {
    currentPrice: number;
    priceChange1h: number;
    priceChange24h: number;
    candles: SmartCandle[];
}

/**
 * Full context passed to filters and strategies
 */
export interface AnalysisContext {
    /** Symbol being analyzed */
    symbol: string;

    /** Current price */
    currentPrice: number;

    /** Timestamp of analysis */
    timestamp: number;

    /** Raw 1-minute candles (up to 1000) */
    rawCandles: SmartCandle[];

    /** Multi-timeframe aggregated data */
    multiTF: MultiTimeframeData;

    /** BTC data for correlation */
    btcData: BTCReferenceData;

    /** Current funding rate */
    fundingRate: number;

    /** Accumulated liquidations in analysis window */
    liquidations: {
        longTotal: number;
        shortTotal: number;
        ratio: number; // long/short ratio
    };

    /** OI metrics */
    openInterest: {
        current: number;
        change1h: number;
        changePercent1h: number;
    };

    /** CVD metrics */
    cvd: {
        current: number;
        delta1h: number;
    };
}

// ============================================================================
// ANALYSIS RESULT (Output)
// ============================================================================

/**
 * Stop loss calculation result
 */
export interface StopLossResult {
    /** Stop loss price */
    price: number;

    /** Distance from entry in percent */
    distancePercent: number;

    /** Method used for calculation */
    method: 'ATR' | 'SWING' | 'LIQUIDATION_CLUSTER';

    /** Reasoning */
    reason: string;
}

/**
 * Entry timing result
 */
export interface EntryTimingResult {
    timing: EntryTiming;

    /** For WAIT_PULLBACK: target pullback percentage */
    pullbackPercent?: number;

    /** For WAIT_CONFIRMATION: level to break */
    confirmationLevel?: number;

    reason: string;
}

/**
 * Complete coin analysis result
 */
export interface CoinAnalysisResult {
    // === Core Result ===
    symbol: string;
    timestamp: Date;

    /** Final recommended direction */
    direction: TradeDirection;

    /** Overall confidence (0-100%) */
    confidence: number;

    /** Should trade or not */
    shouldTrade: boolean;

    // === Entry Details ===
    entryPrice: number;
    stopLoss: StopLossResult;
    entryTiming: EntryTimingResult;

    // === Market Context ===
    marketRegime: MarketRegime;
    trendAlignment: {
        tf5m: TrendDirection;
        tf15m: TrendDirection;
        tf1h: TrendDirection;
        aligned: boolean;
    };

    // === Component Scores (for transparency & adaptation) ===
    filterResults: FilterResult[];
    strategyResults: StrategyResult[];

    // === Summary ===
    summary: string;
}

// ============================================================================
// WEIGHT ADAPTATION
// ============================================================================

/**
 * Stored analysis for retrospective evaluation
 */
export interface StoredAnalysis {
    id: number;
    symbol: string;
    createdAt: Date;

    // Prediction
    predictedDirection: TradeDirection;
    predictedConfidence: number;
    entryPrice: number;

    // Component scores for weight adjustment
    filterScores: Record<string, number>;
    strategyScores: Record<string, number>;

    // Outcome (filled later)
    evaluatedAt?: Date;
    actualPriceAfter24h?: number;
    actualChangePercent?: number;
    wasCorrect?: boolean;
}

/**
 * Weight configuration for filters and strategies
 */
export interface ComponentWeights {
    filters: Record<string, number>;
    strategies: Record<string, number>;
    lastUpdated: Date;
}
