import { IMarketDataRepository } from '../../interfaces/services.interface';
import { SmartCandle } from '../../interfaces/market-data.interface';
import { MarketContext, TrendState, RiskLevel, AssetMetric } from '../types/context';
import { Logger } from '../../../shared/logger';
import { calculateATR, calculateEMA } from '../utils/rolling-stats'; // Импортируем ваши утилиты

// Конфигурация теперь опирается на множители ATR, а не фиксированные проценты
const CONFIG = {
    HISTORY_LENGTH: 50,      // Сколько свечей запрашивать
    EMA_PERIOD: 20,          // Период трендовой средней
    ATR_PERIOD: 14,          // Период ATR для динамических порогов

    // Множители ATR для определения состояний
    THRESHOLD_TREND: 1.0,    // Отклонение > 1 ATR = Тренд
    THRESHOLD_CRASH: 3.5,    // Движение > 3.5 ATR = Crash/Pump (Экстремум)
    THRESHOLD_VOLATILE: 2.0  // Свеча размером > 2 ATR = Высокая волатильность
};

export class GlobalTrendService {
    private readonly logger = new Logger('GlobalTrend');

    constructor(
        private readonly marketDataRepo: IMarketDataRepository
    ) { }

    public async analyze(): Promise<MarketContext> {
        // Запрашиваем историю
        const btcCandles = this.marketDataRepo.getHistory('BTCUSDT', CONFIG.HISTORY_LENGTH);
        const ethCandles = this.marketDataRepo.getHistory('ETHUSDT', CONFIG.HISTORY_LENGTH);

        // Проверка достаточности данных
        if (btcCandles.length < CONFIG.EMA_PERIOD || ethCandles.length < CONFIG.EMA_PERIOD) {
            return this.getNeutralContext('Insufficient Data (Warming up)');
        }

        // Анализируем активы с использованием ATR и EMA
        const btc = this.analyzeAsset('BTCUSDT', btcCandles);
        const eth = this.analyzeAsset('ETHUSDT', ethCandles);

        // --- 1. Анализ Корреляции ---
        // Считаем корреляцию сломанной, только если тренды строго противоположны (UP vs DOWN)
        // Игнорируем FLAT vs UP/DOWN, так как это просто временная рассинхронизация
        const isBrokenCorrelation =
            (btc.trend === 'UP' && eth.trend === 'DOWN') ||
            (btc.trend === 'DOWN' && eth.trend === 'UP');

        // --- 2. Определение Глобального Тренда ---
        let globalTrend = btc.trend;

        // Если BTC флэтит, смотрим на ETH (он часто опережает)
        if (btc.trend === 'FLAT' && eth.trend !== 'FLAT') {
            globalTrend = eth.trend;
        }

        // Приоритет экстремальным состояниям
        if (btc.trend === 'CRASH' || eth.trend === 'CRASH') globalTrend = 'CRASH';
        else if (btc.trend === 'PUMP' || eth.trend === 'PUMP') globalTrend = 'PUMP';

        // --- 3. Оценка Уровня Риска ---
        let riskLevel: RiskLevel = 'LOW';

        if (globalTrend === 'CRASH' || globalTrend === 'PUMP') {
            riskLevel = 'EXTREME';
        } else if (isBrokenCorrelation) {
            riskLevel = 'HIGH';
        } else if (btc.isVolatile || eth.isVolatile) {
            riskLevel = 'MEDIUM';
        }

        // --- 4. Формирование Разрешений (Permissions) ---
        const permissions = this.calculatePermissions(globalTrend, riskLevel, isBrokenCorrelation);

        return {
            btc,
            eth,
            globalTrend,
            riskLevel,
            isBrokenCorrelation,
            permissions
        };
    }

    private analyzeAsset(symbol: string, candles: SmartCandle[]): AssetMetric {
        // Подготовка массивов данных для мат. функций
        const closes = candles.map(c => c.ohlc.c);
        const highs = candles.map(c => c.ohlc.h);
        const lows = candles.map(c => c.ohlc.l);

        const current = candles[candles.length - 1];

        // 1. Считаем технические индикаторы (используем утилиты rolling-stats)
        const atr = calculateATR(highs, lows, closes, CONFIG.ATR_PERIOD);
        const ema = calculateEMA(closes, CONFIG.EMA_PERIOD);

        // Защита от деления на ноль, если ATR еще не посчитался
        const safeAtr = atr > 0 ? atr : current.ohlc.c * 0.005;

        // 2. Рассчитываем метрики относительно ATR (Z-score подход)
        const deviation = (current.ohlc.c - ema) / safeAtr; // На сколько ATR цена ушла от средней
        const candleRange = (current.ohlc.h - current.ohlc.l) / safeAtr; // Размер свечи в ATR
        const change5m = (current.ohlc.c - candles[candles.length - 6].ohlc.c); // Изменение за 5 мин (абсолютное)
        const change5mInAtr = change5m / safeAtr;

        // 3. Определение состояния (Trend State)
        let trend: TrendState = 'FLAT';

        // Сначала проверяем экстремумы (Pump/Crash) по импульсу за 5 минут
        if (change5mInAtr <= -CONFIG.THRESHOLD_CRASH) trend = 'CRASH';
        else if (change5mInAtr >= CONFIG.THRESHOLD_CRASH) trend = 'PUMP';
        else {
            // Если экстремума нет, смотрим тренд по EMA
            // Используем гистерезис: нужно отклониться на 1 ATR, чтобы считать трендом
            if (deviation > CONFIG.THRESHOLD_TREND) trend = 'UP';
            else if (deviation < -CONFIG.THRESHOLD_TREND) trend = 'DOWN';
            else trend = 'FLAT';
        }

        const isVolatile = candleRange > CONFIG.THRESHOLD_VOLATILE;

        return {
            symbol,
            trend,
            // Для совместимости оставляем % изменения, но внутри логики используем ATR
            changePct5m: (change5m / candles[candles.length - 6].ohlc.c),
            priceVsEma: deviation, // Теперь это Deviation in ATR units
            isVolatile
        };
    }

    private calculatePermissions(trend: TrendState, risk: RiskLevel, brokenCorr: boolean) {
        let allowLong = true;
        let allowShort = true;
        let reason = 'Market Normal';

        // 1. Экстремальные сценарии (Hard Block)
        if (trend === 'CRASH') {
            allowLong = false; // Ловить падающие ножи на панике запрещено
            allowShort = true;
            reason = 'PANIC DUMP (Crash Protection)';
        }
        else if (trend === 'PUMP') {
            allowLong = true;
            allowShort = false; // Шортить параболу запрещено
            reason = 'PANIC PUMP (Trend Protection)';
        }
        // 2. Высокий риск / Раскорреляция (Soft Warning)
        else if (risk === 'HIGH' || risk === 'EXTREME') {
            // Мы НЕ блокируем сделки полностью, так как это может быть просто волатильность.
            // Но мы передаем причину, чтобы Gatekeepers могли потребовать более высокий Confidence.
            reason = brokenCorr ? 'Correlation Broken (Caution)' : 'High Volatility';

            // Опционально: можно запретить торговлю, если риск EXTREME, но тренд FLAT (пила)
            if (trend === 'FLAT' && risk === 'EXTREME') {
                allowLong = false;
                allowShort = false;
                reason = 'Extreme Chopping (Side-line)';
            }
        }
        // 3. Нормальный тренд (UP/DOWN)
        else if (trend === 'UP') {
            // Разрешаем шорты (allowShort = true), так как это могут быть разворотные стратегии (SFP, Oversold).
            // Но помечаем, что тренд восходящий.
            reason = 'Uptrend (Counter-trend allowed with high conf)';
        }
        else if (trend === 'DOWN') {
            reason = 'Downtrend (Counter-trend allowed with high conf)';
        }

        return { allowLong, allowShort, reason };
    }

    private getNeutralContext(msg: string): MarketContext {
        const n: AssetMetric = { symbol: 'N/A', trend: 'FLAT', changePct5m: 0, priceVsEma: 0, isVolatile: false };
        return {
            btc: n,
            eth: n,
            globalTrend: 'FLAT',
            riskLevel: 'LOW',
            isBrokenCorrelation: false,
            permissions: { allowLong: true, allowShort: true, reason: msg }
        };
    }
}