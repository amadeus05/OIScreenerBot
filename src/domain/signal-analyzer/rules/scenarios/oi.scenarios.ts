// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/oi.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

export const OiScenarios: MarketScenario[] = [
    // --- 1. BEARISH DIVERGENCE (Цена растет, Интерес падает) ---
    // Это значит, что топлива для роста нет, рынок "сухой". Идеально для Шорта во флэте.
    {
        id: 'oi_bearish_div',
        name: 'Price Up / OI Down (Exhaustion)',
        conditions: [
            P.Price.IsUp,           // Цена растет
            P.OI.IsFalling,         // OI падает
            (f) => f.volZ < 2.0     // Нет аномального объема (это не пробой)
        ],
        baseScore: -0.65,           // Шорт сигнал
        reliability: 0.8,
        tags: ['oi_divergence', 'bearish_weakness'],
        useStrengthMultiplier: true
    },

    // --- 2. BULLISH DIVERGENCE (Цена падает, Интерес падает) ---
    // Продавцы закрываются, новых шортов нет. Рынок отпружинит вверх.
    {
        id: 'oi_bullish_div',
        name: 'Price Down / OI Down (Exhaustion)',
        conditions: [
            P.Price.IsDown,         // Цена падает
            P.OI.IsFalling,         // OI падает
            (f) => f.volZ < 2.0     // Нет панического слива
        ],
        baseScore: 0.65,            // Лонг сигнал
        reliability: 0.8,
        tags: ['oi_divergence', 'bullish_weakness'],
        useStrengthMultiplier: true
    },

    // --- 3. PUMP CONFIRMATION (Цена растет + OI растет) ---
    // Это оставим только для сильных трендов, во флэте вес будет снижен
    {
        id: 'oi_trend_pump',
        name: 'Pump with OI Support',
        conditions: [
            P.Price.IsUp,
            P.OI.IsRising,
            P.Flow.IsBuying
        ],
        baseScore: 0.5,
        reliability: 0.6,
        tags: ['oi_support', 'trend_pump'],
        useStrengthMultiplier: false
    }
];
