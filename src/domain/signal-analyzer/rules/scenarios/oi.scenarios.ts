// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/oi.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

export const OiScenarios: MarketScenario[] = [
    // 1. Классический Лонг (Trend Following)
    {
        id: 'long_buildup_trend',
        name: 'Long Build-up (Trend)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsUp,
            (f) => !P.Flow.IsStrongSelling(f),
            P.Trend.IsBullish // <--- 🔥 ЗАЩИТА: Только по тренду
        ],
        baseScore: 0.6,
        reliability: 0.7, 
        tags: ['oi_up', 'long_buildup', 'trend_aligned'],
        useStrengthMultiplier: true
    },
    // 1.1 Усиление дельтой
    {
        id: 'long_buildup_delta_confirmed',
        name: 'Long Build-up (Delta Confirmed)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsUp,
            P.Flow.IsBuying 
        ],
        baseScore: 0.2, 
        reliability: 0.2,
        tags: ['delta_confirmed'],
        useStrengthMultiplier: false
    },

    // 2. Медвежье Поглощение (Absorption) - РАЗВОРОТ
    {
        id: 'bearish_absorption_wall',
        name: 'Bearish Absorption (Ask Wall)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsUp,
            P.Flow.IsStrongBuying 
        ],
        baseScore: -0.9, 
        reliability: 0.5,
        tags: ['bearish_absorption', 'ask_wall_detected'],
        useStrengthMultiplier: false
    },

    // 3. Классический Шорт (Trend Following)
    {
        id: 'short_buildup_trend',
        name: 'Short Build-up (Trend)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsDown,
            (f) => !P.Flow.IsStrongBuying(f),
            P.Trend.IsBearish // <--- 🔥 ЗАЩИТА: Только по тренду
        ],
        baseScore: -0.6,
        reliability: 0.7,
        tags: ['oi_up', 'short_buildup', 'trend_aligned'],
        useStrengthMultiplier: true
    },

    // 4. Бычье Поглощение (Absorption) - РАЗВОРОТ
    {
        id: 'bullish_absorption_limit_bid',
        name: 'Bullish Absorption (Limit Bid)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsDown,
            P.Flow.IsBuying 
        ],
        baseScore: 0.8, 
        reliability: 0.4,
        tags: ['bullish_absorption', 'risky_reversal'],
        useStrengthMultiplier: false
    },

    // 5. Short Covering
    {
        id: 'short_covering',
        name: 'Short Covering',
        conditions: [
            P.OI.IsFalling,
            P.Price.IsUp
        ],
        baseScore: 0.3, 
        reliability: 0.5,
        tags: ['oi_down', 'short_covering'],
        useStrengthMultiplier: true
    },
    // 5.1 Panic Short Squeeze
    {
        id: 'panic_short_squeeze',
        name: 'Panic Short Squeeze',
        conditions: [
            P.OI.IsFalling,
            P.Price.IsUp,
            P.Flow.IsStrongBuying,
            (f, ctx) => P.Price.IsFastMove(f, ctx?.price || 1)
        ],
        baseScore: 0.8, 
        reliability: 0.8,
        tags: ['panic_short_squeeze'],
        useStrengthMultiplier: false 
    },

    // 6. Long Unwind
    {
        id: 'long_unwind',
        name: 'Long Unwind',
        conditions: [
            P.OI.IsFalling,
            P.Price.IsDown
        ],
        baseScore: -0.3,
        reliability: 0.5,
        tags: ['oi_down', 'long_unwind'],
        useStrengthMultiplier: true
    },
    // 6.1 Panic Long Cascade
    {
        id: 'panic_long_cascade',
        name: 'Panic Long Cascade',
        conditions: [
            P.OI.IsFalling,
            P.Price.IsDown,
            P.Flow.IsStrongSelling,
            (f, ctx) => P.Price.IsFastMove(f, ctx?.price || 1)
        ],
        baseScore: -0.8,
        reliability: 0.8,
        tags: ['panic_long_cascade'],
        useStrengthMultiplier: false
    }
];