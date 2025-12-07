import { ConfidenceLevel, Features } from '../types';
import { DEFAULT_CONFIG } from '../types/config';
import { AggregationResult } from './decision-aggregator';
import { clamp } from '../utils/rolling-stats';

export interface ConfidenceResult {
    confidence: number;
    confidenceLevel: ConfidenceLevel;
    penalties: number;
    penaltyReasons: string[];
}

export class ConfidenceCalculator {
    private readonly threshold: number;
    private readonly safetyConfig = DEFAULT_CONFIG.safety;
    private readonly confLevels = { low: 0.4, medium: 0.65 };

    constructor(threshold: number = DEFAULT_CONFIG.decision.threshold) {
        this.threshold = threshold;
    }

    calculate(
        aggregation: AggregationResult,
        features: Features,
        nearObstacleLevel: boolean = false,
        obstacleStrength: number = 1.0
    ): ConfidenceResult {
        const { rawScore, moduleAgreement } = aggregation;
        const penaltyReasons: string[] = [];
        let penalties = 0;
        let bonuses = 0;

        const rawAbs = Math.abs(rawScore);

        // 0. QUICK EXIT
        if (rawAbs < this.threshold) {
            return { confidence: 0, confidenceLevel: 'LOW', penalties: 0, penaltyReasons: ['below_threshold'] };
        }

        // 1. BASE CALCULATION
        let confBasic = (rawAbs - this.threshold) / (1 - this.threshold);
        confBasic = clamp(confBasic, 0, 1);
        let confidence = confBasic * (0.5 * moduleAgreement + 0.5 * rawAbs);

        const isLong = rawScore > 0;

        // 2. CONTEXTUAL ANALYSIS (UPDATED FOR REVERSAL STRATEGY)

        // A. Funding / Gap (Все еще актуально - не платим лишнего)
        const gap = features.lastPriceGap;
        if (isLong && gap > 0.005) {
             penalties += 0.1;
             penaltyReasons.push('high_premium_penalty');
        } else if (!isLong && gap < -0.005) {
             penalties += 0.1;
             penaltyReasons.push('high_discount_penalty');
        }

        // B. Liquidity Check (Safety first)
        if (features.volZ < -0.5) {
            penalties += 0.15;
            penaltyReasons.push('low_liquidity_risk');
        }

        // C. REVERSAL SYNERGY (BONUSES)
        // Если мы ловим разворот, и у нас есть подтверждение от Orderflow + Momentum -> БОНУС
        const isReversal = aggregation.rawScore > 0 
            ? (features.liquidationBias === -1 || features.absorptionBias === 1) // Long reversal
            : (features.liquidationBias === 1 || features.absorptionBias === -1); // Short reversal

        if (isReversal) {
            bonuses += 0.15;
            penaltyReasons.push('reversal_synergy_bonus'); // Technically a reason tag
        }

        // D. OBSTACLE HANDLING (INVERTED)
        // В трендовой стратегии мы боялись уровней.
        // В разворотной стратегии, если мы уже отскочили (сигнал сформирован), уровень нам помогает (как стоп).
        // Но если мы ПРЯМО В УРОВНЕ и сигнал "ПРОБОЙ" (которого у нас быть не должно), тогда штраф.
        if (nearObstacleLevel && !isReversal) {
             penalties += 0.1;
             penaltyReasons.push('fighting_level');
        }

        // 3. APPLY MODIFIERS
        confidence = clamp(confidence - penalties + bonuses, 0, 1);

        // 4. LEVEL DETERMINATION
        let confidenceLevel: ConfidenceLevel = 'LOW';
        if (confidence >= this.confLevels.medium) confidenceLevel = 'HIGH';
        else if (confidence >= this.confLevels.low) confidenceLevel = 'MEDIUM';

        return {
            confidence,
            confidenceLevel,
            penalties,
            penaltyReasons,
        };
    }
}