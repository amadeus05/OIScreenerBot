/**
 * Signal Analyzer Module - Core Types
 * Isolated module for trading signal generation
 */

// ============================================================================
// INPUT TYPES
// ============================================================================

/**
 * Raw 1-minute bar data from market data provider
 */
export interface BarData {
    symbol: string;
    ts: number;  // timestamp ms

    // OHLCV
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;

    // Indicators
    delta: number;      // candleDelta (aggressive buys - sells)
    cvd: number;        // Cumulative Volume Delta
    oi: number;         // Open Interest
    funding: number;    // Funding Rate
    lastPrice: number;  // Last traded price

    // Liquidations
    liquidations: {
        long: number;       // Accumulated volume ($)
        short: number;
        countLong: number;
        countShort: number;
        maxLong: number;    // Largest single liquidation
        maxShort: number;
    };
}

/**
 * Aggregated bar for higher timeframes (5m, 15m)
 */
export interface AggregatedBar extends BarData {
    timeframe: Timeframe;
    barCount: number;  // How many 1m bars were aggregated
}

export type Timeframe = '1m' | '5m' | '15m';

// ============================================================================
// COMPUTED FEATURES
// ============================================================================

/**
 * Derived features computed from raw bars
 */
export interface Features {
    // Basic computed
    buyVol: number;        // (volume + delta) / 2
    sellVol: number;       // (volume - delta) / 2
    flowImb: number;       // delta / max(volume, eps) ∈ (-1, 1)

    // Z-scores (normalized)
    volZ: number;          // zscore(volume, window)
    deltaZ: number;        // zscore(delta, window)

    // Deltas
    dCVD: number;          // CVD - CVD.shift(k)
    dOI: number;           // OI - OI.shift(k)
    oiFlow: number;        // dOI / rolling_mean(OI)

    // Price
    priceReturn: number;   // (close - open) / open
    lastPriceGap: number;  // (lastPrice - close) / close

    // Technical
    atr: number;           // ATR(14)
    emaFast: number;       // EMA(8)
    emaSlow: number;       // EMA(21)

    // Flags
    liquidationSignal: boolean;
    absorptionFlag: boolean;

    // Optional bias indicators for directional context
    liquidationBias?: number;   // 1 = bullish (short squeeze), -1 = bearish (long cascade), 0 = neutral
    absorptionBias?: number;    // 1 = bid support (bullish), -1 = ask resistance (bearish), 0 = neutral
    oi?: number;                // Current Open Interest (raw value from bar)
}

/**
 * Multi-timeframe features context
 */
export interface MultiTimeframeFeatures {
    tf1m: Features;
    tf5m: Features;
    tf15m: Features;
}

// ============================================================================
// MODULE OUTPUTS
// ============================================================================

/**
 * Output from individual analysis module
 */
export interface ModuleOutput {
    name: ModuleName;
    score: number;        // ∈ [-1, 1], positive = bullish
    reliability: number;  // ∈ [0, 1], confidence in this module's output
    tags: string[];       // Reason tags for this signal
}

export type ModuleName =
    | 'momentum'
    | 'orderflow'
    | 'oi'
    | 'liquidations'
    | 'levels';

// ============================================================================
// SIGNAL OUTPUT
// ============================================================================

export type TradeAction = 'LONG' | 'SHORT' | 'NO_TRADE';
export type EntryType = 'market' | 'limit';

/**
 * Final signal result from the analyzer
 */
export interface SignalResult {
    ts: string;               // ISO timestamp
    symbol: string;
    action: TradeAction;

    // Entry details
    entryType: EntryType;
    entryPrice: number;

    // Risk management
    sl: number;               // Stop Loss price
    tp: number[];             // Take Profit targets
    tpPct: number[];          // TP as % from entry

    // Timing
    horizonMin: number;       // Expected trade duration (minutes)

    // Confidence
    confidence: number;       // ∈ [0, 1]
    confidenceLevel: ConfidenceLevel;

    // Module breakdown
    modules: Record<ModuleName, number>;
    reasonTags: string[];

    // Position sizing
    riskPct: number;          // Risk as % of equity

    // Debug/meta
    meta: {
        rawScore: number;
        moduleAgreement: number;
        [key: string]: any;
    };
}

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

// ============================================================================
// SWING / LEVEL DETECTION
// ============================================================================

/**
 * Enhanced swing point with touch tracking and decay support
 */
export interface SwingPoint {
    id: string;              // Unique identifier for robust removal
    ts: number;              // Initial detection timestamp
    price: number;
    type: 'high' | 'low';
    strength: number;        // ∈ [0, 1] - composite strength

    // Touch tracking
    touchCount: number;      // Times level was tested
    lastTouchTs: number;     // Last test timestamp
    touchPrices: number[];   // Price at each touch (for bounce analysis)
    touchVolumes: number[];  // Volume at each touch

    // Bounce analysis
    avgBounce: number;       // Average bounce magnitude (in ATR)
    maxBounce: number;       // Largest bounce from this level

    // Metadata
    createdAt: number;       // First detection timestamp
    confirmedAt: number;     // When it became "confirmed" (3+ touches)
}

/**
 * Aggregated price level for analysis
 */
export interface PriceLevel {
    price: number;
    type: 'support' | 'resistance';
    strength: number;        // ∈ [0, 1]
    timesTestedCount: number;
    lastTestedTs: number;
    isConfirmed: boolean;    // Has 3+ touches
    isFresh: boolean;        // Recently created (< 30 bars old)
}

/**
 * Multi-level context for decision making
 */
export interface LevelContext {
    nearestSupport: PriceLevel | null;
    nearestResistance: PriceLevel | null;
    nextSupport: PriceLevel | null;      // Second nearest support
    nextResistance: PriceLevel | null;   // Second nearest resistance
    inConsolidation: boolean;            // Between tight S/R levels
    distanceToNearestPct: number;        // % distance to nearest level
    roomToMove: number;                  // Distance to next level (in ATR)
}

