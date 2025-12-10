export type TrendState = 'UP' | 'DOWN' | 'FLAT' | 'CRASH' | 'PUMP';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface AssetMetric {
    symbol: string;
    trend: TrendState;
    changePct5m: number;
    priceVsEma: number;
    isVolatile: boolean;
}

export interface MarketContext {
    btc: AssetMetric;
    eth: AssetMetric;
    globalTrend: TrendState;
    riskLevel: RiskLevel;
    isBrokenCorrelation: boolean;
    permissions: {
        allowLong: boolean;
        allowShort: boolean;
        reason: string;
    };
}