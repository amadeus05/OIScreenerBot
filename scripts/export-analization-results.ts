import 'reflect-metadata';
import { AppDataSource } from '../src/infrastructure/database/database.module';
import { AnalizationResult, SignalStatus } from '../src/domain/entities/analization-result.entity';
import { createObjectCsvWriter } from 'csv-writer';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Скрипт для экспорта данных из таблицы analization_results в CSV файл
 */
async function exportAnalizationResultsToCSV() {
    try {
        // Инициализация базы данных
        await AppDataSource.initialize();
        console.log('✅ Database connected');

        // Получение всех записей
        const repository = AppDataSource.getRepository(AnalizationResult);
        const results = await repository.find({
            order: { ts: 'DESC' } // Сортировка по дате (новые первыми)
        });

        console.log(`📊 Found ${results.length} records`);

        if (results.length === 0) {
            console.log('❌ No records found');
            return;
        }

        // Создание директории для экспорта, если не существует
        const exportDir = path.join(process.cwd(), 'exports');
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        // Генерация имени файла с timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const csvFilePath = path.join(exportDir, `analization-results-${timestamp}.csv`);

        // Конфигурация CSV writer
        const csvWriter = createObjectCsvWriter({
            path: csvFilePath,
            header: [
                { id: 'id', title: 'ID' },
                { id: 'ts', title: 'Timestamp' },
                { id: 'symbol', title: 'Symbol' },
                { id: 'action', title: 'Action' },
                { id: 'entryType', title: 'Entry Type' },
                { id: 'entryPrice', title: 'Entry Price' },
                { id: 'sl', title: 'Stop Loss' },
                { id: 'tp', title: 'Take Profit' },
                { id: 'tpPct', title: 'Take Profit %' },
                { id: 'horizonMin', title: 'Horizon (min)' },
                { id: 'confidence', title: 'Confidence' },
                { id: 'confidenceLevel', title: 'Confidence Level' },
                { id: 'modules', title: 'Modules' },
                { id: 'reasonTags', title: 'Reason Tags' },
                { id: 'riskPct', title: 'Risk %' },
                { id: 'status', title: 'Status' },
                { id: 'exitPrice', title: 'Exit Price' },
                { id: 'realizedPnlPct', title: 'Realized PnL %' },
                { id: 'maxPriceReached', title: 'Max Price Reached' },
                { id: 'createdAt', title: 'Created At' },
                { id: 'closedAt', title: 'Closed At' },
                { id: 'updatedAt', title: 'Updated At' }
            ]
        });

        // Преобразование данных для CSV
        const csvData = results.map(result => ({
            id: result.id,
            ts: result.ts.toISOString(),
            symbol: result.symbol,
            action: result.action,
            entryType: result.entryType,
            entryPrice: result.entryPrice,
            sl: result.sl,
            tp: result.tp.join('|'),
            tpPct: result.tpPct.join('|'),
            horizonMin: result.horizonMin,
            confidence: result.confidence,
            confidenceLevel: result.confidenceLevel,
            modules: JSON.stringify(result.modules),
            reasonTags: result.reasonTags.join(', '),
            riskPct: result.riskPct,
            status: result.status,
            exitPrice: result.exitPrice,
            realizedPnlPct: result.realizedPnlPct,
            maxPriceReached: result.maxPriceReached,
            createdAt: result.createdAt.toISOString(),
            closedAt: result.closedAt ? result.closedAt.toISOString() : '',
            updatedAt: result.updatedAt.toISOString()
        }));

        // Запись в CSV файл
        await csvWriter.writeRecords(csvData);
        console.log(`✅ CSV file created: ${csvFilePath}`);
        console.log(`📁 File path: ${path.resolve(csvFilePath)}`);

    } catch (error) {
        console.error('❌ Error exporting data:', error);
    } finally {
        // Закрытие соединения с базой данных
        await AppDataSource.destroy();
        console.log('🔌 Database connection closed');
    }
}

// Запуск скрипта
exportAnalizationResultsToCSV();
