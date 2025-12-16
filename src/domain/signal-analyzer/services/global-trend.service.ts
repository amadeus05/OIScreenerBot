import { IMarketDataRepository } from '../../interfaces/services.interface';
import { SmartCandle } from '../../interfaces/market-data.interface';
import { MarketContext, TrendState, RiskLevel, AssetMetric } from '../types/context';
import { Logger } from '../../../shared/logger';
import { calculateATR, calculateEMA } from '../utils/rolling-stats';

const CONFIG = {
    HISTORY_LENGTH: 150, // Увеличили для надежности
    EMA_PERIOD_LOCAL: 20,
    EMA_PERIOD_GLOBAL: 200,
    ATR_PERIOD: 14,
    
    // Порог волатильности (candle range > 2.5 ATR = Extreme Volatility)
    THRESHOLD_VOL_EXTREME: 2.5 
};

// Настройки порогов (в ATR)
const THRESHOLDS = {
    // Импульс (PUMP/CRASH) - высший приоритет
    impulseEntry: 3.5, 
    impulseExit: 1.5,  

    // Тренд (UP/DOWN)
    trendEntry: 1.0,   
    trendExit: 0.5,    // Расширили с 0.3 до 0.5, чтобы держать откаты
};

// Тайминги подтверждения (в барах)
const CONFIRMATION = {
    impulse: 2, // 2 бара подряд для подтверждения пампа
    trend: 4,   // 4 бара для подтверждения тренда
    exit: 1     // Выход почти мгновенный (безопасность)
};

// Внутреннее состояние актива
interface SymbolState {
    confirmed: TrendState;      // Текущий официальный тренд
    candidate: TrendState;      // Кандидат на смену
    candidateDuration: number;  // Сколько баров держится кандидат
    duration: number;           // Сколько баров держится confirmed
    volatilityAvg: number;      // EMA волатильности
}

export class GlobalTrendService {
    private readonly logger = new Logger('GlobalTrend');

    // Хранилище состояния
    private states = new Map<string, SymbolState>();

    constructor(private readonly marketDataRepo: IMarketDataRepository) { }

    public async analyze(): Promise<MarketContext> {
        const btcCandles = this.marketDataRepo.getHistory('BTCUSDT', CONFIG.HISTORY_LENGTH);
        const ethCandles = this.marketDataRepo.getHistory('ETHUSDT', CONFIG.HISTORY_LENGTH);

        if (btcCandles.length < CONFIG.EMA_PERIOD_GLOBAL || ethCandles.length < CONFIG.EMA_PERIOD_GLOBAL) {
            return this.getNeutralContext('Insufficient Data (Warming up)');
        }

        const btc = this.analyzeAsset('BTCUSDT', btcCandles);
        const eth = this.analyzeAsset('ETHUSDT', ethCandles);

        // Корреляция
        const isBrokenCorrelation =
            (btc.trend === 'UP' && eth.trend === 'DOWN') ||
            (btc.trend === 'DOWN' && eth.trend === 'UP');

        // Определение глобального тренда
        // Приоритет BTC, но если ETH в PUMP/CRASH, учитываем это как риск
        let globalTrend: TrendState = 'FLAT';
        
        if (btc.trend === 'PUMP' || eth.trend === 'PUMP') globalTrend = 'PUMP';
        else if (btc.trend === 'CRASH' || eth.trend === 'CRASH') globalTrend = 'CRASH';
        else if (btc.trend === eth.trend) globalTrend = btc.trend;
        else globalTrend = btc.trend !== 'FLAT' ? btc.trend : eth.trend; // Верим активу, который не во флэте

        // Расчет RiskLevel
        let riskLevel: RiskLevel = 'LOW';
        const isExtremeVol = btc.isVolatile || eth.isVolatile;

        if (globalTrend === 'CRASH' || globalTrend === 'PUMP') {
            riskLevel = 'EXTREME';
        } else if (isExtremeVol) {
            riskLevel = 'EXTREME';
        } else if (isBrokenCorrelation) {
            riskLevel = 'HIGH';
        } else if (globalTrend !== 'FLAT') {
            riskLevel = 'MEDIUM';
        }

        // Логируем важные изменения макро-состояния
        // (в реальном проекте здесь стоит добавить проверку "изменилось ли состояние", чтобы не спамить лог)
        
        const permissions = this.calculatePermissions(globalTrend, riskLevel, isBrokenCorrelation);

        return { btc, eth, globalTrend, riskLevel, isBrokenCorrelation, permissions };
    }

    private analyzeAsset(symbol: string, candles: SmartCandle[]): AssetMetric {
        // 1. Calculate Indicators
        const closes = candles.map(c => c.ohlc.c);
        const highs = candles.map(c => c.ohlc.h);
        const lows = candles.map(c => c.ohlc.l);
        const current = candles[candles.length - 1];

        const atr = calculateATR(highs, lows, closes, CONFIG.ATR_PERIOD);
        const safeAtr = atr > 0 ? atr : current.ohlc.c * 0.005;
        
        const emaLocal = calculateEMA(closes, CONFIG.EMA_PERIOD_LOCAL);
        const emaGlobal = calculateEMA(closes, CONFIG.EMA_PERIOD_GLOBAL);

        const deviationLocal = (current.ohlc.c - emaLocal) / safeAtr;
        const deviationGlobal = (current.ohlc.c - emaGlobal) / safeAtr;
        
        const prevClose = candles[Math.max(0, candles.length - 6)].ohlc.c;
        const change5m = current.ohlc.c - prevClose;
        const change5mInAtr = change5m / safeAtr;
        
        const candleRange = (current.ohlc.h - current.ohlc.l) / safeAtr;

        // 2. Load State
        let state = this.states.get(symbol);
        if (!state) {
            state = { 
                confirmed: 'FLAT', 
                candidate: 'FLAT', 
                candidateDuration: 0, 
                duration: 0, 
                volatilityAvg: candleRange 
            };
        }
        state.volatilityAvg = (state.volatilityAvg * 0.9) + (candleRange * 0.1);

        // 3. Detect Raw Signal (Instantaneous)
        let rawSignal: TrendState = 'FLAT';

        // A. Impulse Layer (Pump/Crash)
        if (change5mInAtr >= THRESHOLDS.impulseEntry) rawSignal = 'PUMP';
        else if (change5mInAtr <= -THRESHOLDS.impulseEntry) rawSignal = 'CRASH';
        // Hysteresis Exit for Impulse
        else if (state.confirmed === 'PUMP' && change5mInAtr >= THRESHOLDS.impulseExit) rawSignal = 'PUMP';
        else if (state.confirmed === 'CRASH' && change5mInAtr <= -THRESHOLDS.impulseExit) rawSignal = 'CRASH';
        
        // B. Trend Layer (If not Impulse)
        else {
            const isUp = deviationLocal >= THRESHOLDS.trendEntry && deviationGlobal > 0;
            const isDown = deviationLocal <= -THRESHOLDS.trendEntry && deviationGlobal < 0;

            if (isUp) rawSignal = 'UP';
            else if (isDown) rawSignal = 'DOWN';
            
            // Hysteresis Exit for Trend
            // Если мы уже в тренде, держим его до снижения отклонения ниже 0.5 ATR
            if (state.confirmed === 'UP' && deviationLocal >= THRESHOLDS.trendExit) rawSignal = 'UP';
            if (state.confirmed === 'DOWN' && deviationLocal <= -THRESHOLDS.trendExit) rawSignal = 'DOWN';
        }

        // 4. Candidate Logic (Persistence)
        if (rawSignal === state.candidate) {
            state.candidateDuration++;
        } else {
            state.candidate = rawSignal;
            state.candidateDuration = 1;
        }

        // 5. State Transition (Confirmation)
        const requiredBars = (rawSignal === 'PUMP' || rawSignal === 'CRASH') 
            ? CONFIRMATION.impulse 
            : (rawSignal === 'FLAT' ? CONFIRMATION.exit : CONFIRMATION.trend);

        if (state.candidateDuration >= requiredBars) {
            if (state.confirmed !== state.candidate) {
                this.logger.info(`🔄 Trend Change [${symbol}]: ${state.confirmed} -> ${state.candidate} (Vol: ${state.volatilityAvg.toFixed(2)} ATR)`);
                state.confirmed = state.candidate;
                state.duration = 0;
            } else {
                state.duration++;
            }
        }

        // Save State
        this.states.set(symbol, state);

        return {
            symbol,
            trend: state.confirmed,
            changePct5m: (change5m / prevClose),
            priceVsEma: deviationLocal,
            isVolatile: state.volatilityAvg > CONFIG.THRESHOLD_VOL_EXTREME
        };
    }

    private calculatePermissions(trend: TrendState, risk: RiskLevel, brokenCorr: boolean) {
        let allowLong = true;
        let allowShort = true;
        let reason = 'Market Normal';

        if (trend === 'CRASH') {
            allowLong = false;
            reason = 'PANIC DUMP (Crash Protection)';
        } else if (trend === 'PUMP') {
            allowShort = true;
            reason = 'PANIC PUMP (Trend Protection)';
        } else if (risk === 'EXTREME') {
            allowLong = false;
            allowShort = false;
            reason = 'Extreme Volatility (Side-line)';
        } else if (risk === 'HIGH') {
            reason = brokenCorr ? 'Correlation Broken (Caution)' : 'High Volatility';
        } else if (trend === 'UP') {
            reason = 'Uptrend (Counter-trend allowed with high conf)';
        } else if (trend === 'DOWN') {
            reason = 'Downtrend (Counter-trend allowed with high conf)';
        }

        return { allowLong, allowShort, reason };
    }

    private getNeutralContext(msg: string): MarketContext {
        const n: AssetMetric = { symbol: 'N/A', trend: 'FLAT', changePct5m: 0, priceVsEma: 0, isVolatile: false };
        return { btc: n, eth: n, globalTrend: 'FLAT', riskLevel: 'LOW', isBrokenCorrelation: false, permissions: { allowLong: true, allowShort: true, reason: msg } };
    }
}