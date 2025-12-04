import { Injectable } from '../../shared/decorators';
import { ITechnicalAnalysisService, IAnalysisResult } from '../../domain/interfaces/services.interface';
import { SmartCandle } from '../../domain/interfaces/market-data.interface';

@Injectable()
export class TechnicalAnalysisService implements ITechnicalAnalysisService {

  public calculateChanges(candles: SmartCandle[], timeIntervalMinutes: number): IAnalysisResult | null {
    if (!candles || candles.length < 2) return null;

    const endCandle = candles[candles.length - 1]; // Текущая (Live)
    const now = endCandle.ts;
    const windowStartTimestamp = now - (timeIntervalMinutes * 60 * 1000);

    // Бинарный поиск для скорости
    const startIndex = this.findStartIndex(candles, windowStartTimestamp);

    if (startIndex === -1 || startIndex >= candles.length - 1) return null;

    const windowCandles = candles.slice(startIndex);
    if (windowCandles.length < 2) return null;

    const startCandle = windowCandles[0];
    const currentOI = endCandle.futures.oi;

    // --- ДИНАМИЧЕСКИЙ АНАЛИЗ ---
    let minOI = Infinity;
    let maxOI = -Infinity;

    for (const c of windowCandles) {
      const oi = c.futures.oi;
      if (oi < minOI) minOI = oi;
      if (oi > maxOI) maxOI = oi;
    }

    // FIX: Нормализация Infinity, если данных не было или они были 0
    if (minOI === Infinity) minOI = 0;
    if (maxOI === -Infinity) maxOI = 0;

    // 1. Runup: Рост от дна
    let maxRunupPercent = 0;
    if (minOI > 0) {
      maxRunupPercent = ((currentOI - minOI) / minOI) * 100;
    }

    // 2. Drawdown: Падение от пика
    let maxDrawdownPercent = 0;
    if (maxOI > 0) {
      maxDrawdownPercent = ((currentOI - maxOI) / maxOI) * 100;
    }

    // --- КЛАССИЧЕСКИЙ АНАЛИЗ ---
    const oiStart = startCandle.futures.oi;
    const oiChangePercent = oiStart > 0 ? ((currentOI - oiStart) / oiStart) * 100 : 0;

    // --- ОСТАЛЬНЫЕ МЕТРИКИ ---
    const priceStart = startCandle.ohlc.c;
    const priceEnd = endCandle.ohlc.c;
    const priceChangePercent = priceStart > 0 ? ((priceEnd - priceStart) / priceStart) * 100 : 0;

    let liqLong = 0;
    let liqShort = 0;
    let totalVolume = 0;

    for (let i = 1; i < windowCandles.length; i++) {
      const c = windowCandles[i];
      liqLong += c.orderFlow.liquidations.long;
      liqShort += c.orderFlow.liquidations.short;
      totalVolume += c.ohlc.v;
    }

    const cvdDelta = endCandle.orderFlow.cvd - startCandle.orderFlow.cvd;

    return {
      symbol: '',
      oiChangePercent,
      oiStart,
      oiEnd: currentOI,

      // Исправленные безопасные значения
      maxRunupPercent,
      maxDrawdownPercent,
      lowestOI: minOI,
      highestOI: maxOI,

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

  private findStartIndex(candles: SmartCandle[], targetTs: number): number {
    let left = 0;
    let right = candles.length - 1;
    let result = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (candles[mid].ts >= targetTs) {
        result = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    return result;
  }
}