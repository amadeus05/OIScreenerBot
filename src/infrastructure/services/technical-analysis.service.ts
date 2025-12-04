import { Injectable } from '../../shared/decorators';
import { ITechnicalAnalysisService, IAnalysisResult } from '../../domain/interfaces/services.interface';
import { SmartCandle } from '../../domain/interfaces/market-data.interface';

@Injectable()
export class TechnicalAnalysisService implements ITechnicalAnalysisService {
  
  public calculateChanges(candles: SmartCandle[], timeIntervalMinutes: number): IAnalysisResult | null {
    if (!candles || candles.length < 2) return null;

    const endCandle = candles[candles.length - 1]; 
    const now = endCandle.ts;
    const windowStart = now - (timeIntervalMinutes * 60 * 1000);

    let startCandle: SmartCandle | null = null;
    
    for (let i = candles.length - 2; i >= 0; i--) {
      if (candles[i].ts <= windowStart) {
        startCandle = candles[i];
        break;
      }
    }

    if (!startCandle && candles.length > 0) startCandle = candles[0];

    if (!startCandle || startCandle === endCandle) return null;

    // Расчеты
    const oiStart = startCandle.futures.oi;
    const oiEnd = endCandle.futures.oi;
    const oiChangePercent = oiStart > 0 ? ((oiEnd - oiStart) / oiStart) * 100 : 0;

    const priceStart = startCandle.ohlc.c;
    const priceEnd = endCandle.ohlc.c;
    const priceChangePercent = priceStart > 0 ? ((priceEnd - priceStart) / priceStart) * 100 : 0;

    let liqLong = 0;
    let liqShort = 0;
    let totalVolume = 0;
    
    const startIndex = candles.indexOf(startCandle);
    for (let i = startIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      liqLong += c.orderFlow.liquidations.long;
      liqShort += c.orderFlow.liquidations.short;
      totalVolume += c.ohlc.v;
    }

    const cvdDelta = endCandle.orderFlow.cvd - startCandle.orderFlow.cvd;

    return {
      symbol: '', 
      oiChangePercent,
      oiStart,
      oiEnd,
      priceChangePercent,
      currentPrice: priceEnd,
      previousPrice: priceStart,
      totalVolume,
      cvdDelta,
      liquidations: {
        long: liqLong,
        short: liqShort
      },
      timeWindowSeconds: (endCandle.ts - startCandle.ts) / 1000
    };
  }
}