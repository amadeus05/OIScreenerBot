import 'reflect-metadata';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as dns from 'dns';
import { performance } from 'perf_hooks';

// Настройка DNS resolver (для Windows/WSL часто критично)
dns.setDefaultResultOrder('ipv4first');

// Загрузка конфига
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { AppDataSource, DatabaseModule } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';

// Твой путь к провайдеру
import { getCockroachDBDataProvider } from '../src/domain/signal-analyzer/adapters/cockoroach.provider';

// НАСТРОЙКИ
const LIMIT_PER_SYMBOL = 7500; // С запасом под 6700 записей
const BATCH_SIZE = 5;          // Уменьшили, чтобы не взорвать память (5 * 6700 = ~33k записей за такт)
const SQL_CHUNK_SIZE = 1000;   // Размер пачки для INSERT в SQLite

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function syncAll() {
    console.log('🚀 Starting FULL MARKET Sync (CockroachDB -> Local SQLite)...');

    // 1. Инициализация
    await DatabaseModule.initialize();
    
    // Используем QueryRunner для максимальной производительности и контроля памяти
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();

    // 2. Провайдер
    const cockroachProvider = getCockroachDBDataProvider();

    if (!cockroachProvider.isConfigured()) {
        console.error('❌ CockroachDB connection string or cert not configured.');
        process.exit(1);
    }

    try {
        // 3. Получаем список символов
        console.log('📋 Fetching list of active symbols from CockroachDB...');
        const allSymbols = await cockroachProvider.getAvailableSymbols();

        if (allSymbols.length === 0) {
            console.error('⚠️ No symbols found in CockroachDB.');
            process.exit(1);
        }

        console.log(`✅ Found ${allSymbols.length} active symbols.`);
        console.log(`⚡ Mode: Batch Size ${BATCH_SIZE} | Limit ${LIMIT_PER_SYMBOL}`);

        let processed = 0;
        let totalCandles = 0;
        const startTime = performance.now();

        // 4. Обрабатываем батчами
        for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
            const batch = allSymbols.slice(i, i + BATCH_SIZE);
            processed += batch.length;
            
            process.stdout.write(`Batch [${processed}/${allSymbols.length}] fetching... `);

            try {
                // А. Запрашиваем данные пачкой (сетевая оптимизация)
                const historyMap = await cockroachProvider.getHistoryForMany(batch, LIMIT_PER_SYMBOL);
                
                let batchCandlesCount = 0;

                // Б. Обрабатываем каждый символ из полученной пачки
                for (const symbol of batch) {
                    const bars = historyMap.get(symbol) || [];

                    if (bars.length === 0) continue;

                    // Оптимизация памяти: создаем простые объекты, а не классы
                    const rowsToInsert = bars.map(bar => ({
                        symbol: symbol,
                        ts: bar.ts,
                        data: bar // SQLite сохранит это как JSON
                    }));

                    // В. Транзакция (Удаление + Вставка)
                    await queryRunner.startTransaction();
                    try {
                        // 1. Быстрое удаление
                        await queryRunner.manager
                            .createQueryBuilder()
                            .delete()
                            .from(HistoryCandle)
                            .where("symbol = :symbol", { symbol })
                            .execute();

                        // 2. Быстрая вставка (chunked insert)
                        // .insert() намного быстрее .save() и не ест память
                        await queryRunner.manager
                            .createQueryBuilder()
                            .insert()
                            .into(HistoryCandle)
                            .values(rowsToInsert)
                            .orIgnore() 
                            .execute();

                        await queryRunner.commitTransaction();
                        
                        batchCandlesCount += bars.length;
                        totalCandles += bars.length;
                    } catch (dbErr) {
                        await queryRunner.rollbackTransaction();
                        console.error(`\n❌ DB Error on ${symbol}:`, dbErr);
                    }
                }

                console.log(`-> ✅ Saved ${batchCandlesCount} candles (Batch OK)`);

                // Небольшая пауза, чтобы дать GC (Garbage Collector) отработать и не грузить сеть
                await sleep(200);

            } catch (err: any) {
                console.log(`\n-> ❌ Batch network error: ${err.message}`);
                // Если упал запрос к CockroachDB, идем дальше, транзакции не открывались
            }
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(1);

        console.log('\n=======================================');
        console.log(`🎉 Full Sync Complete in ${duration}s!`);
        console.log(`📊 Total Symbols: ${allSymbols.length}`);
        console.log(`📉 Total Candles: ${totalCandles}`);
        console.log(`💾 Size on disk: ~${(totalCandles * 0.0005).toFixed(1)} MB`);
        console.log('=======================================');

    } catch (e: any) {
        console.error('Fatal error:', e.message || e);
    } finally {
        if (!queryRunner.isReleased) {
            await queryRunner.release();
        }
        await cockroachProvider.shutdown();
        await DatabaseModule.close();
    }
}

syncAll().catch(console.error);