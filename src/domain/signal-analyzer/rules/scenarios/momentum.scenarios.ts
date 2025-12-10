// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/momentum.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

export const MomentumScenarios: MarketScenario[] = [
    // 1. MEAN REVERSION (Резинка растянулась)
    // Цена улетела слишком далеко от средней -> Ждем разворот
    {
        id: 'overbought_reversal',
        name: 'Overbought Reversal (Mean Reversion)',
        conditions: [
            P.Momentum.IsOverbought // > 2.5 ATR
        ],
        baseScore: -0.7, // Short против тренда
        reliability: 0.6,
        tags: ['overbought_reversal', 'mean_reversion'],
        useStrengthMultiplier: false
    },
    {
        id: 'oversold_reversal',
        name: 'Oversold Reversal (Mean Reversion)',
        conditions: [
            P.Momentum.IsOversold // < -2.5 ATR
        ],
        baseScore: 0.7, // Long против тренда
        reliability: 0.6,
        tags: ['oversold_reversal', 'mean_reversion'],
        useStrengthMultiplier: false
    },

    // 2. EXHAUSTION (Истощение)
    // Растянулись + Объем падает (нет сил толкать дальше)
    {
        id: 'exhaustion_short',
        name: 'Exhaustion Top',
        conditions: [
            P.Momentum.IsOverbought,
            (f) => f.volZ < 0 // Объем ниже среднего
        ],
        baseScore: -0.2, // Добавка к основному развороту
        reliability: 0.8,
        tags: ['exhaustion_short'],
        useStrengthMultiplier: false
    },

    // 3. PARABOLIC ACCELERATION
    // Ускоряемся + Высокий объем + НЕ перегреты. Это начало параболы.
    {
        id: 'parabolic_start',
        name: 'Parabolic Move Start',
        conditions: [
            P.Momentum.IsAccelerating,
            P.Vol.IsHigh,
            (f, ctx) => !P.Momentum.IsExtended(f, ctx) // Еще не улетели далеко
        ],
        baseScore: 0.3, // Boost trend
        reliability: 0.8,
        tags: ['parabolic_phase_start'],
        useStrengthMultiplier: true
    }
];