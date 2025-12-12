import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Загрузка конфига
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { AppDataSource, DatabaseModule } from '../src/infrastructure/database/database.module';
import { getSupabaseDataProvider } from '../src/domain/signal-analyzer';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';

// НАСТРОЙКИ
const LIMIT_PER_SYMBOL = 1500; // Берем последние 1000 свечей (~16 часов)
// Если брать больше, скрипт будет работать дольше, но данных будет больше.

async function syncAll() {
    console.log('🚀 Starting FULL MARKET Sync (Supabase -> Local SQLite)...');

    // 1. Подключение
    await DatabaseModule.initialize();
    const localRepo = AppDataSource.getRepository(HistoryCandle);
    const supabaseProvider = getSupabaseDataProvider();

    if (!supabaseProvider.isConfigured()) {
        console.error('❌ Supabase credentials missing.');
        process.exit(1);
    }

    try {
        // 2. Получаем список ВСЕХ монет, которые есть в базе
        console.log('📋 Fetching list of tracked symbols...');
        
        // Используем метод провайдера, который делает DISTINCT запрос
        // (убедись, что в базе есть свечи за последний час, иначе список будет неполным)
        const allSymbols = await supabaseProvider.getAvailableSymbols();
        
        if (allSymbols.length === 0) {
            console.error('⚠️ No symbols found in Supabase (check time range in provider).');
            process.exit(1);
        }

        console.log(`✅ Found ${allSymbols.length} active symbols. Starting sync...`);

        // 3. Итерируемся по всем монетам
        let processed = 0;
        let totalCandles = 0;

        for (const symbol of allSymbols) {
            processed++;
            process.stdout.write(`[${processed}/${allSymbols.length}] Syncing ${symbol.padEnd(10)} `);

            try {
                // А. Скачиваем данные (ОДИН легкий запрос)
                const historyMap = await supabaseProvider.getHistoryForMany([symbol], LIMIT_PER_SYMBOL);
                const bars = historyMap.get(symbol) || [];

                if (bars.length === 0) {
                    console.log('-> ⚠️ Empty');
                    continue;
                }

                // Б. Удаляем старое (чтобы не было дублей)
                await localRepo.delete({ symbol });

                // В. Конвертируем и сохраняем
                const entities = bars.map(bar => {
                    const entity = new HistoryCandle();
                    entity.symbol = symbol;
                    entity.ts = bar.ts;
                    entity.data = bar as any;
                    return entity;
                });

                // Транзакционное сохранение (быстрое)
                await AppDataSource.transaction(async (manager) => {
                    await manager.save(HistoryCandle, entities, { chunk: 500 });
                });

                totalCandles += bars.length;
                console.log(`-> ✅ Saved ${bars.length} candles`);

                // Г. ПАУЗА (Rate Limiting)
                // Бесплатный тариф Supabase не любит частые запросы.
                // 500мс = 2 запроса в секунду. Это безопасно.
                await new Promise(r => setTimeout(r, 500));

            } catch (err: any) {
                console.log(`-> ❌ Error: ${err.message}`);
            }
        }

        console.log('\n=======================================');
        console.log(`🎉 Full Sync Complete!`);
        console.log(`📉 Total Candles: ${totalCandles}`);
        console.log(`💾 Size on disk: ~${(totalCandles * 0.0005).toFixed(1)} MB`);
        console.log('=======================================');

    } catch (e) {
        console.error('Fatal error:', e);
    } finally {
        await DatabaseModule.close();
    }
}

syncAll();