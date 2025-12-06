/**
 * Signal Analyzer - Supabase Data Provider
 * Fetches historical candle data from Supabase for analysis
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BarData } from '../types';
import { Logger } from '../../../shared/logger';

/**
 * Database row structure for candles table
 */
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

/**
 * Supabase data provider for Signal Analyzer
 * Fetches historical candle data directly from Supabase
 */
export class SupabaseDataProvider {
    private readonly logger = new Logger('SupabaseDataProvider');
    private client: SupabaseClient | null = null;
    private readonly supabaseUrl: string;
    private readonly supabaseKey: string;

    constructor(supabaseUrl?: string, supabaseKey?: string) {
        this.supabaseUrl = supabaseUrl || process.env.SUPABASE_URL || '';
        this.supabaseKey = supabaseKey || process.env.SUPABASE_API_KEY || '';
    }

    /**
     * Initialize Supabase client
     */
    private getClient(): SupabaseClient {
        if (!this.client) {
            if (!this.supabaseUrl || !this.supabaseKey) {
                throw new Error('Supabase credentials not configured. Set SUPABASE_URL and SUPABASE_API_KEY.');
            }
            this.client = createClient(this.supabaseUrl, this.supabaseKey);
            this.logger.info('Supabase client initialized');
        }
        return this.client;
    }

    /**
     * Check if Supabase is configured
     */
    isConfigured(): boolean {
        return Boolean(this.supabaseUrl && this.supabaseKey);
    }

    /**
     * Fetch historical candles for a symbol
     * @param symbol Trading pair (e.g., 'BTCUSDT')
     * @param limit Number of candles to fetch (default 100)
     * @returns Array of BarData sorted by timestamp (oldest first)
     */
    async getHistory(symbol: string, limit: number = 100): Promise<BarData[]> {
        try {
            const client = this.getClient();

            const { data, error } = await client
                .from('candles')
                .select('*')
                .eq('symbol', symbol)
                .order('ts', { ascending: false })
                .limit(limit);

            if (error) {
                this.logger.error(`Supabase query error for ${symbol}:`, error);
                return [];
            }

            if (!data || data.length === 0) {
                this.logger.warn(`No candles found for ${symbol}`);
                return [];
            }

            // Convert rows to BarData and reverse to oldest-first
            const bars = (data as CandleRow[])
                .map(row => this.rowToBarData(row))
                .reverse();

            this.logger.debug(`Fetched ${bars.length} candles for ${symbol} from Supabase`);
            return bars;

        } catch (error) {
            this.logger.error(`Error fetching from Supabase for ${symbol}:`, error);
            return [];
        }
    }

    /**
     * Get all available symbols in the database
     * Fetches distinct symbols by sampling recent data
     */
    async getAvailableSymbols(): Promise<string[]> {
        try {
            const client = this.getClient();

            // Supabase JS client doesn't support DISTINCT directly
            // Workaround: Fetch recent records (last hour) to get variety of symbols
            const oneHourAgo = Date.now() - (60 * 60 * 1000);

            const { data, error } = await client
                .from('candles')
                .select('symbol')
                .gte('ts', oneHourAgo)
                .order('ts', { ascending: false })
                .limit(10000);

            if (error) {
                this.logger.error('Error fetching symbols from Supabase:', error);
                return [];
            }

            // Get unique symbols
            const symbols = [...new Set((data || []).map((row: { symbol: string }) => row.symbol as string))];

            this.logger.info(`Found ${symbols.length} unique symbols in Supabase (from ${data?.length || 0} recent rows)`);
            return symbols;

        } catch (error) {
            this.logger.error('Error fetching symbols:', error);
            return [];
        }
    }

    /**
     * Check if symbol has enough data
     */
    async hasEnoughData(symbol: string, minCandles: number = 20): Promise<boolean> {
        try {
            const client = this.getClient();

            this.logger.debug(`hasEnoughData: Checking ${symbol}, min=${minCandles}`);

            const { count, error } = await client
                .from('candles')
                .select('*', { count: 'exact', head: true })
                .eq('symbol', symbol);

            if (error) {
                this.logger.error(`hasEnoughData error for ${symbol}:`, error);
                return false;
            }

            this.logger.debug(`hasEnoughData: ${symbol} has count=${count}`);
            return (count || 0) >= minCandles;

        } catch (err) {
            this.logger.error(`hasEnoughData exception for ${symbol}:`, err);
            return false;
        }
    }

    /**
     * Convert database row to BarData
     */
    private rowToBarData(row: CandleRow): BarData {
        const liq = row.liquidations || {};

        return {
            symbol: row.symbol,
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

/**
 * Singleton instance for convenience
 */
let instance: SupabaseDataProvider | null = null;

export function getSupabaseDataProvider(): SupabaseDataProvider {
    if (!instance) {
        instance = new SupabaseDataProvider();
    }
    return instance;
}
