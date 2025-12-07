import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { sigmoid, clamp } from '../utils/rolling-stats';

export class OrderflowModule extends BaseModule {
    readonly name = 'orderflow' as const;
    private readonly config = MODULE_CONFIG.orderflow;

    private dCVDHistory: number[] = [];
    private readonly historySize = 50;
    private lastProcessedTime = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];
        const currentBar = bars[bars.length - 1];

        // 1. VALIDATION
        if (!currentBar || typeof features.flowImb !== 'number' || typeof features.dCVD !== 'number') {
            return this.createOutput(0, 0, ['no_data']);
        }

        // 2. STATE MANAGEMENT
        if (currentBar.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.dCVDHistory.push(features.dCVD);
                if (this.dCVDHistory.length > this.historySize) {
                    this.dCVDHistory.shift();
                }
            }
            this.lastProcessedTime = currentBar.ts;
        }

        // 3. CALCULATION
        const flowNorm = clamp(features.flowImb, -1, 1);
        
        // dCVD Normalization
        const rawStd = this.calculateStd(this.dCVDHistory);
        // Noise floor protection
        const minStd = Math.max(features.buyVol * 0.05, 5000); // Increased floor
        const effectiveStd = Math.max(rawStd, minStd);
        const dCVDNorm = features.dCVD / effectiveStd;
        const dCVDComponent = clamp((sigmoid(dCVDNorm) * 2) - 1, -1, 1);

        // Volume Component
        const volSign = Math.abs(flowNorm) > 0.1 ? Math.sign(flowNorm) : 0;
        const volComponent = clamp(features.volZ, -2, 2) * volSign;

        // 4. SCORING (Standard)
        const rawScore =
            this.config.flowWeight * flowNorm +
            this.config.dcvdWeight * dCVDComponent +
            this.config.volZWeight * volComponent;

        let score = Math.tanh(this.config.tanhScale * rawScore);
        let reliability = 0.6;
        const priceRet = features.priceReturn;

        // ====================================================================
        // 5. ABSORPTION / DIVERGENCE LOGIC (Priority Overrides)
        // ====================================================================
        
        // Significant Delta Threshold (e.g., 2 standard deviations or absolute high value)
        const isSignificantDelta = Math.abs(features.dCVD) > effectiveStd * 1.5;
        const isSignificantVolume = features.volZ > 1.0;

        // SCENARIO 1: HIDDEN SELLING WALL (Absorption)
        // CVD is rising (buying), but Price is falling or flat.
        // Limit sellers are absorbing market buys.
        if (features.dCVD > 0 && priceRet <= 0.0002 && isSignificantDelta) {
            tags.push('hidden_selling_wall');
            
            // Override score to SHORT
            score = -0.85; 
            reliability = 0.9; // Very high confidence pattern
        }

        // SCENARIO 2: HIDDEN BUYING WALL (Absorption)
        // CVD is falling (selling), but Price is rising or flat.
        // Limit buyers are absorbing market sells.
        else if (features.dCVD < 0 && priceRet >= -0.0002 && isSignificantDelta) {
            tags.push('hidden_buying_wall');
            
            // Override score to LONG
            score = 0.85;
            reliability = 0.9;
        }

        // SCENARIO 3: CONVERGENCE (Confirmation)
        else if (Math.sign(priceRet) === Math.sign(features.dCVD) &&
            Math.abs(priceRet) > 0.001 &&
            Math.abs(features.dCVD) > effectiveStd * 0.5) {
            tags.push('flow_price_aligned');
            reliability += 0.15;
            // Keep calculated score
        }

        // Volume checks
        if (features.volZ > 2.0) {
            tags.push('high_volume_significance');
            reliability += 0.1;
        } else if (features.volZ < -0.5) {
            tags.push('low_volume_noise');
            reliability -= 0.1;
        }

        reliability = clamp(reliability, 0.1, 1.0);
        return this.createOutput(score, reliability, tags);
    }

    private calculateStd(values: number[]): number {
        if (values.length < 2) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const sumSqDiff = values.reduce((sum, val) => sum + (val - mean) ** 2, 0);
        return Math.sqrt(sumSqDiff / (values.length - 1));
    }

    reset(): void {
        this.dCVDHistory = [];
        this.lastProcessedTime = 0;
    }
}