import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { RollingStats, clamp } from '../utils/rolling-stats';

const EPS = 1e-10;

export class MomentumModule extends BaseModule {
    readonly name = 'momentum' as const;
    private readonly config = MODULE_CONFIG.momentum;

    // === STATE MANAGEMENT ===
    private lastProcessedTime = 0;
    private lastClosedEmaDiff = 0;
    private currentTickEmaDiff = 0;

    // Adaptive volatility tracking
    private recentVolatility = new RollingStats(100);

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];
        const currentBar = bars[bars.length - 1];
        const currentPrice = currentBar.c;

        // ====================================================================
        // 1. STATE MANAGEMENT
        // ====================================================================
        if (currentBar.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.lastClosedEmaDiff = this.currentTickEmaDiff;
            }
            this.lastProcessedTime = currentBar.ts;
        }

        // ====================================================================
        // 2. Adaptive Dead Market Filter
        // ====================================================================
        const volatilityPct = (features.atr / currentPrice) * 100;
        this.recentVolatility.push(volatilityPct);
        const medianVol = this.recentVolatility.median();
        const adaptiveThreshold = Math.max(medianVol * 0.3, 0.01);

        if (volatilityPct < adaptiveThreshold) {
            tags.push('dead_market');
            return this.createOutput(0, 0.1, tags);
        }

        // ====================================================================
        // 3. Calculation of Momentum
        // ====================================================================
        const emaDiff = features.emaFast - features.emaSlow;
        this.currentTickEmaDiff = emaDiff;

        // Normalize
        const m = emaDiff / Math.max(features.emaSlow, EPS);
        let rawScore = this.scaledTanh(m, this.config.scaleFactor);

        // ====================================================================
        // 4. Mean Reversion Logic (Rubber Band Effect) - REFACTORED
        // ====================================================================
        
        // Deviation from "Mean" (Slow EMA) in ATR units
        const deviationFromMean = (currentPrice - features.emaSlow) / features.atr;
        
        // Threshold for Reversal. 2.5 ATR is statistically significant extension.
        const REVERSAL_THRESHOLD = 2.5;

        // SCENARIO A: Overbought -> Reversal Short
        if (deviationFromMean > REVERSAL_THRESHOLD) {
            tags.push('overbought_reversal');
            
            // Invert the signal. Instead of buying the top, we look for a mean reversion short.
            rawScore = -0.7; 
            
            // If volume is dropping while price is high = Exhaustion
            if (features.volZ < 0) {
                 rawScore = -0.85;
                 tags.push('exhaustion_short');
            }
        }
        // SCENARIO B: Oversold -> Reversal Long
        else if (deviationFromMean < -REVERSAL_THRESHOLD) {
            tags.push('oversold_reversal');
            
            // Invert the signal. Look for bounce.
            rawScore = 0.7; 
            
            if (features.volZ < 0) {
                 rawScore = 0.85;
                 tags.push('exhaustion_long');
            }
        }
        // SCENARIO C: Trending but Extended (1.5 - 2.5 ATR)
        else if (Math.abs(deviationFromMean) > 1.5) {
             // Don't reverse yet, but STOP chasing.
             rawScore *= 0.3; 
             tags.push('momentum_stalling');
        }

        // ====================================================================
        // 5. Dynamics Analysis (Acceleration)
        // ====================================================================
        let isAccelerating = false;
        if (Math.abs(this.lastClosedEmaDiff) > EPS) {
            isAccelerating = Math.abs(emaDiff) > Math.abs(this.lastClosedEmaDiff);
        }

        const isBullish = rawScore > 0;

        // Tags generation
        if (Math.abs(rawScore) > 0.2) {
            if (isBullish) {
                tags.push('bullish_structure');
                if (rawScore > 0.6) tags.push('strong_uptrend');
            } else {
                tags.push('bearish_structure');
                if (rawScore < -0.6) tags.push('strong_downtrend');
            }

            if (isAccelerating) {
                tags.push('momentum_accelerating');
            } else {
                tags.push('momentum_decaying');
                // If decaying, further reduce score
                rawScore *= 0.8; 
            }
        } else {
            tags.push('ranging_market');
        }

        // ====================================================================
        // 6. Reliability Calculation
        // ====================================================================
        let reliability = 0.5;

        // A. Volume logic
        if (features.volZ > 0.5) reliability += 0.15;
        if (features.volZ > 2.0) {
            reliability += 0.15;
            tags.push('high_volume_support');
        }
        
        // B. Reversal Bonus
        // If we are playing Mean Reversion, reliability is inherently higher if volume confirms
        if (tags.includes('overbought_reversal') || tags.includes('oversold_reversal')) {
            reliability += 0.1;
        }

        // C. Price Action Check
        const momentumDirectionMatchesPrice =
            (rawScore > 0 && currentPrice > features.emaSlow) ||
            (rawScore < 0 && currentPrice < features.emaSlow);

        // If we are NOT in reversal mode, we expect alignment
        if (!tags.includes('overbought_reversal') && !tags.includes('oversold_reversal')) {
             if (Math.abs(rawScore) > 0.3 && !momentumDirectionMatchesPrice) {
                tags.push('price_counter_trend');
                reliability -= 0.2;
            }
        }

        // D. Parabolic Setup (Only valid if NOT overextended)
        if (isAccelerating && features.volZ > 1.5 && Math.abs(deviationFromMean) < 1.5) {
            tags.push('parabolic_phase_start');
            reliability = Math.min(reliability + 0.2, 1.0);
        }

        if (Math.abs(rawScore) < 0.25) {
            reliability = 0.2;
        }

        reliability = clamp(reliability, 0, 1);
        return this.createOutput(rawScore, reliability, tags);
    }

    reset(): void {
        this.lastProcessedTime = 0;
        this.lastClosedEmaDiff = 0;
        this.currentTickEmaDiff = 0;
    }
}