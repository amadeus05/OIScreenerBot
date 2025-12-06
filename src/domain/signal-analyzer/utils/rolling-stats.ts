/**
 * Signal Analyzer Module - Rolling Statistics Utility
 * Efficient rolling calculations for z-score, mean, std
 */

const EPS = 1e-10;

/**
 * Rolling statistics calculator with efficient incremental updates
 */
export class RollingStats {
    private window: number[];
    private readonly maxSize: number;

    constructor(windowSize: number) {
        this.maxSize = windowSize;
        this.window = [];
    }

    /**
     * Add a new value to the rolling window
     */
    push(value: number): void {
        this.window.push(value);
        if (this.window.length > this.maxSize) {
            this.window.shift();
        }
    }

    /**
     * Get current window values
     */
    getValues(): number[] {
        return [...this.window];
    }

    /**
     * Calculate rolling mean
     */
    mean(): number {
        if (this.window.length === 0) return 0;
        const sum = this.window.reduce((a, b) => a + b, 0);
        return sum / this.window.length;
    }

    /**
     * Calculate rolling standard deviation
     */
    std(): number {
        if (this.window.length < 2) return 0;
        const m = this.mean();
        const squaredDiffs = this.window.map(v => (v - m) ** 2);
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / this.window.length;
        return Math.sqrt(variance);
    }

    /**
     * Calculate z-score for a value relative to current window
     */
    zscore(value: number): number {
        const m = this.mean();
        const s = this.std();
        if (s < EPS) return 0;
        return (value - m) / s;
    }

    /**
     * Calculate rolling median
     */
    median(): number {
        if (this.window.length === 0) return 0;
        const sorted = [...this.window].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return sorted[mid];
    }

    /**
     * Get nth percentile value
     */
    percentile(p: number): number {
        if (this.window.length === 0) return 0;
        const sorted = [...this.window].sort((a, b) => a - b);
        const index = Math.ceil(p * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    /**
     * Get minimum value in window
     */
    min(): number {
        if (this.window.length === 0) return 0;
        return Math.min(...this.window);
    }

    /**
     * Get maximum value in window
     */
    max(): number {
        if (this.window.length === 0) return 0;
        return Math.max(...this.window);
    }

    /**
     * Check if window is full
     */
    isFull(): boolean {
        return this.window.length >= this.maxSize;
    }

    /**
     * Get current window size
     */
    size(): number {
        return this.window.length;
    }

    /**
     * Reset the window
     */
    reset(): void {
        this.window = [];
    }
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
export function calculateEMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    if (values.length < period) {
        // Use SMA if not enough data
        return values.reduce((a, b) => a + b, 0) / values.length;
    }

    const multiplier = 2 / (period + 1);

    // Start with SMA of first 'period' values
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // Calculate EMA for remaining values
    for (let i = period; i < values.length; i++) {
        ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
}

/**
 * Calculate ATR (Average True Range)
 */
export function calculateATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number
): number {
    if (closes.length < 2) return 0;

    const trueRanges: number[] = [];

    for (let i = 1; i < closes.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];

        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trueRanges.push(tr);
    }

    if (trueRanges.length === 0) return 0;

    // Use EMA-style ATR calculation
    return calculateEMA(trueRanges, period);
}

/**
 * Helper: Safe division
 */
export function safeDivide(numerator: number, denominator: number): number {
    if (Math.abs(denominator) < EPS) return 0;
    return numerator / denominator;
}

/**
 * Helper: Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Helper: Sigmoid function
 */
export function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}
