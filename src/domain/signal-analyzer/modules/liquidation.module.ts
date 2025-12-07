import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG, DEFAULT_CONFIG } from '../types/config';
import { BaseModule } from './base-module';

export class LiquidationModule extends BaseModule {
    readonly name = 'liquidations' as const;

    private readonly config = MODULE_CONFIG.liquidations;
    private readonly historySize = 1000;
    
    private historyIntensityLong: number[] = [];
    private historyIntensityShort: number[] = [];
    private lastProcessedTs = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];
        if (bars.length < 15) {
            return this.createOutput(0, 0.3, tags);
        }

        const currentBar = bars[bars.length - 1];
        const prevBar = bars[bars.length - 2];

        // 1. HISTORY MANAGEMENT
        if (currentBar.ts > this.lastProcessedTs) {
            if (this.lastProcessedTs !== 0) {
                const prevOI = prevBar.oi || prevBar.v || 1;
                const normLong = (prevBar.liquidations?.long || 0) / prevOI;
                const normShort = (prevBar.liquidations?.short || 0) / prevOI;

                this.historyIntensityLong.push(normLong);
                this.historyIntensityShort.push(normShort);

                if (this.historyIntensityLong.length > this.historySize) {
                    this.historyIntensityLong.shift();
                    this.historyIntensityShort.shift();
                }
            }
            this.lastProcessedTs = currentBar.ts;
        }

        // 2. METRICS
        const currentOI = currentBar.oi || currentBar.v || 1;
        const liqs = currentBar.liquidations || { long: 0, short: 0, countLong: 0, countShort: 0, maxLong: 0, maxShort: 0 };

        const intensityLong = liqs.long / currentOI;
        const intensityShort = liqs.short / currentOI;

        const threshLong = this.historyIntensityLong.length > 50
            ? this.calculatePercentile(this.historyIntensityLong, 0.98)
            : Infinity;
        const threshShort = this.historyIntensityShort.length > 50
            ? this.calculatePercentile(this.historyIntensityShort, 0.98)
            : Infinity;

        const isHugeLong = intensityLong > threshLong;
        const isHugeShort = intensityShort > threshShort;

        // 3. VELOCITY
        const getSumLiq = (n: number, type: 'short' | 'long') => {
            return bars.slice(-n).reduce((acc, b) => acc + (b.liquidations?.[type] || 0), 0);
        };
        const shortVol3m = getSumLiq(3, 'short');
        const shortVol10m = getSumLiq(10, 'short');
        const rateShort3m = shortVol3m / 3;
        const rateShort10m = shortVol10m / 10;
        const isShortCascadeAccel = rateShort3m > (rateShort10m * 2.5) && isHugeShort;

        const longVol3m = getSumLiq(3, 'long');
        const longVol10m = getSumLiq(10, 'long');
        const rateLong3m = longVol3m / 3;
        const rateLong10m = longVol10m / 10;
        const isLongCascadeAccel = rateLong3m > (rateLong10m * 2.5) && isHugeLong;

        // ====================================================================
        // 4. SCORING (SMART REVERSAL LOGIC)
        // ====================================================================
        let score = 0;
        let reliability = 0.5;

        // --- A. Short Squeeze Analysis ---
        if (isHugeShort && !isHugeLong) {
            tags.push('high_short_liq_intensity');

            if (isShortCascadeAccel) {
                // CLIMAX DETECTION:
                // If Volume is Extreme (>3 Z-Score) OR we see Absorption
                // It means the squeeze is ending. REVERSE.
                if (features.volZ > 3.0 || features.absorptionFlag) {
                    score = -0.8; // SELL INTO THE SQUEEZE
                    reliability = 0.9;
                    tags.push('short_squeeze_climax_reversal');
                } else {
                    // Early stage squeeze
                    score = 0.6;
                    reliability = 0.7;
                    tags.push('short_cascade_acceleration');
                }
            } else {
                score = 0.4;
                reliability = 0.5;
            }
        }

        // --- B. Long Flush Analysis ---
        else if (isHugeLong && !isHugeShort) {
            tags.push('high_long_liq_intensity');

            if (isLongCascadeAccel) {
                // CLIMAX DETECTION:
                // Panic selling + High Volume/Absorption = Bottom.
                if (features.volZ > 3.0 || features.absorptionFlag) {
                    score = 0.8; // BUY THE DIP
                    reliability = 0.9;
                    tags.push('long_cascade_climax_reversal');
                } else {
                    // Falling knife
                    score = -0.6;
                    reliability = 0.7;
                    tags.push('long_cascade_acceleration');
                }
            } else {
                score = -0.4;
                reliability = 0.5;
            }
        }

        // --- C. Conflict / Chop ---
        else if (isHugeLong && isHugeShort) {
            score = 0;
            tags.push('bi_directional_rekt');
            reliability = 0.2;
        }

        // 5. ACCUMULATION ANALYSIS (15m Bias)
        const shortBias15m = getSumLiq(15, 'short');
        const longBias15m = getSumLiq(15, 'long');
        const priceOpen15m = bars[bars.length - 15]?.o || currentBar.o;
        const priceMoveInAtr = features.atr > 0 ? (currentBar.c - priceOpen15m) / features.atr : 0;
        
        // Grinding Up logic...
        const accumulatedThresholdShort = threshShort * 5 * currentOI;
        const isGrindingUp = shortBias15m > longBias15m * 3 && shortBias15m > accumulatedThresholdShort;

        if (isGrindingUp) {
            // Price rising slowly on high short liquidations
            if (priceMoveInAtr > 0.2 && priceMoveInAtr < 1.0) {
                 score = Math.max(score, 0.6); // Fuel for trend
                 tags.push('short_fuel_grinding_up');
            } else if (priceMoveInAtr < 0.1) {
                 // High liqs but no price move = Absorption/Wall
                 score = -0.7; // Reversal
                 tags.push('bullish_absorption_wall_reversal');
            }
        }

        if (Math.abs(score) > 0.5) {
            features.liquidationSignal = true;
        }

        return this.createOutput(score, reliability, tags);
    }

    private calculatePercentile(values: number[], p: number): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.ceil(p * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    reset(): void {
        this.historyIntensityLong = [];
        this.historyIntensityShort = [];
        this.lastProcessedTs = 0;
    }
}