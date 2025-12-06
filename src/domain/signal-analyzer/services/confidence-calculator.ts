import { ConfidenceLevel, Features } from '../types';
import { DEFAULT_CONFIG } from '../types/config';
import { AggregationResult } from './decision-aggregator';
import { clamp } from '../utils/rolling-stats';

export interface ConfidenceResult {
    confidence: number;       // [0, 1]
    confidenceLevel: ConfidenceLevel;
    penalties: number;        // Total penalties applied
    penaltyReasons: string[];
}

export class ConfidenceCalculator {
    private readonly threshold: number;
    private readonly safetyConfig = DEFAULT_CONFIG.safety;

    // Конфигурация порогов уверенности
    private readonly confLevels = {
        low: 0.4,
        medium: 0.65 // Снижено с 0.75, так как штрафы могут быть жесткими
    };

    constructor(threshold: number = DEFAULT_CONFIG.decision.threshold) {
        this.threshold = threshold;
    }

    /**
     * Calculate confidence from aggregation result
     * @param aggregation Результат агрегации сигналов
     * @param features Рыночные фичи
     * @param nearObstacleLevel True, если цена уперлась в препятствие
     * @param obstacleStrength Сила препятствия [0..1] (1.0 = Major Level)
     */
    calculate(
        aggregation: AggregationResult,
        features: Features,
        nearObstacleLevel: boolean = false,
        obstacleStrength: number = 1.0
    ): ConfidenceResult {
        const { rawScore, moduleAgreement } = aggregation;
        const penaltyReasons: string[] = [];
        let penalties = 0;

        const rawAbs = Math.abs(rawScore);

        // 0. QUICK EXIT
        // Если сигнал слишком слаб, нет смысла считать детали
        if (rawAbs < this.threshold) {
            return {
                confidence: 0,
                confidenceLevel: 'LOW',
                penalties: 0,
                penaltyReasons: ['below_threshold']
            };
        }

        // 1. BASE CALCULATION
        let confBasic = (rawAbs - this.threshold) / (1 - this.threshold);
        confBasic = clamp(confBasic, 0, 1);

        // Учитываем силу сигнала и согласие модулей
        let confidence = confBasic * (0.6 * moduleAgreement + 0.4 * rawAbs);

        // 2. CONTEXTUAL PENALTIES
        const isLong = rawScore > 0;

        // --- A. Obstacle Penalty (Trading into structure) ---
        if (nearObstacleLevel) {
            // Штраф зависит от силы уровня.
            // Слабый уровень (0.5) -> штраф 0.075. Сильный (1.0) -> штраф 0.15.
            const strengthMult = clamp(obstacleStrength, 0.5, 1.5);
            const obsPenalty = 0.15 * strengthMult;

            penalties += obsPenalty;
            penaltyReasons.push(`obstacle_penalty_str_${obstacleStrength.toFixed(1)}`);
        }

        // --- B. Funding / Gap Penalty (Adverse pricing) ---
        const gap = features.lastPriceGap; // (Price - Mark) / Price
        const gapThreshold = this.safetyConfig.fundingPenaltyThreshold || 0.005;

        // Штрафуем только если мы платим за вход по невыгодной цене
        if (isLong && gap > gapThreshold) {
            penalties += 0.12;
            penaltyReasons.push('high_premium_penalty');
        } else if (!isLong && gap < -gapThreshold) {
            penalties += 0.12;
            penaltyReasons.push('high_discount_penalty');
        }

        // --- C. Liquidity Risk ---
        if (features.volZ < -1.0) {
            penalties += 0.1;
            penaltyReasons.push('low_liquidity');
        }

        // --- D. Liquidation Analysis (Bias & Direction) ---
        if (features.liquidationSignal) {
            const liqBias = features.liquidationBias; // 1 = Bullish/Squeeze, -1 = Bearish/Cascade

            if (liqBias !== undefined && liqBias !== 0) {
                // Если мы Long, а рынок валится на ликвидациях лонгов (Cascade) -> ОПАСНО
                if (isLong && liqBias < 0) {
                    penalties += 0.25;
                    penaltyReasons.push('fighting_long_cascade');
                }
                // Если мы Short, а рынок летит на стопах шортистов (Squeeze) -> ОПАСНО
                else if (!isLong && liqBias > 0) {
                    penalties += 0.25;
                    penaltyReasons.push('fighting_short_squeeze');
                }
                // Если ликвидации в нашу сторону (bias совпадает с isLong), штрафа нет.
                // Это "Топливо". Можно было бы даже добавить бонус, но ConfidenceCalculator работает на вычитание.
            } else {
                // Сигнал есть, но направление неясно (шум) -> Небольшой штраф за риск волатильности
                penalties += 0.08;
                penaltyReasons.push('liquidation_volatility_risk');
            }
        }

        // --- E. Absorption Analysis (Walls) ---
        if (features.absorptionFlag) {
            const absBias = features.absorptionBias; // 1 = Bid Support, -1 = Ask Resistance

            if (absBias !== undefined && absBias !== 0) {
                // Если мы Long, а сверху Ask Wall (absBias < 0) -> ПЛОХО
                if (isLong && absBias < 0) {
                    penalties += 0.15;
                    penaltyReasons.push('hitting_ask_wall');
                }
                // Если мы Short, а снизу Bid Support (absBias > 0) -> ПЛОХО
                else if (!isLong && absBias > 0) {
                    penalties += 0.15;
                    penaltyReasons.push('hitting_bid_wall');
                }
                // Если стена за нас (поддержка при лонге) -> Отлично, штрафа нет.
            } else {
                // Неопределенное поглощение -> Риск разворота
                penalties += 0.08;
                penaltyReasons.push('absorption_risk_unclear');
            }
        }

        // 3. APPLY PENALTIES
        // Ограничиваем максимальный штраф, чтобы не уходить в глубокий минус,
        // но если штраф > 0.8, сделка мертва в любом случае.
        const effectivePenalties = Math.min(penalties, 0.8);

        confidence = clamp(confidence - effectivePenalties, 0, 1);

        // 4. LEVEL DETERMINATION
        let confidenceLevel: ConfidenceLevel;

        // Если после всех штрафов уверенность упала ниже плинтуса
        if (confidence < 0.2) {
            confidenceLevel = 'LOW'; // Или даже можно ввести 'NONE'
        } else if (confidence < this.confLevels.low) {
            confidenceLevel = 'LOW';
        } else if (confidence < this.confLevels.medium) {
            confidenceLevel = 'MEDIUM';
        } else {
            confidenceLevel = 'HIGH';
        }

        return {
            confidence,
            confidenceLevel,
            penalties: effectivePenalties,
            penaltyReasons,
        };
    }
}