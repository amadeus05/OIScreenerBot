import 'reflect-metadata';
import { MarketDataRepository } from '../infrastructure/repositories/market-data.repository';
import { MarketData } from '../domain/interfaces/market-data.interface';

describe('MarketDataRepository', () => {
  let repository: MarketDataRepository;

  beforeEach(() => {
    repository = new MarketDataRepository();
  });

  it('should create a new buffer for a new symbol', () => {
    const data: MarketData = {
      providerId: 'binance',
      marketType: 'futures',
      symbol: 'BTCUSDT',
      price: 50000,
      timestamp: 1000,
      isCandleClosed: false,
      ohlc: { open: 50000, high: 50000, low: 50000, close: 50000, volume: 100 },
      indicators: {
        cvd: 0, candleDelta: 0, fundingRate: 0, openInterest: 1000,
        liquidationsLong: 50, liquidationsShort: 0, // Накоплено 50
        liqCountLong: 1, liqCountShort: 0, liqMaxLong: 50, liqMaxShort: 0
      }
    };

    repository.updateMarketData(data);
    const candle = repository.getLastCandle('BTCUSDT');

    expect(candle).toBeDefined();
    expect(candle?.ohlc.v).toBe(100);
    expect(candle?.orderFlow.liquidations.long).toBe(50);
  });

  it('should OVERWRITE (synchronize) running totals for the SAME candle', () => {
    // 1. Первое обновление свечи (T=1000)
    repository.updateMarketData({
      providerId: 'test', marketType: 'futures', symbol: 'ETHUSDT', price: 2000, timestamp: 1000, isCandleClosed: false,
      ohlc: { open: 2000, high: 2000, low: 2000, close: 2000, volume: 10 }, // Vol = 10
      indicators: {
        cvd: 0, candleDelta: 0, fundingRate: 0, openInterest: 100,
        liquidationsLong: 1000, liquidationsShort: 0, // Liq = 1000
        liqCountLong: 1, liqCountShort: 0, liqMaxLong: 1000, liqMaxShort: 0
      }
    });

    // 2. Второе обновление ТОЙ ЖЕ свечи (T=1000), объем вырос
    repository.updateMarketData({
      providerId: 'test', marketType: 'futures', symbol: 'ETHUSDT', price: 2001, timestamp: 1000, isCandleClosed: false,
      ohlc: { open: 2000, high: 2001, low: 2000, close: 2001, volume: 15 }, // Vol стало 15 (Accumulated)
      indicators: {
        cvd: 0, candleDelta: 0, fundingRate: 0, openInterest: 105,
        liquidationsLong: 1500, liquidationsShort: 0, // Liq стало 1500 (Accumulated)
        liqCountLong: 2, liqCountShort: 0, liqMaxLong: 1000, liqMaxShort: 0
      }
    });

    const candle = repository.getLastCandle('ETHUSDT');
    
    // ПРОВЕРКА: Значения должны быть равны последнему пришедшему пакету, а не сумме (10+15)
    expect(candle?.ohlc.v).toBe(15); 
    expect(candle?.orderFlow.liquidations.long).toBe(1500);
    expect(candle?.futures.oi).toBe(105);
  });

  it('should create NEW candle when timestamp changes', () => {
    // Свеча 1
    repository.updateMarketData({
      providerId: 'test', marketType: 'futures', symbol: 'SOLUSDT', price: 100, timestamp: 1000, isCandleClosed: true,
      ohlc: { open: 100, high: 100, low: 100, close: 100, volume: 10 },
    });

    // Свеча 2
    repository.updateMarketData({
      providerId: 'test', marketType: 'futures', symbol: 'SOLUSDT', price: 101, timestamp: 2000, isCandleClosed: false,
      ohlc: { open: 101, high: 101, low: 101, close: 101, volume: 5 },
    });

    const history = repository.getHistory('SOLUSDT', 10);
    expect(history.length).toBe(2);
    expect(history[0].ts).toBe(1000);
    expect(history[1].ts).toBe(2000);
  });

  it('should handle pending indicators (OI update arrives before Candle)', () => {
    const ts = 5000;
    
    // 1. Пришел только OI (timestamp из будущего относительно пустого буфера)
    repository.updateMarketData({
      providerId: 'test', marketType: 'futures', symbol: 'BNBUSDT', price: 300, timestamp: ts, isCandleClosed: false,
      indicators: { 
          openInterest: 9999, fundingRate: 0.01,
          cvd: 0, candleDelta: 0, liquidationsLong: 0, liquidationsShort: 0,
          liqCountLong: 0, liqCountShort: 0, liqMaxLong: 0, liqMaxShort: 0
      }
    });

    // 2. Приходит свеча с тем же timestamp
    repository.updateMarketData({
      providerId: 'test', marketType: 'futures', symbol: 'BNBUSDT', price: 300, timestamp: ts, isCandleClosed: false,
      ohlc: { open: 300, high: 300, low: 300, close: 300, volume: 50 },
      // ВАЖНО: Мы НЕ передаем сюда openInterest, либо передаем undefined, 
      // чтобы репозиторий взял значение из Pending.
      // Если передать 0, он перезапишет 9999 на 0.
      indicators: { 
        // openInterest: undefined, // <--- Убираем поле или ставим undefined
        fundingRate: 0,
        cvd: 0, candleDelta: 0, liquidationsLong: 0, liquidationsShort: 0,
        liqCountLong: 0, liqCountShort: 0, liqMaxLong: 0, liqMaxShort: 0
      } as any // cast as any, чтобы TS не ругался на отсутствие обязательных полей (в тесте допустимо)
    });

    const candle = repository.getLastCandle('BNBUSDT');
    expect(candle?.futures.oi).toBe(9999); 
  });
});