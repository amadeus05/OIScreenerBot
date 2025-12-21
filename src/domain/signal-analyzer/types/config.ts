import { ModuleName } from './types';

export interface SignalAnalyzerConfig {
    lookbacks: LookbackConfig;
    weights: ModuleWeights;
    /**
     * Опциональные профили весов по режимам рынка.
     * Если заданы, используются RegimeSupervisor вместо весов сценариев.
     */
    regimeWeights?: Partial<Record<MarketRegimeKey, ModuleWeights>>;
    decision: DecisionConfig;
    position: PositionConfig;
    levels: LevelsConfig;
    safety: SafetyConfig;
    technical: TechnicalConfig;
    fees: FeesConfig; // <--- ДОБАВЛЕНО
}

export type MarketRegimeKey = 'RANGING' | 'TRENDING' | 'VOLATILE' | 'EXTREME';

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
        // Новая комбинация модулей
        orderflow: 0.37,      // основной источник силы (CVD, OI, flow)
        meanReversion: 0.13,  // mean reversion (pump/dump exhaustion)
        momentum: 0.25,       // momentum continuation
        // Legacy (не используются, но оставляем для типизации)
        liquidations: 0.04,
        levels: 0.08,
        oi: 0.05,
    },

    regimeWeights: {},

    decision: {
        // Баланс: не слишком строго, но и не слишком мягко
        threshold: 0.35, // подняли порог, чтобы отсечь средние сетапы
        noTradeZone: 0.00,
    },

    position: {
        baseRiskPct: 1.13,
        maxOpenTrades: 1, // Разрешаем больше одновременных сделок
        // Разрешаем входить в сделки со средней уверенностью
        minConfidence: 0.70, // Было 0.55

        // Новые поля для синхронизации
        defaultPortfolioSize: 100, // База для расчета, если не знаем баланс
        maxPositionSizeUsd: 300,
        leverage: 4
    },

    // ДОБАВЛЯЕМ РЕАЛЬНЫЕ КОМИССИИ BINANCE (VIP 0)
    fees: {
        maker: 0.0002, // 0.02%
        taker: 0.0005, // 0.05%
        slippage: 0.0001 // 0.01% закладываем на проскальзывание при входе маркетом
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
        entryOffsetAtrMult: 0.00, // Было 0.0

        // === ИЗМЕНЕНИЕ 2: Чуть больше воздуха стопу ===
        // Было 0.4 - слишком тесно, выбивает шумом.
        slAtrMultMin: 2.0, // Чуть шире минимальный стоп
        slAtrMultMax: 3.5,
        slStructuralBars: 10, // Смотрим на 3 свечи назад для поиска лоу, а не 2

        // Тейки: более агрессивный R:R для компенсации низкого winrate
        tpRatios: [1.5, 3.0], // Было [1.5, 3.0] → минимум 2:1 R:R
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