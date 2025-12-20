import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as dns from 'dns';

// Настройка DNS resolver для Node.js (решает проблемы с DNS в Windows)
dns.setDefaultResultOrder('ipv4first');

// Загрузка конфига
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { AppDataSource, DatabaseModule } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';

// Импортируем наш новый провайдер
import { CockroachDBDataProvider, getCockroachDBDataProvider } from '../src/domain/signal-analyzer/adapters/cockoroach.provider'; // <-- подставь правильный путь

// НАСТРОЙКИ
const LIMIT_PER_SYMBOL = 1500; // ~16–24 часа данных, в зависимости от таймфрейма
const BATCH_SIZE = 20;         // Сколько символов запрашиваем за один батч-запрос (оптимально для производительности)

async function syncAll() {
    console.log('🚀 Starting FULL MARKET Sync (CockroachDB -> Local SQLite)...');

    // 1. Инициализация локальной БД (TypeORM + SQLite)
    await DatabaseModule.initialize();
    const localRepo = AppDataSource.getRepository(HistoryCandle);

    // 2. Создаём провайдер для CockroachDB
    const cockroachProvider = getCockroachDBDataProvider();

    if (!cockroachProvider.isConfigured()) {
        console.error('❌ CockroachDB connection string or cert not configured.');
        process.exit(1);
    }

    try {
        // 3. Получаем список всех активных символов (за последний час)
        console.log('📋 Fetching list of active symbols from CockroachDB...');
        const allSymbols = await cockroachProvider.getAvailableSymbols();

        if (allSymbols.length === 0) {
            console.error('⚠️ No symbols found in CockroachDB (maybe no recent data?).');
            process.exit(1);
        }

        console.log(`✅ Found ${allSymbols.length} active symbols. Starting sync in batches of ${BATCH_SIZE}...`);

        let processed = 0;
        let totalCandles = 0;

        // Обрабатываем батчами — это КЛЮЧЕВОЕ улучшение!
        // Один запрос на 20 символов вместо 100 отдельных = в 20 раз быстрее и меньше нагрузки
        for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
            const batch = allSymbols.slice(i, i + BATCH_SIZE);
            processed += batch.length;

            try {
                // Один батч-запрос на несколько символов
                const historyMap = await cockroachProvider.getHistoryForMany(batch, LIMIT_PER_SYMBOL);

                // Обрабатываем каждый символ в батче
                for (const symbol of batch) {
                    const bars = historyMap.get(symbol) || [];

                    process.stdout.write(`[${processed}/${allSymbols.length}] ${symbol.padEnd(12)}`);

                    if (bars.length === 0) {
                        console.log('-> ⚠️ Empty');
                        continue;
                    }

                    // Удаляем старые данные и сохраняем новые
                    await localRepo.delete({ symbol });

                    const entities = bars.map(bar => {
                        const entity = new HistoryCandle();
                        entity.symbol = symbol;
                        entity.ts = bar.ts;
                        entity.data = bar as any;
                        return entity;
                    });

                    await AppDataSource.transaction(async (manager) => {
                        await manager.save(HistoryCandle, entities, { chunk: 500 });
                    });

                    totalCandles += bars.length;
                    console.log(`-> ✅ ${bars.length} candles`);
                }

                // Пауза между батчами (CockroachDB выдержит и без, но на всякий случай)
                if (i + BATCH_SIZE < allSymbols.length) {
                    await new Promise(r => setTimeout(r, 300)); // 300мс между батчами
                }

            } catch (err: any) {
                console.log(`-> ❌ Batch error (symbols ${i}-${i + batch.length - 1}): ${err.message}`);
                // Продолжаем со следующим батчем
            }
        }

        console.log('\n=======================================');
        console.log(`🎉 Full Sync Complete!`);
        console.log(`📊 Processed symbols: ${allSymbols.length}`);
        console.log(`📉 Total candles saved: ${totalCandles}`);
        console.log(`💾 Estimated size on disk: ~${(totalCandles * 0.0005).toFixed(1)} MB`);
        console.log('=======================================');

    } catch (e: any) {
        console.error('Fatal error:', e.message || e);
    } finally {
        await cockroachProvider.shutdown(); // Закрываем пул соединений
        await DatabaseModule.close();
    }
}

syncAll().catch(console.error);