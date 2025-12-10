// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/levels.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

export const LevelsScenarios: MarketScenario[] = [
    // 1. SFP (SWING FAILURE PATTERN) - Smart Money Reversal
    // Ложный пробой уровня. Самый сильный сигнал в боковике.
    {
        id: 'resistance_sfp',
        name: 'Resistance SFP (Bearish Reversal)',
        conditions: [
            P.Level.IsResSFP 
        ],
        baseScore: -0.8, // Strong Short
        reliability: 0.8, // High Reliability
        tags: ['resistance_SFP_rejection', 'smart_money_reversal'],
        useStrengthMultiplier: false
    },
    {
        id: 'support_sfp',
        name: 'Support SFP (Bullish Reversal)',
        conditions: [
            P.Level.IsSupSFP 
        ],
        baseScore: 0.8, // Strong Long
        reliability: 0.8, 
        tags: ['support_SFP_rejection', 'smart_money_reversal'],
        useStrengthMultiplier: false
    },

    // 2. BREAKOUTS (Пробои)
    // Пробой уровня с подтверждением объема.
    {
        id: 'resistance_breakout',
        name: 'Resistance Breakout (Bullish)',
        conditions: [
            P.Level.IsResBreakout,
            (f) => !P.Vol.IsLow(f) // Пробой без объема - подозрительно
        ],
        baseScore: 0.5,
        reliability: 0.6,
        tags: ['resistance_breakout'],
        useStrengthMultiplier: false
    },
    // Бонус за объем при пробое
    {
        id: 'breakout_vol_bonus',
        name: 'Breakout Volume Confirmation',
        conditions: [
            (f, ctx) => P.Level.IsResBreakout(f, ctx) || P.Level.IsSupBreakdown(f, ctx),
            P.Level.IsVolConfirmed
        ],
        baseScore: 0.2, // Добавка к силе
        reliability: 0.2,
        tags: ['volume_breakout'],
        useStrengthMultiplier: false
    },

    {
        id: 'support_breakdown',
        name: 'Support Breakdown (Bearish)',
        conditions: [
            P.Level.IsSupBreakdown,
            (f) => !P.Vol.IsLow(f)
        ],
        baseScore: -0.5,
        reliability: 0.6,
        tags: ['support_breakdown'],
        useStrengthMultiplier: false
    },

    // 3. PROXIMITY BOUNCE (Отскок от уровня)
    // Мы рядом с уровнем, но не пробиваем его -> Ожидаем отскок.
    // Работает только если нет сигнала пробоя или SFP.
    {
        id: 'bounce_resistance',
        name: 'Bounce from Resistance',
        conditions: [
            P.Level.IsNearRes,
            (f, ctx) => !P.Level.IsResBreakout(f, ctx) && !P.Level.IsResSFP(f, ctx)
        ],
        baseScore: -0.3, // Short (Limit Sell Wall expected)
        reliability: 0.5,
        tags: ['near_resistance', 'potential_bounce'],
        useStrengthMultiplier: false
    },
    {
        id: 'bounce_support',
        name: 'Bounce from Support',
        conditions: [
            P.Level.IsNearSup,
            (f, ctx) => !P.Level.IsSupBreakdown(f, ctx) && !P.Level.IsSupSFP(f, ctx)
        ],
        baseScore: 0.3, // Long (Limit Buy Wall expected)
        reliability: 0.5,
        tags: ['near_support', 'potential_bounce'],
        useStrengthMultiplier: false
    },

    // 4. CONSOLIDATION BONUS
    // В консолидации уровни работают лучше
    {
        id: 'consolidation_bonus',
        name: 'Consolidation Reliability Boost',
        conditions: [
            P.Level.IsConsolidation
        ],
        baseScore: 0, // Не меняет направление
        reliability: 0.2, // Но повышает доверие к уровням
        tags: ['in_consolidation'],
        useStrengthMultiplier: false
    }
];