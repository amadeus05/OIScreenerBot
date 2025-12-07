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
        // Увеличиваем вес Orderflow и Liquidations, так как они дают лучшие точки разворота
        orderflow: 0.35,
        liquidations: 0.25,
        levels: 0.20,
        momentum: 0.10,
        oi: 0.10,
    },

    decision: {
        // Поднимаем порог. Лучше пропустить сделку, чем войти в шум.
        threshold: 0.55, 
        noTradeZone: 0.1,
    },

    position: {
        baseRiskPct: 0.5,
        maxOpenTrades: 3,
        minConfidence: 0.4, // Требуем более высокой уверенности
    },

    levels: {
        swingWindow: 8,
        maxLevels: 10,
        swingToleranceAtr: 0.3,
        clusterThresholdAtr: 0.6,
        decayRatePerBar: 0.001,
        minStrengthToKeep: 0.10,
        minTouchesForConfirmed: 3,
        touchProximityAtr: 0.4,
        maxTouchHistory: 20,
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
        entryOffsetAtrMult: 0.1,
        slAtrMultMin: 1.0,
        slAtrMultMax: 2.0,
        slStructuralBars: 3,
        tpRatios: [1.2, 2.5],
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