// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/regime.scenarios.ts
// ========================================================================

import { Features } from '../../types';
import { ModuleWeights, DEFAULT_CONFIG } from '../../types/config';
import { Predicates as P } from '../predicates';
import { MarketRegime } from '../../services/regime-supervisor';

export interface RegimeScenario {
    id: string;
    regime: MarketRegime;
    priority: number; // 100 = Highest (Panic), 0 = Lowest (Default)
    conditions: ((f: Features, currentPrice: number) => boolean)[];
    weights: ModuleWeights;
}

// Вспомогательные веса (чтобы не дублировать)
const VOLATILE_WEIGHTS: ModuleWeights = { 
    orderflow: 0.30, liquidations: 0.50, levels: 0.10, momentum: 0.00, oi: 0.10 
};
const TRENDING_WEIGHTS: ModuleWeights = { 
    orderflow: 0.30, liquidations: 0.10, levels: 0.15, momentum: 0.30, oi: 0.15 
};
const RANGING_WEIGHTS: ModuleWeights = { 
    orderflow: 0.40, liquidations: 0.10, levels: 0.35, momentum: 0.05, oi: 0.10 
};

export const RegimeScenarios: RegimeScenario[] = [
    // 1. VOLATILE (Паника, Сквизы) - Высший приоритет
    {
        id: 'volatile_panic',
        regime: 'VOLATILE',
        priority: 100,
        conditions: [
            (f) => P.Vol.IsExtreme(f),     // Z-Score > 2.0
            (f) => P.OI.IsSignificant(f)   // Резкие изменения ОИ
        ],
        weights: VOLATILE_WEIGHTS
    },
    {
        id: 'volatile_atr_explosion',
        regime: 'VOLATILE',
        priority: 90,
        conditions: [
            // Если ATR > 0.5% от цены (очень грубая оценка, можно настроить)
            (f, price) => (f.atr / price) > 0.005 
        ],
        weights: VOLATILE_WEIGHTS
    },

    // 2. TRENDING (Направленное движение)
    {
        id: 'strong_uptrend',
        regime: 'TRENDING',
        priority: 50,
        conditions: [
            (f, price) => P.Price.IsAboveEmaSlow(f, { currentPrice: price }),
            (f) => P.Momentum.IsAccelerating(f, { lastClosedEmaDiff: 0 }) // Упрощенная проверка
        ],
        weights: TRENDING_WEIGHTS
    },
    {
        id: 'strong_downtrend',
        regime: 'TRENDING',
        priority: 50,
        conditions: [
            (f, price) => P.Price.IsBelowEmaSlow(f, { currentPrice: price }),
            (f) => P.Momentum.IsAccelerating(f, { lastClosedEmaDiff: 0 })
        ],
        weights: TRENDING_WEIGHTS
    },

    // 3. RANGING (Флэт) - Дефолт
    {
        id: 'default_ranging',
        regime: 'RANGING',
        priority: 0,
        conditions: [], // Всегда true (fallback)
        weights: RANGING_WEIGHTS
    }
];