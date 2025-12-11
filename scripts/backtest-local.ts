import 'reflect-metadata';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { SignalAnalyzerService, BarData } from '../src/domain/signal-analyzer';
import { LevelsModule, LiquidationModule, MomentumModule, OIModule, OrderflowModule } from '../src/domain/signal-analyzer/modules';
import { Logger } from '../src/shared/logger';

// КОНФИГ ТЕСТА
const SYMBOLS_TO_TEST =  [
'ETHUSDT', 'NEARUSDT', 'LTCUSDT', 'ORDIUSDT', 
    'TIAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'FETUSDT', 'GUSDT'
]; ;

const INITIAL_BALANCE = 1000;
const BET_SIZE = 100;

async function runLocalBacktest() {
    const logger = new Logger('LocalBacktest');

    // 1. Подключаемся к локальной базе
    await DatabaseModule.initialize();
    const historyRepo = AppDataSource.getRepository(HistoryCandle);

    // 2. Инициализируем Анализатор с модулями
    const modules = [
        new MomentumModule(), new OrderflowModule(), new OIModule(), 
        new LiquidationModule(), new LevelsModule()
    ];
    // Здесь можно передать конфиг с измененными весами!
    const analyzer = new SignalAnalyzerService(modules);

    console.log('🚀 Starting INSTANT Backtest (from Local SQLite)...');
    
    let totalPnL = 0;
    let wins = 0; 
    let losses = 0;

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
        let activeTrade = null;
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
                    const pnlRaw = res === 'WIN' 
                        ? (Math.abs(activeTrade.tp[0] - activeTrade.entry) / activeTrade.entry)
                        : -(Math.abs(activeTrade.sl - activeTrade.entry) / activeTrade.entry);
                    
                    const pnlUsd = pnlRaw * BET_SIZE * 10; // Leverage x10
                    totalPnL += pnlUsd;
                    res === 'WIN' ? wins++ : losses++;
                    
                    console.log(`   ${res === 'WIN' ? '✅' : '❌'} ${activeTrade.action} Closed. PnL: $${pnlUsd.toFixed(2)}`);
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
    console.log(`💰 Net PnL: $${totalPnL.toFixed(2)}`);
    console.log('=======================================');

    await DatabaseModule.close();
}

function checkTrade(trade: any, bar: BarData) {
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