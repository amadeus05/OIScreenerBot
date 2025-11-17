
import axios, { AxiosInstance } from 'axios';
import EventEmitter from 'events';

type OICacheEntry = {
  value: number;
  ts: number; // ms
  error?: string | null;
};

export interface OpenInterestServiceOptions {
  apiBase?: string; // e.g. https://fapi.binance.com
  pollIntervalMs?: number; // how often to refresh all symbols (default 5000)
  concurrency?: number; // parallel fetches per batch (default 8)
  batchDelayMs?: number; // delay between batches to avoid bursts (default 200)
  symbolFilter?: (sym: string) => boolean; // filter symbols (default: endsWith USDT)
  requestTimeoutMs?: number; // axios timeout per request (default 4000)
  oiEntryTtlMs?: number; // consider OI stale after this (default pollIntervalMs * 3)
  maxRetries?: number; // per-symbol retry attempts (default 2)
  jitterMs?: number; // small jitter added to intervals to avoid sync spikes
}

export class OpenInterestService extends EventEmitter {
  private axios: AxiosInstance;
  private apiBase: string;
  private pollIntervalMs: number;
  private concurrency: number;
  private batchDelayMs: number;
  private symbolFilter: (sym: string) => boolean;
  private requestTimeoutMs: number;
  private oiEntryTtlMs: number;
  private maxRetries: number;
  private jitterMs: number;

  private symbols: string[] = [];
  private oiCache: Map<string, OICacheEntry> = new Map();
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;

  // simple internal flag to avoid overlapping polls
  private inProgress = false;

  constructor(opts?: Partial<OpenInterestServiceOptions>) {
    super();
    const options: OpenInterestServiceOptions = {
      apiBase: opts?.apiBase ?? process.env.BINANCE_FAPI_BASE ?? 'https://fapi.binance.com',
      pollIntervalMs: opts?.pollIntervalMs ?? 5_000,
      concurrency: opts?.concurrency ?? 8,
      batchDelayMs: opts?.batchDelayMs ?? 200,
      symbolFilter: opts?.symbolFilter ?? ((s) => s.endsWith('USDT') && !s.includes('_')),
      requestTimeoutMs: opts?.requestTimeoutMs ?? 4_000,
      oiEntryTtlMs: opts?.oiEntryTtlMs ?? (opts?.pollIntervalMs ?? 5_000) * 3,
      maxRetries: opts?.maxRetries ?? 2,
      jitterMs: opts?.jitterMs ?? 150,
    };

    this.apiBase = options.apiBase;
    this.pollIntervalMs = options.pollIntervalMs;
    this.concurrency = options.concurrency;
    this.batchDelayMs = options.batchDelayMs;
    this.symbolFilter = options.symbolFilter;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.oiEntryTtlMs = options.oiEntryTtlMs;
    this.maxRetries = options.maxRetries;
    this.jitterMs = options.jitterMs;

    this.axios = axios.create({
      baseURL: this.apiBase,
      timeout: this.requestTimeoutMs,
      headers: {
        'User-Agent': 'OpenInterestService/1.0 (+you)',
      },
    });
  }

  // ----------------- Public API -----------------

  /** Start polling (fetch exchangeInfo -> symbols -> periodic OI) */
  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.refreshSymbols();
    } catch (err) {
      // emit but continue: we'll try again on poll
      this.emit('error', err);
    }

    // immediate one-pass with small jitter
    this.scheduleNextPoll(50 + Math.floor(Math.random() * this.jitterMs));
  }

  /** Stop polling */
  public stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Force immediate refresh now (returns when finished) */
  public async refreshNow(): Promise<void> {
    if (!this.running) {
      await this.refreshSymbols();
      await this.fetchAllOpenInterest();
      return;
    }
    // if running, trigger immediate run (if not already in progress)
    if (!this.inProgress) {
      await this.fetchAllOpenInterest();
    }
  }

  /** Get last known OI for symbol (or undefined) */
  public getOI(symbol: string): number | undefined {
    const e = this.oiCache.get(symbol);
    if (!e) return undefined;
    // return only fresh entries
    if (Date.now() - e.ts > this.oiEntryTtlMs) return undefined;
    return e.value;
  }

  /** Subscribe using callback (handy for your gateway) */
  public subscribe(cb: (symbol: string, oi: number) => void): () => void {
    const handler = (sym: string, oi: number) => cb(sym, oi);
    this.on('oiUpdate', handler);
    return () => this.off('oiUpdate', handler);
  }

  /** Get all tracked symbols */
  public getSymbols(): string[] {
    return [...this.symbols];
  }

  // ----------------- Internals -----------------

  private scheduleNextPoll(delayOverrideMs?: number) {
    if (!this.running) return;
    const delay = delayOverrideMs ?? this.pollIntervalMs;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      try {
        // refresh symbols every cycle too (lightweight)
        await this.refreshSymbolsIfNeeded();
        await this.fetchAllOpenInterest();
      } catch (err) {
        this.emit('error', err);
      } finally {
        if (this.running) this.scheduleNextPoll();
      }
    }, delay + Math.floor(Math.random() * this.jitterMs));
  }

  // refresh the list of symbols from exchangeInfo
  private async refreshSymbols(): Promise<void> {
    try {
      const resp = await this.axios.get('/fapi/v1/exchangeInfo');
      const data = resp.data;
      if (!data || !Array.isArray(data.symbols)) {
        throw new Error('Invalid exchangeInfo response');
      }
      const syms: string[] = data.symbols
        .map((s: any) => String(s.symbol))
        .filter((s: string) => this.symbolFilter(s));
      // sort and dedupe
      const uniq = Array.from(new Set(syms)).sort();
      this.symbols = uniq;
      this.emit('symbols', this.symbols);
    } catch (err) {
      // don't crash: emit and continue with existing list
      this.emit('error', { stage: 'refreshSymbols', err });
      throw err;
    }
  }

  // refresh only when empty or older than a minute
  private lastSymbolsRefresh = 0;
  private async refreshSymbolsIfNeeded(): Promise<void> {
    const now = Date.now();
    if (this.symbols.length === 0 || now - this.lastSymbolsRefresh > 60_000) {
      await this.refreshSymbols();
      this.lastSymbolsRefresh = now;
    }
  }

  // fetch OI for all symbols using batching and concurrency control
  private async fetchAllOpenInterest(): Promise<void> {
    if (this.inProgress) return;
    this.inProgress = true;

    try {
      const symbols = this.symbols.slice();
      if (symbols.length === 0) {
        // try to refresh symbols immediately
        await this.refreshSymbols();
      }

      // chunk into batches of size `concurrency`
      for (let i = 0; i < symbols.length; i += this.concurrency) {
        const batch = symbols.slice(i, i + this.concurrency);
        await Promise.all(batch.map((sym) => this.fetchOpenInterestWithRetry(sym)));
        // small pause between batches to avoid bursts
        await this.sleep(this.batchDelayMs);
      }
    } finally {
      this.inProgress = false;
    }
  }

  private async fetchOpenInterestWithRetry(symbol: string): Promise<void> {
    let attempt = 0;
    let lastErr: any = null;
    while (attempt <= this.maxRetries) {
      try {
        await this.fetchOpenInterest(symbol);
        return;
      } catch (err) {
        lastErr = err;
        attempt++;
        const backoff = 200 * attempt + Math.floor(Math.random() * 120);
        await this.sleep(backoff);
      }
    }
    // final failure: set stale entry with error
    this.oiCache.set(symbol, { value: NaN, ts: Date.now(), error: String(lastErr ?? 'unknown') });
    this.emit('oiError', symbol, lastErr);
  }

  private async fetchOpenInterest(symbol: string): Promise<void> {
    try {
      const resp = await this.axios.get('/fapi/v1/openInterest', { params: { symbol } });
      const data = resp.data;
      // Binance returns { "symbol":"BTCUSDT","openInterest":"12345.000" }
      if (!data || typeof data.openInterest === 'undefined') {
        throw new Error('Invalid openInterest response');
      }
      const oi = Number.parseFloat(String(data.openInterest));
      if (!Number.isFinite(oi)) throw new Error('Invalid OI value');

      const prev = this.oiCache.get(symbol);
      this.oiCache.set(symbol, { value: oi, ts: Date.now(), error: null });
      this.emit('oiUpdate', symbol, oi, prev?.value);
    } catch (err) {
      // record error but do not remove previous value
      const prev = this.oiCache.get(symbol);
      this.oiCache.set(symbol, { value: prev?.value ?? NaN, ts: prev?.ts ?? Date.now(), error: String(err ?? 'err') });
      this.emit('error', { stage: 'fetchOpenInterest', symbol, err });
      throw err;
    }
  }

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
}
