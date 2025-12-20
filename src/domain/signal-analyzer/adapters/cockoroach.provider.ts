import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import { BarData } from '../types';
import { Logger } from '../../../shared/logger'; // Предполагаю, что у вас есть такой логгер

interface SmartCandleRow {
  symbol: string;
  ts: number | string; // PostgreSQL может возвращать BIGINT как строку
  o?: number | null;
  h?: number | null;
  l?: number | null;
  c?: number | null;
  v?: number | null;
  cvd?: number | null;
  delta?: number | null;
  oi?: number | null;
  funding?: number | null;
  liquidations?: {
    long?: number;
    short?: number;
    countLong?: number;
    countShort?: number;
    maxLong?: number;
    maxShort?: number;
  } | null;
  last_price?: number | null;
}

interface CandleRowFromDB extends SmartCandleRow {
  created_at?: string;
}

export class CockroachDBDataProvider {
  private readonly logger = new Logger('CockroachDBDataProvider');

  private pool: Pool | null = null;
  private initialized = false;
  private tableEnsured = false;

  constructor(
    private connectionString: string = process.env.COCKROACHDB_CONNECTION_STRING || process.env.COCKROACH_CONNECTION_STRING || '',
    private certPath: string = process.env.COCKROACHDB_CERT_PATH || process.env.COCKROACH_CERT_PATH || '',
    private batchSize = 50
  ) {
    if (!connectionString || !certPath) {
      this.logger.warn('CockroachDB connection string or cert path not configured. Provider will not be initialized.');
      return;
    }

    if (!fs.existsSync(certPath)) {
      this.logger.error(`SSL certificate not found at: ${certPath}`);
      return;
    }

    try {
      this.pool = new Pool({
        connectionString,
        ssl: {
          rejectUnauthorized: true,
          ca: fs.readFileSync(certPath).toString(),
        },
        connectionTimeoutMillis: 30000, // 30 секунд на подключение
        idleTimeoutMillis: 30000,
        max: 10, // максимум 10 соединений в пуле
        // Добавляем keepAlive для стабильности соединения
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });
      this.initialized = true;
      this.logger.info('CockroachDB connection pool created successfully');
    } catch (error) {
      this.logger.error('Failed to create CockroachDB connection pool', error);
    }
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    context: string = ''
  ): Promise<T> {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        const isNetworkError =
          error.message?.includes('fetch failed') ||
          error.message?.includes('SocketError') ||
          error.code === 'ECONNRESET' ||
          error.code === 'ENOTFOUND' ||
          error.code === 'ETIMEDOUT';

        if (i < maxRetries - 1) {
          const delay = 2000 * (i + 1); // Увеличиваем задержку: 2s, 4s, 6s...
          this.logger.warn(`Retry ${i + 1}/${maxRetries} for ${context}: ${error.message} (code: ${error.code}). Waiting ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    this.logger.error(`All retries failed for ${context}:`, lastError);
    throw lastError;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      throw new Error('CockroachDB provider is not configured. Check COCKROACHDB_CONNECTION_STRING and COCKROACHDB_CERT_PATH.');
    }

    if (this.tableEnsured) return;

    await this.ensureTable();
    // Не очищаем данные при каждом старте провайдера — только если явно нужно
    // await this.truncateAll();
    this.tableEnsured = true;
    this.logger.info('[CockroachDBDataProvider] Table ensured');
  }

  private async ensureTable(): Promise<void> {
    if (!this.pool) {
      throw new Error('CockroachDB pool is not initialized');
    }

    const client = await this.pool.connect();
    try {
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS candles (
          symbol TEXT NOT NULL,
          ts BIGINT NOT NULL,
          o DOUBLE PRECISION,
          h DOUBLE PRECISION,
          l DOUBLE PRECISION,
          c DOUBLE PRECISION,
          v DOUBLE PRECISION,
          cvd DOUBLE PRECISION,
          delta DOUBLE PRECISION,
          oi DOUBLE PRECISION,
          funding DOUBLE PRECISION,
          liquidations JSONB,
          last_price DOUBLE PRECISION,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (symbol, ts)
        );
        CREATE INDEX IF NOT EXISTS idx_candles_ts ON candles (ts);
        CREATE INDEX IF NOT EXISTS idx_candles_symbol ON candles (symbol);
      `;
      await client.query(createTableSQL);
      this.logger.info('Table "candles" ensured');
    } finally {
      client.release();
    }
  }

  isConfigured(): boolean {
    return this.initialized;
  }

  // Старый метод — оставляем для совместимости
  async getHistory(symbol: string, limit: number = 100): Promise<BarData[]> {
    return (await this.getHistoryForMany([symbol], limit)).get(symbol) || [];
  }

  // Основной метод — батч-запрос для множества символов
  async getHistoryForMany(symbols: string[], limitPerSymbol: number): Promise<Map<string, BarData[]>> {
    await this.ensureInitialized();

    if (!this.pool) {
      throw new Error('CockroachDB pool is not initialized');
    }

    const timeFilter = Date.now() - 24 * 60 * 60 * 1000; // последние 24 часа
    const totalLimit = symbols.length * limitPerSymbol;

    try {
      const { rows } = await this.withRetry(async () => {
        const client = await this.pool!.connect();
        try {
          const query = `
            SELECT * FROM candles
            WHERE symbol = ANY($1)
              AND ts >= $2
            ORDER BY ts DESC
            LIMIT $3
          `;
          const result = await client.query(query, [symbols, timeFilter, totalLimit]);
          return result;
        } finally {
          client.release();
        }
      }, 3, `getHistoryForMany(${symbols.length})`);

      this.logger.info(`Bulk fetch returned ${rows.length} rows (requested up to ${totalLimit})`);

      const result = new Map<string, BarData[]>();
      symbols.forEach((s) => result.set(s, []));

      for (const row of rows as CandleRowFromDB[]) {
        const symbolKey = row.symbol.trim();
        const bars = result.get(symbolKey);
        if (bars && bars.length < limitPerSymbol) {
          bars.push(this.rowToBarData(row));
        }
      }

      // Разворачиваем массивы: из DESC (новые первыми) в ASC (старые первыми)
      for (const bars of result.values()) {
        bars.reverse();
      }

      return result;
    } catch (error) {
      this.logger.error('Error in bulk fetch:', error);
      return new Map();
    }
  }

  async getAvailableSymbols(): Promise<string[]> {
    await this.ensureInitialized();

    if (!this.pool) {
      throw new Error('CockroachDB pool is not initialized');
    }
  
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
  
    try {
      this.logger.info('Attempting to connect to CockroachDB...');
      const { rows } = await this.withRetry(async () => {
        const client = await this.pool!.connect();
        try {
          this.logger.info('Connected! Executing query...');
          const query = `
            SELECT symbol
            FROM candles
            WHERE ts >= $1
            ORDER BY ts DESC
            LIMIT 10000
          `;
          return await client.query(query, [oneHourAgo]);
        } finally {
          client.release();
        }
      }, 5, 'getAvailableSymbols'); // Увеличиваем количество попыток до 5
  
      // Возвращаем уникальные символы, как в Supabase провайдере
      return [...new Set(rows.map((r: any) => r.symbol as string))];
    } catch (error: any) {
      this.logger.error('Error fetching symbols:', error);
      if (error.code === 'ENOTFOUND') {
        this.logger.error('DNS resolution failed. Check your internet connection and DNS settings.');
      }
      return [];
    }
  }

  async hasEnoughData(symbol: string, minCandles: number = 20): Promise<boolean> {
    // Можно реализовать точную проверку, но для простоты возвращаем true как в Supabase версии
    return true;
  }

  // Метод для записи одной свечи (если нужно записывать извне)
  async insertRow(row: SmartCandleRow): Promise<void> {
    await this.ensureInitialized();

    if (!this.pool) {
      throw new Error('CockroachDB pool is not initialized');
    }

    const client = await this.pool.connect();
    try {
      const query = `
        INSERT INTO candles (symbol, ts, o, h, l, c, v, cvd, delta, oi, funding, liquidations, last_price)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (symbol, ts) DO UPDATE SET
          o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c,
          v = EXCLUDED.v, cvd = EXCLUDED.cvd, delta = EXCLUDED.delta,
          oi = EXCLUDED.oi, funding = EXCLUDED.funding,
          liquidations = EXCLUDED.liquidations, last_price = EXCLUDED.last_price
      `;
      const values = [
        row.symbol,
        row.ts,
        row.o ?? null,
        row.h ?? null,
        row.l ?? null,
        row.c ?? null,
        row.v ?? null,
        row.cvd ?? null,
        row.delta ?? null,
        row.oi ?? null,
        row.funding ?? null,
        row.liquidations ? JSON.stringify(row.liquidations) : null,
        row.last_price ?? null,
      ];

      await client.query(query, values);
    } finally {
      client.release();
    }
  }

  private rowToBarData(row: CandleRowFromDB): BarData {
    const liq = row.liquidations || {};
    
    // Вспомогательная функция для преобразования в число
    const toNumber = (val: any): number => {
      if (typeof val === 'string') return parseFloat(val);
      return val || 0;
    };

    return {
      symbol: row.symbol.trim(),
      ts: typeof row.ts === 'string' ? parseInt(row.ts, 10) : row.ts, // BIGINT -> number
      o: toNumber(row.o),
      h: toNumber(row.h),
      l: toNumber(row.l),
      c: toNumber(row.c),
      v: toNumber(row.v),
      delta: toNumber(row.delta),
      cvd: toNumber(row.cvd),
      oi: toNumber(row.oi),
      funding: toNumber(row.funding),
      lastPrice: toNumber(row.last_price || row.c),
      liquidations: {
        long: toNumber(liq.long),
        short: toNumber(liq.short),
        countLong: toNumber(liq.countLong),
        countShort: toNumber(liq.countShort),
        maxLong: toNumber(liq.maxLong),
        maxShort: toNumber(liq.maxShort),
      },
    };
  }

  async shutdown(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.logger.info('[CockroachDBDataProvider] Shutdown complete');
    }
  }
}

export function getCockroachDBDataProvider(): CockroachDBDataProvider {
  return new CockroachDBDataProvider();
}