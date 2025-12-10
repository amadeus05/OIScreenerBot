// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/liquidation.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

export const LiquidationScenarios: MarketScenario[] = [
    // 1. SHORT SQUEEZE (Ранняя стадия)
    // Много ликвидаций шортов + Ускорение + Нет экстремального объема (еще не конец)
    {
        id: 'short_squeeze_accel',
        name: 'Short Squeeze Acceleration',
        conditions: [
            P.Liq.IsHighShort,
            P.Liq.IsCascadeAccel,
            (f) => !P.Vol.IsExtreme(f) // Если объем экстремальный - это может быть климаксом
        ],
        baseScore: 0.6, // Long
        reliability: 0.7,
        tags: ['short_cascade_acceleration', 'high_short_liq_intensity'],
        useStrengthMultiplier: false
    },

    // 2. SHORT SQUEEZE CLIMAX (Разворот)
    // Шорты горят + Экстремальный объем/Абсорбция = Конец движения
    {
        id: 'short_squeeze_climax',
        name: 'Short Squeeze Climax (Reversal)',
        conditions: [
            P.Liq.IsHighShort,
            P.Liq.IsCascadeAccel,
            (f) => P.Vol.IsExtreme(f) || f.absorptionFlag // Кульминация
        ],
        baseScore: -0.8, // Short (Reversal)
        reliability: 0.9,
        tags: ['short_squeeze_climax_reversal'],
        useStrengthMultiplier: false
    },

    // 3. LONG CASCADE (Ранняя стадия)
    // Много ликвидаций лонгов + Ускорение
    {
        id: 'long_cascade_accel',
        name: 'Long Cascade Acceleration',
        conditions: [
            P.Liq.IsHighLong,
            P.Liq.IsCascadeAccel,
            (f) => !P.Vol.IsExtreme(f)
        ],
        baseScore: -0.6, // Short
        reliability: 0.7,
        tags: ['long_cascade_acceleration', 'high_long_liq_intensity'],
        useStrengthMultiplier: false
    },

    // 4. LONG CASCADE CLIMAX (Разворот - Buy the Dip)
    // Лонги горят + Паника (объем) = Дно
    {
        id: 'long_cascade_climax',
        name: 'Long Cascade Climax (Reversal)',
        conditions: [
            P.Liq.IsHighLong,
            P.Liq.IsCascadeAccel,
            (f) => P.Vol.IsExtreme(f) || f.absorptionFlag
        ],
        baseScore: 0.8, // Long (Buy the dip)
        reliability: 0.9,
        tags: ['long_cascade_climax_reversal'],
        useStrengthMultiplier: false
    },

    // 5. GRINDING UP (Топливо)
    // Цена медленно ползет вверх на ликвидациях шортов (нет импульса, но есть топливо)
    {
        id: 'grinding_up_fuel',
        name: 'Grinding Up (Short Fuel)',
        conditions: [
            P.Liq.IsGrindingUp,
            P.Price.IsUp
        ],
        baseScore: 0.6,
        reliability: 0.6,
        tags: ['short_fuel_grinding_up'],
        useStrengthMultiplier: false
    }
];