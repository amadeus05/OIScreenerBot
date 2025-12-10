import { Injectable } from '../../shared/decorators';
import { IMarketDataRepository, ITriggerEngineService } from '../../domain/interfaces/services.interface';
import { MarketData, SmartCandle } from '../../domain/interfaces/market-data.interface';

class SymbolBuffer {
  public candles: SmartCandle[] = [];
  public lastPrice: number = 0;
  private readonly LIMIT = 1000;
  private pendingUpdates = new Map<number, Partial<any>>();

  // === NEW METHOD ===
  public injectHistory(history: SmartCandle[]) {
    if (history.length === 0) return;

    // Используем Map для дедупликации по timestamp.
    // Приоритет: Данные, которые уже есть в буфере (они пришли по WS и новее/точнее),
    // перезаписывают историю, если таймстемпы совпадают.
    const map = new Map<number, SmartCandle>();

    // 1. Заливаем историю
    history.forEach(c => map.set(c.ts, c));

    // 2. Накладываем текущий буфер (живые данные)
    this.candles.forEach(c => map.set(c.ts, c));

    // 3. Сортируем
    const sorted = Array.from(map.values()).sort((a, b) => a.ts - b.ts);

    // 4. Обрезаем
    if (sorted.length > this.LIMIT) {
        this.candles = sorted.slice(sorted.length - this.LIMIT);
    } else {
        this.candles = sorted;
    }
  }

  public update(data: MarketData) {
    if (data.price) this.lastPrice = data.price;
    const ind = data.indicators;
    
    if (data.ohlc) {
      const pending = this.pendingUpdates.get(data.timestamp) || {};
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
    else if (ind) {
      const last = this.getLast();
      if (last && last.ts === data.timestamp) {
        if (ind.openInterest) last.futures.oi = ind.openInterest;
        if (ind.fundingRate) last.futures.funding = ind.fundingRate;
      }
      else if (data.timestamp > (last?.ts || 0)) {
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

  // === NEW METHOD EXPOSED ===
  public injectHistory(symbol: string, history: SmartCandle[]): void {
      let buffer = this.store.get(symbol);
      if (!buffer) {
          buffer = new SymbolBuffer();
          this.store.set(symbol, buffer);
      }
      buffer.injectHistory(history);
  }

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