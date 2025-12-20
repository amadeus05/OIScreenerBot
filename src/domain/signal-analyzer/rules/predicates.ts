// ========================================================================
// FILE: src/domain/signal-analyzer/rules/predicates.ts
// ========================================================================

import { Features } from '../types';

export const Predicates = {
    // --- OPEN INTEREST ---
    OI: {
        IsRising: (f: Features) => f.dOI > 0,
        IsFalling: (f: Features) => f.dOI < 0,
        IsSignificant: (f: Features) => Math.abs(f.dOI) > 0,
    },

    // --- PRICE ACTION ---
    Price: {
        IsUp: (f: Features) => f.priceReturn > 0,
        IsDown: (f: Features) => f.priceReturn < 0,
        IsFlatContext: (f: Features, ctx: any) => Math.abs(f.priceReturn) <= (ctx?.flatThreshold || 0.0005),
        IsFastMove: (f: Features, currentPrice: number) => Math.abs(f.priceReturn) > (f.atr / currentPrice),
        IsAboveEmaSlow: (f: Features, ctx: any) => (ctx?.currentPrice || 0) > f.emaSlow,
        IsBelowEmaSlow: (f: Features, ctx: any) => (ctx?.currentPrice || 0) < f.emaSlow,
        // Возвращает true, если цена закрылась в верхней части (последние 10%)
        // Это признак силы покупателя (опасно шортить)
        IsClosingNearHigh: (f: Features) => {
            // Данные о свече (OHLC) в Features не хранятся напрямую как объекты, 
            // но мы можем грубо оценить через priceReturn, если это "зеленая" свеча без фитиля.
            // ЛУЧШИЙ ВАРИАНТ: Передать range и closePos в Features из FeatureEngine.
            // ПОКА УПРОЩЕННО (чтобы код работал): Считаем, что если return > 0.5% и нет сильного sellVol, то это High.

            // Если у вас в Features нет доступа к O/H/L/C текущей свечи, эту логику лучше вынести в FeatureEngine.
            // Но допустим, мы добавим простой эвристический метод:
            return f.priceReturn > 0.005; // Временная заглушка, см. "Важно" ниже
        }
    },

    // --- 🔥 GLOBAL TREND (Синтетический MTF) ---
    Trend: {
        // Разрешаем Лонг только если цена НАД тяжелой средней (EMA 200)
        IsBullish: (f: Features, ctx: any) => ctx.currentPrice > f.trendEma,
        // Разрешаем Шорт только если цена ПОД тяжелой средней
        IsBearish: (f: Features, ctx: any) => ctx.currentPrice < f.trendEma,
    },

    // --- FLOW & CVD ---
    Flow: {
        IsBuying: (f: Features) => f.flowImb > 0.1,
        IsSelling: (f: Features) => f.flowImb < -0.1,
        // Смягчили пороги до 0.35, так как теперь есть фильтр тренда
        IsStrongBuying: (f: Features) => f.flowImb > 0.35,
        IsStrongSelling: (f: Features) => f.flowImb < -0.35,
        CvdIsRising: (f: Features) => f.dCVD > 0,
        CvdIsFalling: (f: Features) => f.dCVD < 0,
        CvdIsSignificant: (f: Features, ctx: any) => Math.abs(f.dCVD) > (ctx?.effectiveStd || 1000) * 1.5,
    },

    // --- VOLUME ---
    Vol: {
        IsHigh: (f: Features) => f.volZ > 1.0,
        IsExtreme: (f: Features) => f.volZ > 2.0,
        IsLow: (f: Features) => f.volZ < -0.5,
        // Экстремальный объем ИЛИ дивергенция (цена растет, объем падает)
        IsClimaxOrDivergence: (f: Features) => {
            const isClimax = f.volZ > 3.0; // Z-Score > 3 (Кульминация)
            const isDivergence = f.priceReturn > 0 && f.volZ < 0; // Цена растет, объем ниже среднего
            return isClimax || isDivergence;
        }
    },

    // --- MOMENTUM ---
    Momentum: {
        IsAccelerating: (f: Features, ctx: any) => Math.abs(f.emaFast - f.emaSlow) > Math.abs(ctx?.lastClosedEmaDiff || 0),
        IsOverbought: (f: Features, ctx: any) => (ctx?.deviation || 0) > 2.5,
        IsOversold: (f: Features, ctx: any) => (ctx?.deviation || 0) < -2.5,
        IsExtended: (f: Features, ctx: any) => Math.abs(ctx?.deviation || 0) > 1.5,
        IsKindOfPump: (f: Features, ctx: any) => f.pChange30m >= 0.05,  // было 0.08
        IsKindOfDump: (f: Features, ctx: any) => f.pChange30m <= -0.05  // было -0.08
    },

    // --- LIQUIDATIONS ---
    Liq: {
        IsHighLong: (f: Features, ctx: any) => ctx?.isHugeLong,
        IsHighShort: (f: Features, ctx: any) => ctx?.isHugeShort,
        IsCascadeAccel: (f: Features, ctx: any) => ctx?.isCascadeAccel,
        IsGrindingUp: (f: Features, ctx: any) => ctx?.isGrindingUp,

        /** Есть значительные ликвидации (сигнал активен) */
        HasSignal: (f: Features) => f.liquidationSignal === true,

        /** Преимущественно лонговые ликвидации (хорошо для шорта) */
        BiasLong: (f: Features) => f.liquidationBias === -1,

        /** Преимущественно шортовые ликвидации (опасно шортить — риск спайка) */
        BiasShort: (f: Features) => f.liquidationBias === 1,

        /** Нет шортовых ликвидаций или они слабые (безопасно шортить) */
        NoShortBias: (f: Features) => (f.liquidationBias ?? 0) <= 0,

        /** Нет лонговых ликвидаций (безопасно лонговать) */
        NoLongBias: (f: Features) => (f.liquidationBias ?? 0) >= 0,

        /** Сбалансированные или слабые ликвидации */
        IsNeutral: (f: Features) => f.liquidationBias === 0,
    },

    // --- ABSORPTION (NEW) ---
    Absorption: {
        /** Есть поглощение (флаг активен) */
        HasSignal: (f: Features) => f.absorptionFlag === true,

        /** Покупательское поглощение (бычье — опасно шортить) */
        BiasBuyers: (f: Features) => f.absorptionBias === 1,

        /** Продавцовое поглощение (медвежье — хорошо для шорта) */
        BiasSellers: (f: Features) => f.absorptionBias === -1,

        /** Нет покупательского поглощения (безопасно шортить) */
        NoBuyerBias: (f: Features) => (f.absorptionBias ?? 0) <= 0,

        /** Нет продавцового поглощения (безопасно лонговать) */
        NoSellerBias: (f: Features) => (f.absorptionBias ?? 0) >= 0,
    },

    // --- LEVELS ---
    Level: {
        IsResBreakout: (f: Features, ctx: any) => ctx?.breakout?.type === 'resistance_breakout',
        IsSupBreakdown: (f: Features, ctx: any) => ctx?.breakout?.type === 'support_breakdown',
        IsVolConfirmed: (f: Features, ctx: any) => ctx?.breakout?.volumeConfirmed,
        IsResSFP: (f: Features, ctx: any) => ctx?.isSFP && ctx?.sfpType === 'resistance',
        IsSupSFP: (f: Features, ctx: any) => ctx?.isSFP && ctx?.sfpType === 'support',
        IsNearRes: (f: Features, ctx: any) => ctx?.proximity === 'near_resistance',
        IsNearSup: (f: Features, ctx: any) => ctx?.proximity === 'near_support',
        IsConsolidation: (f: Features, ctx: any) => ctx?.levelContext?.inConsolidation,
    }
};