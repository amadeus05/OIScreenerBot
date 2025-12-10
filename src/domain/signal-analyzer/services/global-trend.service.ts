import { IMarketDataRepository } from '../../interfaces/services.interface';
import { SmartCandle } from '../../interfaces/market-data.interface';
import { MarketContext, TrendState, RiskLevel, AssetMetric } from '../types/context';
import { Logger } from '../../../shared/logger';

// Конфиг чувствительности (можно вынести в общий config.ts модуля)
const CONFIG = {
    CRASH_THRESHOLD: -0.008, 
    PUMP_THRESHOLD: 0.008,   
    TREND_THRESHOLD: 0.002,  
    EMA_PERIOD: 20,          
    VOLATILITY_THRESHOLD: 0.004 
};

export class GlobalTrendService {
    private readonly logger = new Logger('GlobalTrend');

    // Мы принимаем интерфейс репозитория. 
    // В DI контейнере мы передадим конкретную реализацию.
    constructor(
        private readonly marketDataRepo: IMarketDataRepository
    ) {}

    public async analyze(): Promise<MarketContext> {
        const btcCandles = this.marketDataRepo.getHistory('BTCUSDT', 50);
        const ethCandles = this.marketDataRepo.getHistory('ETHUSDT', 50);

        if (btcCandles.length < CONFIG.EMA_PERIOD || ethCandles.length < CONFIG.EMA_PERIOD) {
            return this.getNeutralContext('Insufficient Data');
        }

        const btc = this.analyzeAsset('BTCUSDT', btcCandles);
        const eth = this.analyzeAsset('ETHUSDT', ethCandles);

        // Корреляция
        const isBrokenCorrelation = 
            (btc.trend === 'UP' && eth.trend === 'DOWN') ||
            (btc.trend === 'DOWN' && eth.trend === 'UP');

        // Глобальный тренд
        let globalTrend = btc.trend;
        if (btc.trend === 'FLAT' && eth.trend !== 'FLAT') globalTrend = eth.trend;
        if (btc.trend === 'CRASH') globalTrend = 'CRASH';

        // Риск
        let riskLevel: RiskLevel = 'LOW';
        if (globalTrend === 'CRASH' || globalTrend === 'PUMP') riskLevel = 'EXTREME';
        else if (isBrokenCorrelation) riskLevel = 'HIGH';
        else if (btc.isVolatile || eth.isVolatile) riskLevel = 'MEDIUM';

        // Права
        const permissions = this.calculatePermissions(globalTrend, riskLevel, isBrokenCorrelation);

        return { btc, eth, globalTrend, riskLevel, isBrokenCorrelation, permissions };
    }

    private analyzeAsset(symbol: string, candles: SmartCandle[]): AssetMetric {
        const current = candles[candles.length - 1];
        const prev5m = candles[candles.length - 6];

        const changePct5m = (current.ohlc.c - prev5m.ohlc.c) / prev5m.ohlc.c;
        
        const slice = candles.slice(-CONFIG.EMA_PERIOD);
        const sma = slice.reduce((sum, c) => sum + c.ohlc.c, 0) / slice.length;
        const priceVsEma = (current.ohlc.c - sma) / sma;

        const candleRange = (current.ohlc.h - current.ohlc.l) / current.ohlc.c;
        const isVolatile = candleRange > CONFIG.VOLATILITY_THRESHOLD;

        let trend: TrendState = 'FLAT';
        if (changePct5m <= CONFIG.CRASH_THRESHOLD) trend = 'CRASH';
        else if (changePct5m >= CONFIG.PUMP_THRESHOLD) trend = 'PUMP';
        else {
            if (changePct5m > CONFIG.TREND_THRESHOLD) trend = (priceVsEma > 0 || changePct5m > CONFIG.TREND_THRESHOLD * 2) ? 'UP' : 'FLAT';
            else if (changePct5m < -CONFIG.TREND_THRESHOLD) trend = (priceVsEma < 0 || changePct5m < -CONFIG.TREND_THRESHOLD * 2) ? 'DOWN' : 'FLAT';
        }

        return { symbol, trend, changePct5m, priceVsEma, isVolatile };
    }

    private calculatePermissions(trend: TrendState, risk: RiskLevel, brokenCorr: boolean) {
        let allowLong = true;
        let allowShort = true;
        let reason = 'Stable';

        if (trend === 'DOWN') { allowLong = false; reason = 'Downtrend'; }
        if (trend === 'UP') { allowShort = false; reason = 'Uptrend'; }
        
        if (trend === 'CRASH') { allowLong = false; allowShort = true; reason = 'PANIC DUMP'; }
        if (trend === 'PUMP') { allowLong = true; allowShort = false; reason = 'PANIC PUMP'; }

        if (risk === 'HIGH' && brokenCorr) { allowLong = false; allowShort = false; reason = 'Correlation Broken'; }
        if (risk === 'EXTREME' && trend === 'FLAT') { allowLong = false; allowShort = false; reason = 'Extreme Volatility'; }

        return { allowLong, allowShort, reason };
    }

    private getNeutralContext(msg: string): MarketContext {
        const n: AssetMetric = { symbol: 'N/A', trend: 'FLAT', changePct5m: 0, priceVsEma: 0, isVolatile: false };
        return { btc: n, eth: n, globalTrend: 'FLAT', riskLevel: 'LOW', isBrokenCorrelation: false, permissions: { allowLong: true, allowShort: true, reason: msg } };
    }
}