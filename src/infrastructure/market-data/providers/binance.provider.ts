import WebSocket from 'ws';
import axios from 'axios';
import * as https from 'https';
import { Injectable } from '../../../shared/decorators';
import { Logger } from '../../../shared/logger';
import {
  IMarketDataProvider,
  MarketType,
  PriceUpdateCallback,
  ProviderHealthStatus,
} from '../../../domain/interfaces/market-data-provider.interface';
import { MarketData } from '../../../domain/interfaces/market-data.interface';

// КОНФИГУРАЦИЯ
const BINANCE_SPOT_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const BINANCE_FUTURES_EXCHANGE_INFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_FUTURES_OI_API = 'https://fapi.binance.com/fapi/v1/openInterest';
const BINANCE_SPOT_STREAM_BASE = 'wss://stream.binance.com:9443/stream';
const BINANCE_FUTURES_STREAM_BASE = 'wss://fstream.binance.com/stream';

const BATCH_SIZE = 30;
const KLINE_INTERVAL = '1m';
const MAX_REQ_PER_SEC = 20;
const HTTP_TIMEOUT = 2000;

// Список пар с принудительно низким приоритетом
const LOW_PRIORITY_SYMBOLS = new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT',
  'TRXUSDT', 'LINKUSDT', 'AVAXUSDT', 'MATICUSDT', 'DOTUSDT', 'LTCUSDT',
  'USDCUSDT', 'BUSDUSDT', 'EURUSDT'
]);

interface SymbolState {
  symbol: string;
  cumulativeCVD: number;
  lastCandleTimestamp: number;
  fundingRate: number;
  openInterest: number;
  lastPrice: number;

  accLiqLong: number;
  accLiqShort: number;
  countLiqLong: number;
  countLiqShort: number;
  maxLiqLong: number;
  maxLiqShort: number;
}

interface SymbolPriority {
  priority: number;
  lastUpdated: number;
}

@Injectable()
export class BinanceMarketDataProvider implements IMarketDataProvider {
  public readonly providerId: string;
  public readonly marketType: MarketType;
  private readonly logger: Logger;

  private wsList: WebSocket[] = [];
  private tickerWs: WebSocket | null = null;
  private symbols = new Set<string>();
  private marketStates = new Map<string, SymbolState>();
  private priorityMap = new Map<string, SymbolPriority>();

  private connected = false;
  // Потенциальная утечка при частых реконнектах: таймеры не удаляются при успешном переподключении.
  // TODO: Отслеживать таймеры per-WebSocket и удалять при успешном создании нового соединения.
  private reconnectTimers = new Set<NodeJS.Timeout>();
  private readyPromise: Promise<void>;
  private isPollingOI = false;
  private axiosInstance = axios.create({
    httpsAgent: new https.Agent({ keepAlive: true }),
    timeout: HTTP_TIMEOUT,
  });

  private callback: PriceUpdateCallback | null = null;
  private messageCount = 0;
  private errorCount = 0;
  private reconnectAttempts = 0;
  private lastUpdateTime = 0;

  constructor(marketType: MarketType = 'futures') {
    this.marketType = marketType;
    this.providerId = `binance-${marketType}-ws`;
    this.logger = new Logger(this.providerId);
    this.readyPromise = this.loadSymbolsWithRetry();
  }

  private async loadSymbolsWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.loadSymbols();
        return;
      } catch (e) {
        this.logger.warn(`loadSymbols attempt ${attempt} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw new Error('Failed to load symbols after 5 attempts');
  }

  private async loadSymbols(): Promise<void> {
    const url = this.marketType === 'futures'
      ? BINANCE_FUTURES_EXCHANGE_INFO_URL
      : BINANCE_SPOT_EXCHANGE_INFO_URL;

    const res = await this.axiosInstance.get(url);
    const data = res.data;

    this.symbols.clear();
    this.marketStates.clear();
    this.priorityMap.clear();

    for (const s of data.symbols || []) {
      const isUsdtFutures = this.marketType === 'futures' && s.contractType === 'PERPETUAL' && s.marginAsset === 'USDT' && s.status === 'TRADING';
      const isSpotUsdt = this.marketType === 'spot' && s.status === 'TRADING' && s.symbol.endsWith('USDT');

      if (isUsdtFutures || isSpotUsdt) {
        this.symbols.add(s.symbol);
        this.marketStates.set(s.symbol, {
          symbol: s.symbol,
          cumulativeCVD: 0,
          lastCandleTimestamp: 0,
          fundingRate: 0,
          openInterest: 0,
          lastPrice: 0,
          accLiqLong: 0, accLiqShort: 0, countLiqLong: 0, countLiqShort: 0, maxLiqLong: 0, maxLiqShort: 0,
        });
        const initialPriority = LOW_PRIORITY_SYMBOLS.has(s.symbol) ? 1 : 5;
        this.priorityMap.set(s.symbol, { priority: initialPriority, lastUpdated: 0 });
      }
    }
    this.logger.info(`Loaded ${this.symbols.size} ${this.marketType} symbols`);
  }

  public async connect(): Promise<void> {
    if (this.connected) return;
    await this.readyPromise;
    this.connected = true;
    this.subscribeToBatches();
    if (this.marketType === 'futures') {
      this.startAllTickersStream();
      // Загружаем начальные данные OI для всех монет
      await this.fetchInitialOI();
      this.startSmartOIPolling();
    }
    this.logger.info(`Connected to Binance ${this.marketType}`);
  }

  /**
   * Загружает начальные данные OI для всех символов при старте.
   * Выполняется пачками по MAX_REQ_PER_SEC запросов с задержкой 1 сек между пачками.
   */
  private async fetchInitialOI(): Promise<void> {
    const symbolsArray = Array.from(this.symbols);
    const totalSymbols = symbolsArray.length;
    let loaded = 0;

    this.logger.info(`Fetching initial OI for ${totalSymbols} symbols...`);

    for (let i = 0; i < totalSymbols; i += MAX_REQ_PER_SEC) {
      const batch = symbolsArray.slice(i, i + MAX_REQ_PER_SEC);

      await Promise.all(batch.map(async (symbol) => {
        try {
          const res = await this.axiosInstance.get(BINANCE_FUTURES_OI_API, { params: { symbol } });
          if (res.data?.openInterest) {
            const val = parseFloat(res.data.openInterest);
            const state = this.marketStates.get(symbol);
            if (state) {
              state.openInterest = val;
            }
            const p = this.priorityMap.get(symbol);
            if (p) p.lastUpdated = Date.now();
            loaded++;
          }
        } catch {
          // Игнорируем ошибки при начальной загрузке
        }
      }));

      // Задержка между пачками, кроме последней
      if (i + MAX_REQ_PER_SEC < totalSymbols) {
        await new Promise((r) => setTimeout(r, 1100));
      }
    }

    this.logger.info(`Initial OI loaded for ${loaded}/${totalSymbols} symbols`);
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    this.isPollingOI = false;
    this.reconnectTimers.forEach((t) => clearTimeout(t));
    this.wsList.forEach((ws) => { try { ws.terminate(); } catch { } });
    this.wsList = [];
    if (this.tickerWs) this.tickerWs.terminate();
    this.logger.info('Disconnected');
  }

  // --- WEBSOCKETS ---
  private createBatchWS(batch: string[]): WebSocket {
    const streams = batch.map((s) => {
      const sym = s.toLowerCase();
      let str = `${sym}@kline_${KLINE_INTERVAL}`;
      if (this.marketType === 'futures') str += `/${sym}@markPrice/${sym}@forceOrder`;
      return str;
    }).join('/');

    const baseUrl = this.marketType === 'futures' ? BINANCE_FUTURES_STREAM_BASE : BINANCE_SPOT_STREAM_BASE;
    const ws = new WebSocket(`${baseUrl}?streams=${streams}`);
    let closedByUs = false;

    ws.on('message', (data) => this.handleMessage(data.toString()));
    ws.on('error', () => this.errorCount++);
    ws.on('close', () => {
      if (closedByUs) return;
      const idx = this.wsList.indexOf(ws);
      if (idx !== -1) {
        const timer = setTimeout(() => {
          if (!this.connected) return;
          this.wsList[idx] = this.createBatchWS(batch);
          this.reconnectAttempts++;
        }, 3000);
        this.reconnectTimers.add(timer);
      }
    });
    // @ts-ignore
    ws._closeGracefully = () => { closedByUs = true; try { ws.terminate(); } catch { } };
    return ws;
  }

  private subscribeToBatches(): void {
    const symbolsArray = Array.from(this.symbols);
    for (let i = 0; i < symbolsArray.length; i += BATCH_SIZE) {
      this.wsList.push(this.createBatchWS(symbolsArray.slice(i, i + BATCH_SIZE)));
    }
  }

  private handleMessage(raw: string): void {
    if (!this.callback) return;
    try {
      const msg = JSON.parse(raw);
      if (!msg.data) return;
      if (msg.stream.includes('kline')) this.processKline(msg.data);
      else if (msg.stream.includes('markPrice')) this.processMarkPrice(msg.data);
      else if (msg.stream.includes('forceOrder')) this.processLiquidation(msg.data);
    } catch (e) {
      this.logger.warn(`Failed to parse message: ${e instanceof Error ? e.message : String(e)}`);
      this.errorCount++;
    }
  }

  // --- PROCESSING ---
  private processKline(data: any): void {
    const k = data.k;
    const symbol = k.s;
    const state = this.marketStates.get(symbol);
    if (!state) return;

    const close = parseFloat(k.c);
    const vol = parseFloat(k.v);
    const takerBuy = parseFloat(k.V);
    const deltaBase = (takerBuy * 2) - vol;
    const avgPrice = (parseFloat(k.o) + parseFloat(k.h) + parseFloat(k.l) + close) / 4;
    const deltaUSD = deltaBase * avgPrice;

    state.lastPrice = close;
    const candleTimestamp = k.t;
    const isClosed = k.x === true;
    const liveCVD = state.cumulativeCVD + deltaUSD;

    this.emitUpdate(state, {
      price: close,
      isClosed,
      timestamp: candleTimestamp,
      ohlc: {
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: close,
        volume: vol,
      },
      indicators: {
        cvd: liveCVD,
        candleDelta: deltaUSD,
        fundingRate: state.fundingRate,
        openInterest: state.openInterest,
        liquidationsLong: state.accLiqLong,
        liquidationsShort: state.accLiqShort,
        liqCountLong: state.countLiqLong,
        liqCountShort: state.countLiqShort,
        liqMaxLong: state.maxLiqLong,
        liqMaxShort: state.maxLiqShort,
      }
    });

    if (isClosed) {
      state.cumulativeCVD += deltaUSD;
      state.accLiqLong = 0; state.accLiqShort = 0;
      state.countLiqLong = 0; state.countLiqShort = 0;
      state.maxLiqLong = 0; state.maxLiqShort = 0;
      state.lastCandleTimestamp = candleTimestamp;
    }
    this.lastUpdateTime = Date.now();
    this.messageCount++;
  }

  private processMarkPrice(data: any): void {
    const state = this.marketStates.get(data.s);
    if (state) state.fundingRate = parseFloat(data.r);
  }

  private processLiquidation(data: any): void {
    const o = data.o;
    const symbol = o.s;
    const state = this.marketStates.get(symbol);
    if (!state) return;

    const price = parseFloat(o.p);
    const qty = parseFloat(o.q);
    const amount = price * qty;
    const side = o.S === 'SELL' ? 'LONG' : 'SHORT';

    if (side === 'LONG') {
      state.accLiqLong += amount;
      state.countLiqLong++;
      state.maxLiqLong = Math.max(state.maxLiqLong, amount);
    } else {
      state.accLiqShort += amount;
      state.countLiqShort++;
      state.maxLiqShort = Math.max(state.maxLiqShort, amount);
    }
  }

  private emitUpdate(state: SymbolState, payload: any) {
    const update: MarketData = {
      providerId: this.providerId,
      marketType: this.marketType,
      symbol: state.symbol,
      price: payload.price,
      timestamp: payload.timestamp,
      isCandleClosed: payload.isClosed,
      ohlc: payload.ohlc,
      indicators: payload.indicators
    };
    try {
      if (this.callback) this.callback(update);
    } catch (e) {
      this.logger.error(`Callback error for ${state.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- OI POLLING & PRIORITY ---
  private startAllTickersStream() {
    this.tickerWs = new WebSocket(`${BINANCE_FUTURES_STREAM_BASE}?streams=!ticker@arr`);
    this.tickerWs.on('message', (data) => {
      try {
        const arr = JSON.parse(data.toString()).data;
        if (!Array.isArray(arr)) return;
        for (const t of arr) {
          const sym = t.s;
          if (!this.symbols.has(sym)) continue;
          const change = Math.abs(parseFloat(t.P));
          const vol = parseFloat(t.q);
          const p = this.priorityMap.get(sym);
          if (p) p.priority = (change > 3 || vol > 50_000_000) ? 10 : 5;
        }
      } catch { }
    });
    this.tickerWs.on('close', () => setTimeout(() => this.connected && this.startAllTickersStream(), 5000));
  }

  private async startSmartOIPolling() {
    this.isPollingOI = true;
    while (this.isPollingOI && this.connected) {
      const start = Date.now();
      const candidates = this.selectOICandidates();
      if (candidates.length > 0) await Promise.all(candidates.map((sym) => this.fetchOI(sym)));
      const sleep = Math.max(1000 - (Date.now() - start), 100);
      await new Promise((r) => setTimeout(r, sleep));
    }
  }

  private selectOICandidates(): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [sym, p] of this.priorityMap.entries()) {
      let interval = 15000;
      if (p.priority === 1) interval = 60000;
      else if (p.priority === 10) interval = 2000;
      if (now - p.lastUpdated > interval) {
        result.push(sym);
        if (result.length >= MAX_REQ_PER_SEC) break;
      }
    }
    return result;
  }

  private async fetchOI(symbol: string): Promise<void> {
    try {
      const res = await this.axiosInstance.get(BINANCE_FUTURES_OI_API, { params: { symbol } });
      if (res.data?.openInterest) {
        const val = parseFloat(res.data.openInterest);
        const state = this.marketStates.get(symbol);
        if (state) {
          const prevOI = state.openInterest || val;
          state.openInterest = val;

          // Поднят порог до 0.5% (было 0.1%), чтобы снизить шум
          if (Math.abs(val - prevOI) / prevOI > 0.005 && state.lastCandleTimestamp > 0) {
            const currentCandleTS = Math.floor(Date.now() / 60000) * 60000;
            this.emitUpdate(state, {
              price: state.lastPrice,
              isClosed: false,
              timestamp: currentCandleTS,
              ohlc: undefined,
              indicators: {
                cvd: state.cumulativeCVD,
                candleDelta: 0,
                fundingRate: state.fundingRate,
                openInterest: state.openInterest,
                liquidationsLong: state.accLiqLong,
                liquidationsShort: state.accLiqShort,
                liqCountLong: state.countLiqLong,
                liqCountShort: state.countLiqShort,
                liqMaxLong: state.maxLiqLong,
                liqMaxShort: state.maxLiqShort,
              }
            });
          }
        }
        const p = this.priorityMap.get(symbol);
        if (p) p.lastUpdated = Date.now();
      }
    } catch { }
  }

  public async subscribe(symbols: string[]): Promise<void> { }
  public async unsubscribe(symbols: string[]): Promise<void> { }
  public async getAvailableSymbols(): Promise<string[]> { return Array.from(this.symbols); }
  public onPriceUpdate(callback: PriceUpdateCallback): void { this.callback = callback; }
  public isConnected(): boolean { return this.connected; }
  public getHealthStatus(): ProviderHealthStatus {
    return {
      providerId: this.providerId,
      marketType: this.marketType,
      isConnected: this.connected,
      lastUpdateTime: this.lastUpdateTime,
      messageCount: this.messageCount,
      reconnectAttempts: this.reconnectAttempts,
      errorCount: this.errorCount,
    };
  }
}