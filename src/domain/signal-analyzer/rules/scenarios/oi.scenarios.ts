// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/oi.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

/**
 * Конфигурация стратегий для OI Module.
 * Порядок важен: более специфичные сценарии должны идти раньше (или иметь уникальные условия),
 * чтобы перекрывать общие. В нашей реализации мы ищем Best Match или Sum.
 */
export const OiScenarios: MarketScenario[] = [
    // =================================================================
    // GROUP A: OI RISING (Вход денег)
    // =================================================================

    // 1. Классический Лонг (Trend Following)
    // ОИ растет + Цена растет + Поток подтверждает (или нейтрален)
    {
        id: 'long_buildup_trend',
        name: 'Long Build-up (Trend)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsUp,
            (f) => !P.Flow.IsStrongSelling(f) // Нет сильных продаж по рынку
        ],
        baseScore: 0.6,
        reliability: 0.6,
        tags: ['oi_up', 'long_buildup'],
        useStrengthMultiplier: true
    },
    // 1.1 Усиление дельтой
    {
        id: 'long_buildup_delta_confirmed',
        name: 'Long Build-up (Delta Confirmed)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsUp,
            P.Flow.IsBuying // Покупки по рынку > 0.1
        ],
        baseScore: 0.2, // Добавка к основному
        reliability: 0.2,
        tags: ['delta_confirmed'],
        useStrengthMultiplier: false
    },

    // 2. Медвежье Поглощение (Absorption) - РАЗВОРОТ
    // ОИ растет + Цена растет + НО дикие продажи по рынку (лимитный продавец держит)
    // В оригинале: flowImb > 0.5 (Strong Buying) но цена не летит? 
    // *Исправление логики оригинала*: Если цена растет, ОИ растет, и FlowImb > 0.5 (ОЧЕНЬ МНОГО ПОКУПОК), 
    // но рост вялый (тут мы это не проверяем, но подразумеваем контекст) -> Это Bearish Absorption?
    // В твоем коде было: if (flowImb > STRONG_FLOW) -> score = -0.3
    {
        id: 'bearish_absorption_wall',
        name: 'Bearish Absorption (Ask Wall)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsUp,
            P.Flow.IsStrongBuying // Толпа покупает, но это ловушка
        ],
        baseScore: -0.9, // Перебиваем лонг сигнал (0.6 + 0.2 - 0.9 = -0.1)
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
            (f) => !P.Flow.IsStrongBuying(f)
        ],
        baseScore: -0.6,
        reliability: 0.6,
        tags: ['oi_up', 'short_buildup'],
        useStrengthMultiplier: true
    },

    // 4. Бычье Поглощение (Absorption) - РАЗВОРОТ
    // ОИ растет + Цена падает + НО дикие продажи (flowImb < -0.1), которые кто-то выкупает лимитками
    // В оригинале: flowImb > WEAK (0.1) -> Bullish Absorption
    // *Логика*: Цена падает, ОИ растет (шортят), но Flow > 0.1 (покупки по рынку??).
    // Это значит, что цену давят вниз лимитками (спуфинг или айсберг), несмотря на покупки. 
    // Или это "Passive Buying into Dump".
    {
        id: 'bullish_absorption_limit_bid',
        name: 'Bullish Absorption (Limit Bid)',
        conditions: [
            P.OI.IsRising,
            P.Price.IsDown,
            P.Flow.IsBuying // Покупают по рынку, но цена падает? Странно. Или наоборот: продают, но цена стоит.
            // В оригинале код: if (flowImb > WEAK_FLOW) score = 0.2
        ],
        baseScore: 0.8, // Переворачиваем шорт (-0.6 + 0.8 = +0.2)
        reliability: 0.4,
        tags: ['bullish_absorption', 'risky_reversal'],
        useStrengthMultiplier: false
    },


    // =================================================================
    // GROUP B: OI FALLING (Выход денег / Ликвидации)
    // =================================================================

    // 5. Short Covering (Закрытие шортов) - Цена вверх
    {
        id: 'short_covering',
        name: 'Short Covering',
        conditions: [
            P.OI.IsFalling,
            P.Price.IsUp
        ],
        baseScore: 0.3, // Слабый лонг
        reliability: 0.5,
        tags: ['oi_down', 'short_covering'],
        useStrengthMultiplier: true
    },
    // 5.1 Panic Short Squeeze (Паника)
    {
        id: 'panic_short_squeeze',
        name: 'Panic Short Squeeze',
        conditions: [
            P.OI.IsFalling,
            P.Price.IsUp,
            P.Flow.IsStrongBuying,
            (f, ctx) => P.Price.IsFastMove(f, ctx?.price || 1) // Нужна цена
        ],
        baseScore: 0.8, // Сильный лонг (импульс)
        reliability: 0.8,
        tags: ['panic_short_squeeze'],
        useStrengthMultiplier: false // Фиксированный высокий скор
    },

    // 6. Long Unwind (Закрытие лонгов) - Цена вниз
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