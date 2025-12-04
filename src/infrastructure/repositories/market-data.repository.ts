import { Injectable } from '../../shared/decorators';
import { IMarketDataRepository, ITriggerEngineService } from '../../domain/interfaces/services.interface';
import { MarketData, SmartCandle } from '../../domain/interfaces/market-data.interface';

// Внутренний буфер для одной пары
class SymbolBuffer {
  public candles: SmartCandle[] = [];
  public lastPrice: number = 0;
  private readonly LIMIT = 1000;
  
  // Буфер для OI, пришедшего раньше свечи
  private pendingIndicators = new Map<number, Partial<any>>();

  public update(data: MarketData) {
    if (data.price) this.lastPrice = data.price;
    const incoming = data.indicators;

    // A. Пришла полная свеча (Kline)
    if (data.ohlc) {
      const pending = this.pendingIndicators.get(data.timestamp) || {};
      
      const liqLong = incoming?.liquidationsLong ?? pending.liqLong ?? 0;
      const liqShort = incoming?.liquidationsShort ?? pending.liqShort ?? 0;

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
          oi: incoming?.openInterest ?? pending.oi ?? this.getLast()?.futures.oi ?? 0,
          funding: incoming?.fundingRate ?? pending.funding ?? this.getLast()?.futures.funding ?? 0,
        },
        orderFlow: {
          cvd: incoming?.cvd ?? pending.cvd ?? this.getLast()?.orderFlow.cvd ?? 0,
          delta: incoming?.candleDelta ?? pending.delta ?? 0,
          liquidations: {
            long: liqLong,
            short: liqShort,
            maxLong: Math.max(incoming?.liqMaxLong ?? 0, pending.liqMaxLong ?? 0, liqLong),
            maxShort: Math.max(incoming?.liqMaxShort ?? 0, pending.liqMaxShort ?? 0, liqShort),
          }
        }
      };

      const last = this.getLast();
      if (last && last.ts === newCandle.ts) {
        // Обновляем текущую (Live) свечу (Overwrite)
        Object.assign(last, newCandle);
      } else {
        // Новая свеча
        this.candles.push(newCandle);
        if (this.candles.length > this.LIMIT) this.candles.shift();
        this.cleanupPending(newCandle.ts);
      }
      this.pendingIndicators.delete(data.timestamp);
    } 
    // B. Пришли только индикаторы (Smart Polling)
    else if (incoming) {
      const last = this.getLast();
      if (last && last.ts === data.timestamp) {
        // Обновляем Live
        if (incoming.openInterest) last.futures.oi = incoming.openInterest;
        if (incoming.fundingRate) last.futures.funding = incoming.fundingRate;
      } else if (data.timestamp > (last?.ts || 0)) {
        // Будущее - в Pending
        const existing = this.pendingIndicators.get(data.timestamp) || {};
        this.pendingIndicators.set(data.timestamp, {
          ...existing,
          oi: incoming.openInterest ?? existing.oi,
          funding: incoming.fundingRate ?? existing.funding,
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
    for (const ts of this.pendingIndicators.keys()) {
      if (ts < currentTs) this.pendingIndicators.delete(ts);
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

    // Уведомляем движок о новых данных (Real-time check)
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