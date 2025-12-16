import 'reflect-metadata';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { SignalAnalyzerService, BarData } from '../src/domain/signal-analyzer';
import { MeanReversionModule, OIModule } from '../src/domain/signal-analyzer/modules';
import { Logger } from '../src/shared/logger';
import { TradeGatekeeper } from '../src/domain/signal-analyzer/gatekeeper/trade-gatekeeper';

/**
 * Тип для описания активной сделки в бэктесте.
 */
interface BacktestTrade {
    action: 'LONG' | 'SHORT';
    entry: number;
    tp: number[];
    sl: number;
    ts: number;
}

// КОНФИГ ТЕСТА
const SYMBOLS_TO_TEST =  [
'ETHUSDT', 'NEARUSDT', 'LTCUSDT', 'ORDIUSDT', 
    'TIAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'FETUSDT', 'GUSDT'
]; ;

/**
 * Начальный баланс для бэктеста (в USDT)
 * @default 1000
 */
const INITIAL_BALANCE = 1000;

/**
 * Леверидж для расчета размера позиции
 * @default 10
 */
const LEVERAGE = 10;

/**
 * Комиссия Binance (одна сторона) фьючерсы: 0.04% (=0.0004), округлено
 * @default 0.0004
 */
const BINANCE_COMMISSION_RATE = 0.0004;

/**
 * Фиксированный размер ставки (ставка на одну сделку), USDT
 * Можно поставить дробное значение либо процент от баланса если требуется динамическое
 */
const BET_SIZE = 100;

async function runLocalBacktest() {
    const logger = new Logger('LocalBacktest');

    // 1. Подключаемся к локальной базе
    await DatabaseModule.initialize();
    const historyRepo = AppDataSource.getRepository(HistoryCandle);

    // 2. Инициализируем Анализатор с модулями
    const modules = [
        new MeanReversionModule(), new OIModule(), 

    ];
    const  gate = new TradeGatekeeper([])
    // Здесь можно передать конфиг с измененными весами!
    const analyzer = new SignalAnalyzerService(modules, gate);

    console.log('🚀 Starting INSTANT Backtest (from Local SQLite)...');
    
    let totalPnL = 0;
    let wins = 0; 
    let losses = 0;
    /**
     * Баланс для симуляции (изменяется в ходе теста)
     */
    let balance = INITIAL_BALANCE;
    /**
     * Итоговая сумма уплаченных комиссий
     */
    let totalFeesPaid = 0;

    for (const symbol of SYMBOLS_TO_TEST) {
        // 3. Выгружаем все свечи из SQLite одним запросом
        const entities = await historyRepo.find({
            where: { symbol },
            order: { ts: 'ASC' }
        });

        if (entities.length < 50) {
            console.log(`⚠️ Not enough data for ${symbol}`);
            continue;
        }

        // Достаем JSON обратно в BarData
        const bars = entities.map(e => e.data as unknown as BarData);
        console.log(`\n📊 Analyzing ${symbol} (${bars.length} candles)...`);

        // 4. Симуляция (Loop)
        let activeTrade: BacktestTrade | null = null;
        const warmup = 100; // Прогрев индикаторов

        // Прогреваем
        analyzer.warmUp(symbol, bars.slice(0, warmup));

        for (let i = warmup; i < bars.length; i++) {
            const currentBar = bars[i];
            const slice = bars.slice(0, i + 1);

            // А. Проверка выхода из сделки
            if (activeTrade) {
                const res = checkTrade(activeTrade, currentBar);
                if (res !== 'PENDING') {
                    const entry = activeTrade.entry;
                    const exit = res === 'WIN' ? activeTrade.tp[0] : activeTrade.sl;
                    const direction = activeTrade.action === 'LONG' ? 1 : -1;
                    // Рассчёт доходности сделки с учетом направления
                    const pnlRaw = direction * (exit - entry) / entry;
                    const positionSize = BET_SIZE * LEVERAGE;
                    let pnlUsd = pnlRaw * positionSize;

                    // Комиссия за открытие и закрытие позиции (двусторонняя)
                    const commission = 2 * positionSize * BINANCE_COMMISSION_RATE;
                    pnlUsd -= commission; // Учтём комиссию сразу в pnl
                    totalFeesPaid += commission;
                    
                    balance += pnlUsd; // обновляем баланс с учетом pnl и комиссии
                    totalPnL += pnlUsd;
                    res === 'WIN' ? wins++ : losses++;

                    console.log(`   ${res === 'WIN' ? '✅' : '❌'} ${activeTrade.action} Closed. PnL: $${pnlUsd.toFixed(2)} (Fee: $${commission.toFixed(2)}) Bal: $${balance.toFixed(2)}`);
                    activeTrade = null;
                }
                continue;
            }

            // Б. Анализ
            const signal = analyzer.analyze(symbol, slice);

            // В. Вход
            if (signal.action !== 'NO_TRADE') {
                console.log(`⚡ SIGNAL [${new Date(currentBar.ts).toISOString().slice(11,16)}]: ${signal.action} @ ${signal.entryPrice} (Conf: ${signal.confidence.toFixed(2)})`);
                activeTrade = {
                    action: signal.action,
                    entry: signal.entryPrice,
                    tp: signal.tp,
                    sl: signal.sl,
                    ts: currentBar.ts
                };
            }
        }
    }

    console.log('\n=======================================');
    console.log(`🏁 RESULT: ${wins}W / ${losses}L`);
    console.log(`💰 Net PnL After Fees: $${totalPnL.toFixed(2)}`);
    console.log(`💸 Total Binance Fees Paid: $${totalFeesPaid.toFixed(2)}`);
    console.log(`🏦 FINAL Balance (with leverage effect): $${balance.toFixed(2)}`);
    console.log('=======================================');

    await DatabaseModule.close();
}

function checkTrade(trade: BacktestTrade, bar: BarData) {
    if (trade.action === 'LONG') {
        if (bar.l <= trade.sl) return 'LOSS';
        if (bar.h >= trade.tp[0]) return 'WIN';
    } else {
        if (bar.h >= trade.sl) return 'LOSS';
        if (bar.l <= trade.tp[0]) return 'WIN';
    }
    // Time stop (2 часа)
    if (bar.ts - trade.ts > 120 * 60000) return 'LOSS';
    return 'PENDING';
}

runLocalBacktest();