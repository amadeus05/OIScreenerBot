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
    },

    // --- FLOW & CVD ---
    Flow: {
        IsBuying: (f: Features) => f.flowImb > 0.1,
        IsSelling: (f: Features) => f.flowImb < -0.1,
        IsStrongBuying: (f: Features) => f.flowImb > 0.5,
        IsStrongSelling: (f: Features) => f.flowImb < -0.5,
        CvdIsRising: (f: Features) => f.dCVD > 0,
        CvdIsFalling: (f: Features) => f.dCVD < 0,
        CvdIsSignificant: (f: Features, ctx: any) => Math.abs(f.dCVD) > (ctx?.effectiveStd || 1000) * 1.5,
    },

    // --- VOLUME ---
    Vol: {
        IsHigh: (f: Features) => f.volZ > 1.0,
        IsExtreme: (f: Features) => f.volZ > 2.0,
        IsLow: (f: Features) => f.volZ < -0.5,
    },

    // --- MOMENTUM ---
    Momentum: {
        IsAccelerating: (f: Features, ctx: any) => Math.abs(f.emaFast - f.emaSlow) > Math.abs(ctx?.lastClosedEmaDiff || 0),
        IsOverbought: (f: Features, ctx: any) => (ctx?.deviation || 0) > 2.5,
        IsOversold: (f: Features, ctx: any) => (ctx?.deviation || 0) < -2.5,
        IsExtended: (f: Features, ctx: any) => Math.abs(ctx?.deviation || 0) > 1.5,
    },

    // --- LIQUIDATIONS (New) ---
    Liq: {
        // Контекст передается из модуля (расчет intensity)
        IsHighLong: (f: Features, ctx: any) => ctx?.isHugeLong,
        IsHighShort: (f: Features, ctx: any) => ctx?.isHugeShort,
        IsCascadeAccel: (f: Features, ctx: any) => ctx?.isCascadeAccel, // Ускорение каскада
        IsGrindingUp: (f: Features, ctx: any) => ctx?.isGrindingUp,     // Медленный рост на ликвид. шортов
    },

    // --- LEVELS (New) ---
    Level: {
        // Breakouts
        IsResBreakout: (f: Features, ctx: any) => ctx?.breakout?.type === 'resistance_breakout',
        IsSupBreakdown: (f: Features, ctx: any) => ctx?.breakout?.type === 'support_breakdown',
        IsVolConfirmed: (f: Features, ctx: any) => ctx?.breakout?.volumeConfirmed,
        
        // SFP (Swing Failure Pattern) - Ложный пробой
        // Контекст рассчитывается внутри модуля
        IsResSFP: (f: Features, ctx: any) => ctx?.isSFP && ctx?.sfpType === 'resistance',
        IsSupSFP: (f: Features, ctx: any) => ctx?.isSFP && ctx?.sfpType === 'support',

        // Proximity (Отскок)
        IsNearRes: (f: Features, ctx: any) => ctx?.proximity === 'near_resistance',
        IsNearSup: (f: Features, ctx: any) => ctx?.proximity === 'near_support',
        
        IsConsolidation: (f: Features, ctx: any) => ctx?.levelContext?.inConsolidation,
    }
};