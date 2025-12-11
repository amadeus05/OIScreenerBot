import { ModuleName } from './types';

export interface SignalAnalyzerConfig {
    lookbacks: LookbackConfig;
    weights: ModuleWeights;
    decision: DecisionConfig;
    position: PositionConfig;
    levels: LevelsConfig;
    safety: SafetyConfig;
    technical: TechnicalConfig;
}

export interface LookbackConfig {
    dCVD: number;       // Bars for CVD delta
    dOI: number;        // Bars for OI delta
    volZ: number;       // Window for volume z-score
    deltaZ: number;     // Window for delta z-score
    oiMean: number;     // Window for OI mean (oi_flow)
}

export type ModuleWeights = Record<ModuleName, number>;

export interface DecisionConfig {
    threshold: number;       // Min |raw_score| for trade
    noTradeZone: number;     // Additional buffer around threshold
}

export interface PositionConfig {
    baseRiskPct: number;     // Base risk per trade (%)
    maxOpenTrades: number;
    minConfidence: number;   // Minimum confidence to trade
}

export interface LevelsConfig {
    swingWindow: number;
    maxLevels: number;
    swingToleranceAtr: number;
    clusterThresholdAtr: number;
    decayRatePerBar: number;
    minStrengthToKeep: number;
    minTouchesForConfirmed: number;
    touchProximityAtr: number;
    maxTouchHistory: number;
    breakoutConfirmBars: number;
    breakoutVolumeRatio: number;
    priorVolBars: number;
}

export interface SafetyConfig {
    fundingPenaltyThreshold: number;
    liqPercentileThresh: number;
    maxFundingPenalty: number;
}

export interface TechnicalConfig {
    atrPeriod: number;
    emaFastPeriod: number;
    emaSlowPeriod: number;
    entryOffsetAtrMult: number;
    slAtrMultMin: number;
    slAtrMultMax: number;
    slStructuralBars: number;
    tpRatios: number[];
}

// ============================================================================
// DEFAULT CONFIGURATION
// Tuned for: Smart Reversal & Momentum Pullbacks (Top 1 Accuracy Setup)
// ============================================================================

export const DEFAULT_CONFIG: SignalAnalyzerConfig = {
    lookbacks: {
        dCVD: 5,
        dOI: 5,
        volZ: 30,
        deltaZ: 30,
        oiMean: 100,
    },

    weights: {
        // Упор на поток ордеров и импульс (скальпинг)
        orderflow: 0.40, 
        liquidations: 0.20,
        levels: 0.10,     // Снижаем влияние уровней (на мемах их прошивают)
        momentum: 0.20,   // Повышаем моментум (торгуем по движению)
        oi: 0.10,
    },

decision: {
        // Снижаем порог входа. Рынок шумный, идеальных 0.55 мало.
        threshold: 0.50, // Было 0.55
        noTradeZone: 0.05, // Уменьшаем мертвую зону
    },

    position: {
        baseRiskPct: 1.0, 
        maxOpenTrades: 5, // Разрешаем больше одновременных сделок
        // Разрешаем входить в сделки со средней уверенностью
        minConfidence: 0.50, // Было 0.55
    },

    levels: {
        swingWindow: 5, 
        maxLevels: 10,
        swingToleranceAtr: 0.3,
        clusterThresholdAtr: 0.6,
        decayRatePerBar: 0.005, // Уровни живут недолго
        minStrengthToKeep: 0.15,
        minTouchesForConfirmed: 2, 
        touchProximityAtr: 0.4,
        maxTouchHistory: 20,
        breakoutConfirmBars: 1, 
        breakoutVolumeRatio: 1.5,
        priorVolBars: 5,
    },

    safety: {
        fundingPenaltyThreshold: 0.005,
        liqPercentileThresh: 0.95,
        maxFundingPenalty: 0.4,
    },

technical: {
        atrPeriod: 14,
        emaFastPeriod: 8,
        emaSlowPeriod: 21,
        
        // === ИЗМЕНЕНИЕ 1: Лимитный вход ===
        // Ставим лимитку на 0.15 ATR лучше цены закрытия.
        // Это фильтрует "FOMO-входы" на хаях свечи.
        entryOffsetAtrMult: 0.15, // Было 0.0
        
        // === ИЗМЕНЕНИЕ 2: Чуть больше воздуха стопу ===
        // Было 0.4 - слишком тесно, выбивает шумом.
        slAtrMultMin: 0.6, // Чуть шире минимальный стоп
        slAtrMultMax: 1.2, 
        slStructuralBars: 3, // Смотрим на 3 свечи назад для поиска лоу, а не 2
        
        // Тейки оставляем агрессивными
        tpRatios: [2.0, 5.0], 
    },
};
/**
 * Module-specific configuration
 */
export const MODULE_CONFIG = {
    momentum: {
        // Снижаем с 150 до 80. Это уберет ложные срабатывания "1.0" на каждой свече.
        // Теперь моментум будет расти плавнее.
        scaleFactor: 80, 
    },
    orderflow: {
        flowWeight: 0.45,
        dcvdWeight: 0.30,
        volZWeight: 0.25,
        tanhScale: 1.5,
    },
    oi: {
        threshold: 0.01,
    },
    liquidations: {
        spikeScore: 0.8,
    },
    levels: {
        nearLevelPenalty: 0.2,
    },
} as const;