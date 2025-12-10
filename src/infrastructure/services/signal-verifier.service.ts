import { Inject, Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { AnalizationResultRepository } from '../../infrastructure/repositories/analization-result.repository';
import { AnalizationResult, SignalStatus } from '../../domain/entities/analization-result.entity';
import { BarData } from '../../domain/signal-analyzer/types';
import { IMarketDataRepository } from '../../domain/interfaces/services.interface';
import { smartCandlesToBarData } from '../../domain/signal-analyzer/adapters/smart-candle.adapter';

@Injectable()
export class SignalVerifierService {
    private readonly logger = new Logger('SignalVerifier');

    constructor(
        private readonly resultRepo: AnalizationResultRepository,
        // Внедряем локальный репозиторий вместо Supabase
        @Inject('IMarketDataRepository') private readonly marketDataRepository: IMarketDataRepository
    ) {}

    /**
     * Запуск периодической проверки (CRON)
     */
    async start() {
        this.logger.info('Signal Verifier Service started (Local Memory Mode)');
        
        // Проверка каждую минуту
        setInterval(async () => {
            try {
                await this.verifyPendingSignals();
            } catch (e) {
                this.logger.error('Verification loop failed:', e);
            }
        }, 60 * 1000);
    }

    /**
     * Основной цикл проверки
     */
    async verifyPendingSignals(): Promise<void> {
        // 1. Получаем все сигналы со статусом PENDING
        const pendingSignals = await this.resultRepo.getPendingSignals();
        
        if (pendingSignals.length === 0) {
            // this.logger.debug('No pending signals to verify.');
            return;
        }

        this.logger.info(`Verifying ${pendingSignals.length} pending signals...`);

        // 2. Группируем по символам для эффективности
        const signalsBySymbol: Record<string, AnalizationResult[]> = {};
        for (const signal of pendingSignals) {
            if (!signalsBySymbol[signal.symbol]) {
                signalsBySymbol[signal.symbol] = [];
            }
            signalsBySymbol[signal.symbol].push(signal);
        }

        // 3. Обрабатываем каждую монету
        for (const [symbol, signals] of Object.entries(signalsBySymbol)) {
            await this.processSymbolSignals(symbol, signals);
        }
    }

    private async processSymbolSignals(symbol: string, signals: AnalizationResult[]): Promise<void> {
        try {
            // БЕРЕМ ДАННЫЕ ИЗ ПАМЯТИ (Быстро и бесплатно)
            // Запрашиваем 1000 последних свечей. Этого хватит для сигналов за последние сутки.
            const smartCandles = this.marketDataRepository.getHistory(symbol, 1000);

            if (smartCandles.length === 0) {
                // Если бот только включился и данных еще нет - пропускаем
                return;
            }

            // Конвертируем в формат BarData, понятный для анализа
            const candles: BarData[] = smartCandlesToBarData(smartCandles, symbol);

            // Убеждаемся, что сортировка хронологическая (Старые -> Новые)
            const sortedCandles = [...candles].sort((a, b) => a.ts - b.ts);

            // Проверяем каждый сигнал по этой монете
            for (const signal of signals) {
                await this.checkSingleSignal(signal, sortedCandles);
            }

        } catch (error) {
            this.logger.error(`Error verifying signals for ${symbol}:`, error);
        }
    }

    private async checkSingleSignal(signal: AnalizationResult, candles: BarData[]): Promise<void> {
        const signalTs = signal.ts.getTime();

        // Берем только те свечи, которые закрылись ПОСЛЕ создания сигнала
        const relevantCandles = candles.filter(c => c.ts > signalTs);

        if (relevantCandles.length === 0) {
            // Нет новых данных после сигнала -> ждем
            return;
        }

        let status: SignalStatus = SignalStatus.PENDING;
        let exitPrice: number | null = null;
        let closeTs: Date | null = null;
        
        // Для статистики: до куда максимально доходила цена в нашу сторону
        let maxPrice = -Infinity; 
        let minPrice = Infinity;

        const isLong = signal.action === 'LONG';
        // TP targets
        const tp1 = signal.tp[0];
        const sl = signal.sl;

        // --- СИМУЛЯЦИЯ ТОРГОВЛИ ---
        for (const candle of relevantCandles) {
            // Обновляем экстремумы для статистики
            maxPrice = Math.max(maxPrice, candle.h);
            minPrice = Math.min(minPrice, candle.l);

            if (isLong) {
                // ЛОНГ: 
                // 1. Сначала проверяем Stop Loss (худший сценарий)
                // Если Low свечи ниже SL - нас выбило
                if (candle.l <= sl) {
                    status = SignalStatus.LOSS;
                    exitPrice = sl;
                    closeTs = new Date(candle.ts);
                    break;
                }
                // 2. Проверяем Take Profit
                // Если High свечи выше TP1 - мы забрали профит
                if (candle.h >= tp1) {
                    status = SignalStatus.WIN;
                    exitPrice = tp1;
                    closeTs = new Date(candle.ts);
                    break;
                }
            } else { 
                // ШОРТ:
                // 1. Проверяем SL (High выше SL)
                if (candle.h >= sl) {
                    status = SignalStatus.LOSS;
                    exitPrice = sl;
                    closeTs = new Date(candle.ts);
                    break;
                }
                // 2. Проверяем TP (Low ниже TP)
                if (candle.l <= tp1) {
                    status = SignalStatus.WIN;
                    exitPrice = tp1;
                    closeTs = new Date(candle.ts);
                    break;
                }
            }

            // 3. Проверка истечения времени (Horizon)
            // Если прошло времени больше, чем 2 * horizonMin -> закрываем по рынку (EXPIRED)
            const minutesSinceSignal = (candle.ts - signalTs) / 60000;
            if (signal.horizonMin > 0 && minutesSinceSignal > signal.horizonMin * 2) {
                status = SignalStatus.EXPIRED;
                exitPrice = candle.c; // Выходим по цене закрытия текущей свечи
                closeTs = new Date(candle.ts);
                break;
            }
        }

        // --- СОХРАНЕНИЕ РЕЗУЛЬТАТА ---
        if (status !== SignalStatus.PENDING) {
            signal.status = status;
            signal.exitPrice = exitPrice;
            signal.closedAt = closeTs;
            signal.maxPriceReached = isLong ? maxPrice : minPrice;

            // Расчет реализованного PnL %
            if (exitPrice) {
                if (isLong) {
                    signal.realizedPnlPct = ((exitPrice - signal.entryPrice) / signal.entryPrice) * 100;
                } else {
                    // Для шорта: (Вход - Выход) / Вход
                    signal.realizedPnlPct = ((signal.entryPrice - exitPrice) / signal.entryPrice) * 100;
                }
            }

            await this.resultRepo.save(signal);
            this.logger.info(`Signal VERIFIED [${signal.symbol}] ${signal.action}: ${status} (PnL: ${signal.realizedPnlPct?.toFixed(2)}%)`);
        }
    }
}