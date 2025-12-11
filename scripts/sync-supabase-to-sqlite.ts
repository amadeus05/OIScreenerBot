import 'reflect-metadata';
import 'dotenv/config'; // <--- ДОБАВИТЬ ЭТУ СТРОКУ
import { AppDataSource, DatabaseModule } from '../src/infrastructure/database/database.module';
import { getSupabaseDataProvider } from '../src/domain/signal-analyzer';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { smartCandleToBarData } from '../src/domain/signal-analyzer/adapters/smart-candle.adapter';


// СПИСОК (Можете добавить больше, теперь это безопасно)
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 
 'NEARUSDT', 'LTCUSDT', 'ORDIUSDT', 
    'TIAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'FETUSDT', 'GUSDT'
]; 
const LIMIT_PER_SYMBOL = 1440; // 24 часа

async function sync() {
    console.log('🚀 Starting Sequential Sync: Supabase -> Local SQLite...');

    // 1. Init
    await DatabaseModule.initialize();
    const repo = AppDataSource.getRepository(HistoryCandle);

    const supabase = getSupabaseDataProvider();
    if (!supabase.isConfigured()) {
        console.error('❌ Supabase key missing');
        process.exit(1);
    }

    // 2. ЦИКЛ ПО ОДНОЙ МОНЕТЕ (Чтобы не было Timeout)
    for (const symbol of SYMBOLS) {
        try {
            console.log(`\n⏳ Fetching ${symbol} (${LIMIT_PER_SYMBOL} candles)...`);
            
            // Запрашиваем массив только из ОДНОГО символа
            // Это создает легкий запрос: SELECT ... WHERE symbol = 'BTCUSDT' ... LIMIT 1440
            const historyMap = await supabase.getHistoryForMany([symbol], LIMIT_PER_SYMBOL);
            const bars = historyMap.get(symbol);

            if (!bars || bars.length === 0) {
                console.log(`⚠️ No data for ${symbol}`);
                continue;
            }

            console.log(`📥 Received ${bars.length} candles. Saving to SQLite...`);

            // Очищаем старые данные для этой монеты перед записью (чтобы не дублировать)
            await repo.delete({ symbol });

            // Конвертация и сохранение
            const entities = bars.map(bar => {
                const entity = new HistoryCandle();
                entity.symbol = symbol;
                entity.ts = bar.ts;
                entity.data = bar as any; 
                return entity;
            });

            // Сохраняем пачками по 500 (SQLite любит маленькие транзакции)
            await AppDataSource.transaction(async (manager) => {
                await manager.save(HistoryCandle, entities, { chunk: 500 });
            });

            console.log(`✅ Saved ${symbol} successfully.`);

            // Пауза 1 секунда, чтобы не душить бесплатный тариф
            await new Promise(r => setTimeout(r, 1000));

        } catch (e: any) {
            console.error(`❌ Failed to sync ${symbol}:`, e.message || e);
        }
    }

    console.log('\n🎉 Sync Complete!');
    await DatabaseModule.close();
}

sync();