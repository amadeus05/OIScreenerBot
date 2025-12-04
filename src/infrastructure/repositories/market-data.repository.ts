import { Injectable } from '../../shared/decorators';
import { IMarketDataRepository, ITriggerEngineService } from '../../domain/interfaces/services.interface';
import { MarketData, SmartCandle } from '../../domain/interfaces/market-data.interface';

class SymbolBuffer {
  public candles: SmartCandle[] = [];
  public lastPrice: number = 0;
  private readonly LIMIT = 1000;

  private pendingUpdates = new Map<number, Partial<any>>();

  public update(data: MarketData) {
    if (data.price) this.lastPrice = data.price;
    const ind = data.indicators;

    // --- СЦЕНАРИЙ 1: Полные данные свечи (OHLC + Индикаторы) ---
    if (data.ohlc) {
      const pending = this.pendingUpdates.get(data.timestamp) || {};

      // Мы не читаем ликвидации из pending, так как OI-поллинг их не сохраняет.
      // Берем только текущие входящие данные.
      const liqLong = ind?.liquidationsLong ?? 0;
      const liqShort = ind?.liquidationsShort ?? 0;

      const newCandle: SmartCandle = {
        ts: data.timestamp,
        ohlc: {
          o: data.ohlc.open,
          h: data.ohlc.high,
          l: data.ohlc.low,
          c: data.ohlc.close,
          v: data.ohlc.volume,
        },
        futures: {
          // OI и Funding могут быть в pending
          oi: ind?.openInterest ?? pending.oi ?? this.getLast()?.futures.oi ?? 0,
          funding: ind?.fundingRate ?? pending.funding ?? this.getLast()?.futures.funding ?? 0,
        },
        orderFlow: {
          cvd: ind?.cvd ?? pending.cvd ?? this.getLast()?.orderFlow.cvd ?? 0,
          delta: ind?.candleDelta ?? pending.delta ?? 0,
          liquidations: {
            long: liqLong,
            short: liqShort,
            countLong: ind?.liqCountLong ?? 0,
            countShort: ind?.liqCountShort ?? 0,
            maxLong: Math.max(ind?.liqMaxLong ?? 0, liqLong),
            maxShort: Math.max(ind?.liqMaxShort ?? 0, liqShort),
          }
        }
      };

      const last = this.getLast();
      if (last && last.ts === newCandle.ts) {
        Object.assign(last, newCandle);
      } else {
        this.candles.push(newCandle);
        if (this.candles.length > this.LIMIT) this.candles.shift();
        this.cleanupPending(newCandle.ts);
      }
      this.pendingUpdates.delete(data.timestamp);
    }
    // --- СЦЕНАРИЙ 2: Только индикаторы (OI Polling) ---
    else if (ind) {
      const last = this.getLast();

      if (last && last.ts === data.timestamp) {
        if (ind.openInterest) last.futures.oi = ind.openInterest;
        if (ind.fundingRate) last.futures.funding = ind.fundingRate;
      }
      else if (data.timestamp > (last?.ts || 0)) {
        // Сохраняем только OI и Funding, так как они имеют смысл как Snapshot
        const existing = this.pendingUpdates.get(data.timestamp) || {};
        this.pendingUpdates.set(data.timestamp, {
          ...existing,
          oi: ind.openInterest ?? existing.oi,
          funding: ind.fundingRate ?? existing.funding,
        });
      }
    }
  }

  public getRecent(limit: number): SmartCandle[] {
    return limit >= this.candles.length ? this.candles : this.candles.slice(-limit);
  }

  public getLast(): SmartCandle | undefined {
    return this.candles[this.candles.length - 1];
  }

  private cleanupPending(currentTs: number) {
    for (const ts of this.pendingUpdates.keys()) {
      if (ts < currentTs) this.pendingUpdates.delete(ts);
    }
  }
}

@Injectable()
export class MarketDataRepository implements IMarketDataRepository {
  private store = new Map<string, SymbolBuffer>();
  private triggerEngine: ITriggerEngineService | null = null;

  public updateMarketData(data: MarketData): void {
    let buffer = this.store.get(data.symbol);
    if (!buffer) {
      buffer = new SymbolBuffer();
      this.store.set(data.symbol, buffer);
    }
    buffer.update(data);

    if (this.triggerEngine) {
      this.triggerEngine.onPriceUpdate(data.symbol, data.price);
    }
  }

  public getHistory(symbol: string, limit: number): SmartCandle[] {
    return this.store.get(symbol)?.getRecent(limit) || [];
  }

  public getLastCandle(symbol: string): SmartCandle | undefined {
    return this.store.get(symbol)?.getLast();
  }

  public getCurrentPrice(symbol: string): number {
    return this.store.get(symbol)?.lastPrice || 0;
  }

  public getAllKnownSymbols(): string[] {
    return Array.from(this.store.keys());
  }

  public isWarm(symbol: string): boolean {
    const buf = this.store.get(symbol);
    return !!buf && buf.candles.length > 5;
  }

  public setTriggerEngine(engine: ITriggerEngineService): void {
    this.triggerEngine = engine;
  }
}