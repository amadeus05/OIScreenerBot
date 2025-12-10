import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BarData } from '../types';
import { Logger } from '../../../shared/logger';

interface CandleRow {
    id: number;
    symbol: string;
    ts: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    cvd: number;
    delta: number;
    oi: number;
    funding: number;
    liquidations: {
        long?: number;
        short?: number;
        countLong?: number;
        countShort?: number;
        maxLong?: number;
        maxShort?: number;
    } | null;
    last_price: number;
    created_at: string;
}

export class SupabaseDataProvider {
    private readonly logger = new Logger('SupabaseDataProvider');
    private client: SupabaseClient | null = null;
    private readonly supabaseUrl: string;
    private readonly supabaseKey: string;

    constructor(supabaseUrl?: string, supabaseKey?: string) {
        this.supabaseUrl = supabaseUrl || process.env.SUPABASE_URL || '';
        this.supabaseKey = supabaseKey || process.env.SUPABASE_API_KEY || '';
    }

    private getClient(): SupabaseClient {
        if (!this.client) {
            if (!this.supabaseUrl || !this.supabaseKey) {
                throw new Error('Supabase credentials not configured.');
            }
            this.client = createClient(this.supabaseUrl, this.supabaseKey);
        }
        return this.client;
    }

    private async withRetry<T>(operation: () => Promise<T>, maxRetries: number = 3, context: string = ''): Promise<T> {
        let lastError: any;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await operation();
            } catch (error: any) {
                lastError = error;
                const isNetworkError = error.message?.includes('fetch failed') || error.message?.includes('SocketError');
                if (!isNetworkError && i < maxRetries - 1) {}
                if (i === maxRetries - 1) break;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        throw lastError;
    }

    isConfigured(): boolean {
        return Boolean(this.supabaseUrl && this.supabaseKey);
    }

    // --- OLD METHOD (SINGLE) ---
    async getHistory(symbol: string, limit: number = 100): Promise<BarData[]> {
        return []; // Не используется в новом режиме
    }

    // --- NEW METHOD (BATCH with DEBUG) ---
    async getHistoryForMany(symbols: string[], limitPerSymbol: number): Promise<Map<string, BarData[]>> {
        try {
            const client = this.getClient();
            // Берем данные за последние 24 часа
            const timeFilter = Date.now() - (24 * 60 * 60 * 1000);
            
            // Рассчитываем, сколько всего строк нам нужно.
            // Например: 20 символов * 500 свечей = 10,000 строк.
            const totalLimit = symbols.length * limitPerSymbol;

            const { data, error } = await this.withRetry(async () => {
                return await client
                    .from('candles')
                    .select('*')
                    .in('symbol', symbols)
                    .gte('ts', timeFilter)
                    .order('ts', { ascending: false }) // <--- ВАЖНО: Берем СВЕЖИЕ первыми (DESC)
                    .limit(totalLimit);                // <--- ВАЖНО: Явно перебиваем дефолт 1000
            }, 3, `getHistoryForMany(${symbols.length})`);

            if (error) {
                this.logger.error('❌ Bulk fetch error:', error);
                return new Map();
            }

            if (!data || data.length === 0) {
                return new Map();
            }

            this.logger.info(`✅ Bulk fetch returned ${data.length} rows (limit was ${totalLimit}).`);

            const result = new Map<string, BarData[]>();
            symbols.forEach(s => result.set(s, []));

            // Раскладываем данные
            for (const row of (data as CandleRow[])) {
                // Убираем пробелы, если есть
                const symbolKey = row.symbol.trim();
                const bars = result.get(symbolKey);
                
                // Проверяем, не набрали ли мы уже лимит для этой конкретной монеты
                if (bars && bars.length < limitPerSymbol) {
                    bars.push(this.rowToBarData(row));
                }
            }

            // РАЗВОРАЧИВАЕМ МАССИВЫ
            // Мы получили их DESC (Новые -> Старые), а для графика нужно ASC (Старые -> Новые)
            for (const [sym, bars] of result.entries()) {
                // .reverse() работает in-place (мутирует массив), что нам и нужно
                bars.reverse(); 
            }

            return result;

        } catch (error) {
            this.logger.error(`Error in bulk fetch:`, error);
            return new Map();
        }
    }

    async getAvailableSymbols(): Promise<string[]> {
        try {
            const client = this.getClient();
            const oneHourAgo = Date.now() - (60 * 60 * 1000);
            const { data, error } = await this.withRetry(async () => {
                return await client
                    .from('candles')
                    .select('symbol')
                    .gte('ts', oneHourAgo)
                    .order('ts', { ascending: false })
                    .limit(10000);
            }, 3, 'getAvailableSymbols');
    
            if (error) {
                this.logger.error('Error fetching symbols:', error);
                return [];
            }
            return [...new Set((data || []).map((row: { symbol: string }) => row.symbol as string))];
        } catch (error) {
            this.logger.error('Error fetching symbols:', error);
            return [];
        }
    }

    async hasEnoughData(symbol: string, minCandles: number = 20): Promise<boolean> {
        return true;
    }

    private rowToBarData(row: CandleRow): BarData {
        const liq = row.liquidations || {};
        return {
            symbol: row.symbol.trim(), // Trim тут тоже важен
            ts: row.ts,
            o: row.o || 0,
            h: row.h || 0,
            l: row.l || 0,
            c: row.c || 0,
            v: row.v || 0,
            delta: row.delta || 0,
            cvd: row.cvd || 0,
            oi: row.oi || 0,
            funding: row.funding || 0,
            lastPrice: row.last_price || row.c || 0,
            liquidations: {
                long: liq.long || 0,
                short: liq.short || 0,
                countLong: liq.countLong || 0,
                countShort: liq.countShort || 0,
                maxLong: liq.maxLong || 0,
                maxShort: liq.maxShort || 0,
            },
        };
    }
}

export function getSupabaseDataProvider(): SupabaseDataProvider {
    return new SupabaseDataProvider();
}





