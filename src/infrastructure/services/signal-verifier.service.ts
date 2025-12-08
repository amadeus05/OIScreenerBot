import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { AnalizationResultRepository } from '../../infrastructure/repositories/analization-result.repository';
import { AnalizationResult, SignalStatus } from '../../domain/entities/analization-result.entity';
import { getSupabaseDataProvider } from '../../domain/signal-analyzer/adapters/supabase.provider';
import { BarData } from '../../domain/signal-analyzer/types';

@Injectable()
export class SignalVerifierService {
    private readonly logger = new Logger('SignalVerifier');
    private readonly supabaseProvider = getSupabaseDataProvider();

    constructor(
        private readonly resultRepo: AnalizationResultRepository
    ) {}

    async start(){
        setInterval(async () => {
            try {
                await this.verifyPendingSignals(); // Использовать this, а не созданный verifier
            } catch (e) {
                console.error('Verification loop failed:', e);
            }
        }, 60 * 1000);
    }

    /**
     * Основной метод, который нужно вызывать по CRON (например, раз в минуту)
     */
    async verifyPendingSignals(): Promise<void> {
        this.logger.info('Starting signal verification cycle...');
        
        // 1. Получаем все активные сигналы
        const pendingSignals = await this.resultRepo.getPendingSignals();
        if (pendingSignals.length === 0) {
            this.logger.debug('No pending signals to verify.');
            return;
        }

        this.logger.info(`Found ${pendingSignals.length} pending signals. Grouping by symbol...`);

        // 2. Группируем по символам, чтобы делать меньше запросов к Supabase
        const signalsBySymbol: Record<string, AnalizationResult[]> = {};
        for (const signal of pendingSignals) {
            if (!signalsBySymbol[signal.symbol]) {
                signalsBySymbol[signal.symbol] = [];
            }
            signalsBySymbol[signal.symbol].push(signal);
        }

        // 3. Обрабатываем каждый символ
        for (const [symbol, signals] of Object.entries(signalsBySymbol)) {
            await this.processSymbolSignals(symbol, signals);
        }

        this.logger.info('Verification cycle complete.');
    }

    private async processSymbolSignals(symbol: string, signals: AnalizationResult[]): Promise<void> {
        try {
            // Находим самый старый сигнал, чтобы знать, сколько истории запрашивать
            const oldestSignalTs = Math.min(...signals.map(s => s.ts.getTime()));
            const now = Date.now();
            
            // Если сигналу больше недели, считаем expired без запроса (экономия)
            const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
            if (now - oldestSignalTs > MAX_AGE_MS) {
                // Логика массового закрытия старых...
            }

            // Запрашиваем свечи с Supabase. 
            // Берем с запасом. Если SupabaseDataProvider.getHistory возвращает последние N свечей,
            // убедитесь, что limit достаточно большой, либо реализуйте fetchByTimeRange.
            // Здесь используем стандартный getHistory, предполагая, что 500-1000 свечей хватит для недавних сигналов.
            const limit = 500; 
            const candles = await this.supabaseProvider.getHistory(symbol, limit);

            if (candles.length === 0) return;

            // Сортируем свечи от старых к новым для симуляции
            const sortedCandles = [...candles].sort((a, b) => a.ts - b.ts);

            for (const signal of signals) {
                await this.checkSingleSignal(signal, sortedCandles);
            }

        } catch (error) {
            this.logger.error(`Error verifying signals for ${symbol}:`, error);
        }
    }

    private async checkSingleSignal(signal: AnalizationResult, candles: BarData[]): Promise<void> {
        const signalTs = signal.ts.getTime();
        
        // Фильтруем только те свечи, которые появились ПОСЛЕ сигнала
        // Игнорируем ту же минуту, когда сигнал был создан, чтобы избежать ложных срабатываний на той же свече
        const relevantCandles = candles.filter(c => c.ts > signalTs);

        if (relevantCandles.length === 0) return;

        let status: SignalStatus = SignalStatus.PENDING;
        let exitPrice: number | null = null;
        let closeTs: Date | null = null;

        const isLong = signal.action === 'LONG';
        const tp1 = signal.tp[0]; // Целимся в первый TP
        const sl = signal.sl;

        let maxPrice = -Infinity;
        let minPrice = Infinity;

        // --- ЛОГИКА СИМУЛЯЦИИ ---
        for (const candle of relevantCandles) {
            // Обновляем экстремумы
            maxPrice = Math.max(maxPrice, candle.h);
            minPrice = Math.min(minPrice, candle.l);

            // Проверка SL и TP внутри одной свечи
            // Консервативный подход: если в одной свече и TP и SL, считаем что сначала выбило SL
            
            if (isLong) {
                // 1. Проверяем SL (Low <= SL)
                if (candle.l <= sl) {
                    status = SignalStatus.LOSS;
                    exitPrice = sl; // Исполнение по стопу
                    closeTs = new Date(candle.ts);
                    break;
                }
                // 2. Проверяем TP (High >= TP)
                if (candle.h >= tp1) {
                    status = SignalStatus.WIN;
                    exitPrice = tp1;
                    closeTs = new Date(candle.ts);
                    break;
                }
            } else { // SHORT
                // 1. Проверяем SL (High >= SL)
                if (candle.h >= sl) {
                    status = SignalStatus.LOSS;
                    exitPrice = sl;
                    closeTs = new Date(candle.ts);
                    break;
                }
                // 2. Проверяем TP (Low <= TP)
                if (candle.l <= tp1) {
                    status = SignalStatus.WIN;
                    exitPrice = tp1;
                    closeTs = new Date(candle.ts);
                    break;
                }
            }

            // 3. Проверяем истечение времени (Horizon)
            const minutesSinceSignal = (candle.ts - signalTs) / 60000;
            if (signal.horizonMin > 0 && minutesSinceSignal > signal.horizonMin * 2) { 
                // Даем х2 времени от горизонта, прежде чем закрыть принудительно
                // Или можно просто проверять актуальность цены
                status = SignalStatus.EXPIRED;
                exitPrice = candle.c;
                closeTs = new Date(candle.ts);
                break;
            }
        }

        // Если статус изменился, сохраняем в БД
        if (status !== SignalStatus.PENDING) {
            signal.status = status;
            signal.exitPrice = exitPrice;
            signal.closedAt = closeTs;
            
            // Расчет PnL %
            if (exitPrice) {
                if (isLong) {
                    signal.realizedPnlPct = ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100;
                } else {
                    signal.realizedPnlPct = ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;
                }
            }

            // Метрика "Max Excursion" (насколько хорошо шла цена)
            // Для лонга - макс цена, для шорта - мин цена
            signal.maxPriceReached = isLong ? maxPrice : minPrice;

            await this.resultRepo.save(signal);
            
            this.logger.info(`Signal VERIFIED [${signal.symbol}]: ${status} (${signal.realizedPnlPct?.toFixed(2)}%)`);
        }
    }
}