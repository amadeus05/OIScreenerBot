// domain/aggregator.types.ts
export type MarketUpdatePayload = {
    timestamp: number;
    price?: number;
    openInterest?: number;
    volume?: number;
    volumeBuy?: number;
    volumeSell?: number;
    volumeBuyQuote?: number;
    volumeSellQuote?: number;
    markPrice?: number;
    fundingRate?: number;
};

export type Bucket = {
    oiOpen: number;
    oiClose: number;
    oiHigh: number;
    oiLow: number;
    volumeBuy: number;
    volumeSell: number;
    totalVolume: number;
    volumeBuyQuote: number;
    volumeSellQuote: number;
    totalQuoteVolume: number;
    priceOpen: number | null;
    priceClose: number | null;
    count: number;
    firstTs: number;
    lastTs: number;
};

export type HealthStats = {
    totalSymbols: number;
    buckets15s: number;
    buckets1m: number;
    memoryEstimateMB: number;
    oldestData: number;
    newestData: number;
    warmupRejects: number;
    fallbacksUsed: number;
};

// infrastructure/SortedBucketMap.ts
export class SortedBucketMap {
    private map: Map<number, Bucket> = new Map();
    private sortedKeys: number[] | null = null;

    get size(): number { return this.map.size; }

    has(key: number): boolean { return this.map.has(key); }
    get(key: number): Bucket | undefined { return this.map.get(key); }

    set(key: number, value: Bucket): void {
        const isNew = !this.map.has(key);
        this.map.set(key, value);
        if (isNew) this.sortedKeys = null;
    }

    delete(key: number): boolean {
        const existed = this.map.delete(key);
        if (existed) this.sortedKeys = null;
        return existed;
    }

    getSortedKeys(): number[] {
        if (this.sortedKeys === null) {
            this.sortedKeys = [...this.map.keys()].sort((a, b) => a - b);
        }
        return this.sortedKeys;
    }

    entries(): IterableIterator<[number, Bucket]> { return this.map.entries(); }
    values(): IterableIterator<Bucket> { return this.map.values(); }
    keys(): IterableIterator<number> { return this.map.keys(); }
    [Symbol.iterator](): IterableIterator<[number, Bucket]> { return this.map[Symbol.iterator](); }
}