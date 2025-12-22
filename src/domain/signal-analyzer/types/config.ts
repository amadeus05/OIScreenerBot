import { ModuleName } from './types';

export interface SignalAnalyzerConfig {
    lookbacks: LookbackConfig;
    weights: ModuleWeights;
    decision: DecisionConfig;
    position: PositionConfig;
    levels: LevelsConfig;
    safety: SafetyConfig;
    technical: TechnicalConfig;
    fees: FeesConfig; // <--- ДОБАВЛЕНО
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

    // Добавляем настройки для расчета сайза
    defaultPortfolioSize: number; // Размер депозита для расчета (если не передан)
    maxPositionSizeUsd: number;   // Хард-кап позиции
    leverage: number;             // Плечо (нужно для расчета маржи, хотя PnL считается от полного объема)
}

export interface FeesConfig {
    maker: number; // Обычно 0.02% (0.0002)
    taker: number; // Обычно 0.05% (0.0005)
    slippage: number; // Проскальзывание, важно для тестов (например, 0.01%)
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
        // Балансируем веса: Orderflow главный, Momentum помогает, MeanReversion страхует
        orderflow: 0.40,
        meanReversion: 0.20,
        momentum: 0.30, 
        liquidations: 0.10, // Вернем немного веса ликвидациям для точности входа
        levels: 0.00,
        oi: 0.00,
    },

    decision: {
        threshold: 0.40, 
        noTradeZone: 0.05,
    },

    position: {
        baseRiskPct: 1.0,
        maxOpenTrades: 1,
        minConfidence: 0.60, // Требуем уверенности

        defaultPortfolioSize: 100,
        maxPositionSizeUsd: 300,
        leverage: 3
    },

    fees: {
        maker: 0.0002,
        taker: 0.0005,
        slippage: 0.0001
    },

    levels: {
        swingWindow: 5,
        maxLevels: 10,
        swingToleranceAtr: 0.3,
        clusterThresholdAtr: 0.6,
        decayRatePerBar: 0.005,
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
        entryOffsetAtrMult: 0.00,

        // === ЗОЛОТАЯ СЕРЕДИНА ===
        // SL 1.5 ATR: Выдерживает шум, но не замораживает депозит.
        slAtrMultMin: 1.8, 
        slAtrMultMax: 2.5,
        slStructuralBars: 8,

        // TP: Первый тейк ровно на 1 R (равен риску).
        // Это обеспечивает психологический комфорт и быстрый выход в б/у.
        // Второй тейк ловит хвосты.
        tpRatios: [0.8, 2.0], 
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