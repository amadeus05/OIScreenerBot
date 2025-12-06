/**
 * Signal Analyzer Module - Configuration
 * Tuned for Active Trading (Scalping/Daytrading)
 */

import { ModuleName } from './types';

/**
 * Complete configuration for the Signal Analyzer
 */
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
    threshold: number;        // Min |raw_score| for trade
    noTradeZone: number;      // Additional buffer around threshold
}

export interface PositionConfig {
    baseRiskPct: number;      // Base risk per trade (%)
    maxOpenTrades: number;
    minConfidence: number;    // Minimum confidence to trade
}

export interface LevelsConfig {
    swingWindow: number;           // Bars for swing detection
    maxLevels: number;             // Max S/R levels to track per side

    // ATR-based thresholds
    swingToleranceAtr: number;     // ATR mult for swing detection tolerance
    clusterThresholdAtr: number;   // ATR mult for level clustering

    // Decay settings
    decayRatePerBar: number;       // Strength decay per bar without touch
    minStrengthToKeep: number;     // Remove level if strength below this

    // Touch & confirmation
    minTouchesForConfirmed: number;  // Touches to be "confirmed"
    touchProximityAtr: number;       // ATR mult to count as touch
    maxTouchHistory: number;         // Max touches to keep in history (memory cap)

    // Breakout detection
    breakoutConfirmBars: number;   // Closes needed to confirm breakout
    breakoutVolumeRatio: number;   // Min volume ratio for valid breakout
    priorVolBars: number;          // Bars for prior volume calculation
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

    // Entry/SL/TP
    entryOffsetAtrMult: number;   // Entry offset as ATR multiple
    slAtrMultMin: number;         // Min SL distance as ATR mult
    slAtrMultMax: number;         // Max SL distance
    slStructuralBars: number;     // Bars for structural SL

    // TP ratios (Risk:Reward)
    tpRatios: number[];           // [1, 2] = RR 1:1, 1:2
}

// ============================================================================
// DEFAULT CONFIGURATION
// Tuned for: Higher Activity, Flow-Driven decisions
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
        // CHANGED: Shift focus to Flow & Price Action (Total: 1.0)
        orderflow: 0.40,    // Главный драйвер (было 0.35)
        levels: 0.25,       // Важный контекст (было 0.15)
        oi: 0.15,           // Вспомогательный (было 0.25) - слишком шумный
        momentum: 0.10,     // Вспомогательный (было 0.10) - часто лагает
        liquidations: 0.10, // Бонус/Топливо
    },

    decision: {
        // CHANGED: Lower threshold to catch moves early
        threshold: 0.35,      // Было 0.45. При 0.35 достаточно одного сильного модуля.
        noTradeZone: 0.05,
    },

    position: {
        baseRiskPct: 0.5,     // Чуть консервативнее риск на сделку, так как сделок будет больше
        maxOpenTrades: 3,
        minConfidence: 0.3,   // Было 0.4. Разрешаем сделки с 'LOW' confidence, если сигнал сильный
    },

    levels: {
        swingWindow: 8,
        maxLevels: 10,

        // ATR-based thresholds
        swingToleranceAtr: 0.3,
        clusterThresholdAtr: 0.6,    // Чуть шире кластеризация (0.5 -> 0.6)

        // Decay settings
        decayRatePerBar: 0.001,      // CHANGED: Уровни живут дольше (было 0.003)
        minStrengthToKeep: 0.10,     // CHANGED: Держим даже слабые уровни дольше (было 0.15)

        // Touch & confirmation
        minTouchesForConfirmed: 3,
        touchProximityAtr: 0.4,      // Чуть шире зона касания
        maxTouchHistory: 20,

        // Breakout detection
        breakoutConfirmBars: 2,
        breakoutVolumeRatio: 1.2,
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

        entryOffsetAtrMult: 0.1,  // Ближе к цене (было 0.2), чтобы чаще забирало лимитки
        slAtrMultMin: 1.0,
        slAtrMultMax: 2.0,        // Разрешаем стоп чуть дальше (было 1.5) для волатильности
        slStructuralBars: 3,      // Ищем структуру на 3 барах

        tpRatios: [1.2, 2.5],     // Целимся чуть выше (было [1, 2])
    },
};

/**
 * Module-specific configuration
 */
export const MODULE_CONFIG = {
    momentum: {
        // Было 50. Для 1m/5m нужно 500 или даже 1000!
        // tanh(0.002 * 500) = tanh(1.0) = 0.76 (Отличный сигнал)
        scaleFactor: 500,
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
        nearLevelPenalty: 0.2, // Снизил штраф за близость к уровню (было 0.3)
    },
} as const;