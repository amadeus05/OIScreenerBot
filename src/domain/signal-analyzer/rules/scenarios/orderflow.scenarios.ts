// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/orderflow.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

export const OrderflowScenarios: MarketScenario[] = [
    // 1. HIDDEN SELLING WALL (Лимитный продавец)
    // CVD растет (покупки), но цена стоит на месте или падает.
    // Классический сигнал разворота вниз или накопления шорта.
    {
        id: 'hidden_selling_wall',
        name: 'Hidden Selling Wall (Absorption)',
        conditions: [
            P.Flow.CvdIsRising,          // Покупают...
            P.Flow.CvdIsSignificant,     // Много покупают...
            (f, ctx) => P.Price.IsFlatContext(f, ctx) || P.Price.IsDown(f) // А цена не растет!
        ],
        baseScore: -0.8, // Сильный Шорт
        reliability: 0.8,
        tags: ['hidden_selling_wall', 'absorption'],
        useStrengthMultiplier: false
    },

    // 2. HIDDEN BUYING WALL (Лимитный покупатель)
    // CVD падает (продажи), но цена стоит или растет.
    {
        id: 'hidden_buying_wall',
        name: 'Hidden Buying Wall (Absorption)',
        conditions: [
            P.Flow.CvdIsFalling,         // Продают...
            P.Flow.CvdIsSignificant,     // Много продают...
            (f, ctx) => P.Price.IsFlatContext(f, ctx) || P.Price.IsUp(f) // А цена не падает!
        ],
        baseScore: 0.8, // Сильный Лонг
        reliability: 0.8,
        tags: ['hidden_buying_wall', 'absorption'],
        useStrengthMultiplier: false
    },

    // 3. CONVERGENCE (Подтверждение тренда)
    // Цена и CVD идут в одну сторону + есть объем.
    {
        id: 'bullish_convergence',
        name: 'Bullish Flow Convergence',
        conditions: [
            P.Price.IsUp,
            P.Flow.CvdIsRising,
            (f, ctx) => Math.abs(f.dCVD) > (ctx?.effectiveStd || 0) * 0.5 // Фильтр шума
        ],
        baseScore: 0.4,
        reliability: 0.7,
        tags: ['flow_price_aligned'],
        useStrengthMultiplier: true
    },
    {
        id: 'bearish_convergence',
        name: 'Bearish Flow Convergence',
        conditions: [
            P.Price.IsDown,
            P.Flow.CvdIsFalling,
            (f, ctx) => Math.abs(f.dCVD) > (ctx?.effectiveStd || 0) * 0.5
        ],
        baseScore: -0.4,
        reliability: 0.7,
        tags: ['flow_price_aligned'],
        useStrengthMultiplier: true
    },

    // 4. HIGH VOLUME CONFIRMATION (Бонус)
    // Просто высокий объем сам по себе увеличивает значимость
    {
        id: 'high_vol_bonus',
        name: 'High Volume Activity',
        conditions: [
            P.Vol.IsExtreme
        ],
        baseScore: 0.1, // Небольшой буст к текущему направлению (реализовано через sign в модуле или тут)
        // В этой архитектуре лучше использовать это как модификатор надежности, 
        // но можно и как слабый сигнал активности.
        reliability: 0.5,
        tags: ['high_volume_significance'],
        useStrengthMultiplier: false
    }
];