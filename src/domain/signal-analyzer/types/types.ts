// ========================================================================
// FILE: src/domain/signal-analyzer/types/types.ts
// ========================================================================

export interface BarData {
    symbol: string;
    ts: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    delta: number;
    cvd: number;
    oi: number;
    funding: number;
    lastPrice: number;
    liquidations: {
        long: number;
        short: number;
        countLong: number;
        countShort: number;
        maxLong: number;
        maxShort: number;
    };
}

export interface AggregatedBar extends BarData {
    timeframe: Timeframe;
    barCount: number;
}

export type Timeframe = '1m' | '5m' | '15m';

export interface Features {
    // Basic computed
    buyVol: number;
    sellVol: number;
    flowImb: number;

    // Z-scores
    volZ: number;
    deltaZ: number;

    // Deltas
    dCVD: number;
    dOI: number;
    oiFlow: number;

    // Price
    priceReturn: number;
    lastPriceGap: number;

    // Technical
    atr: number;
    emaFast: number;       
    emaSlow: number;
    
    // 🔥 НОВОЕ ПОЛЕ: Глобальный тренд (EMA 200)
    trendEma: number;      

    // Flags
    liquidationSignal: boolean;
    absorptionFlag: boolean;
    liquidationBias?: number;
    absorptionBias?: number;
    oi?: number;
    
    pChange30m: number; // новый параметр
}

export interface MultiTimeframeFeatures {
    tf1m: Features;
    tf5m: Features;
    tf15m: Features;
}

export interface ModuleOutput {
    name: ModuleName;
    score: number;
    reliability: number;
    tags: string[];
}

export type ModuleName =
    | 'meanReversion'
    | 'momentum'
    | 'orderflow'
    | 'oi'
    | 'liquidations'
    | 'levels';

export type TradeAction = 'LONG' | 'SHORT' | 'NO_TRADE';
export type EntryType = 'market' | 'limit';

export interface SignalResult {
    ts: string;
    symbol: string;
    action: TradeAction;
    entryType: EntryType;
    entryPrice: number;
    sl: number;
    tp: number[];
    tpPct: number[];
    horizonMin: number;
    confidence: number;
    confidenceLevel: ConfidenceLevel;
    modules: Record<ModuleName, number>;
    reasonTags: string[];
    riskPct: number;
    meta: {
        rawScore: number;
        moduleAgreement: number;
        [key: string]: any;
    };
    marketRegime?: string;
}

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SwingPoint {
    id: string;
    ts: number;
    price: number;
    type: 'high' | 'low';
    strength: number;
    touchCount: number;
    lastTouchTs: number;
    touchPrices: number[];
    touchVolumes: number[];
    avgBounce: number;
    maxBounce: number;
    createdAt: number;
    confirmedAt: number;
}

export interface PriceLevel {
    price: number;
    type: 'support' | 'resistance';
    strength: number;
    timesTestedCount: number;
    lastTestedTs: number;
    isConfirmed: boolean;
    isFresh: boolean;
}

export interface LevelContext {
    nearestSupport: PriceLevel | null;
    nearestResistance: PriceLevel | null;
    nextSupport: PriceLevel | null;
    nextResistance: PriceLevel | null;
    inConsolidation: boolean;
    distanceToNearestPct: number;
    roomToMove: number;
}