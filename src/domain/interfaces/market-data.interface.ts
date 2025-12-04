export interface LiquidationEvent {
  side: 'LONG' | 'SHORT';
  price: number;
  quantity: number;
  amountUSD: number;
}

/**
 * Основная сущность свечи.
 */
export interface SmartCandle {
  ts: number;

  ohlc: {
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  };

  futures: {
    oi: number;         // Open Interest
    funding: number;    // Funding Rate
  };

  orderFlow: {
    cvd: number;        // Cumulative Volume Delta
    delta: number;      // Net Delta внутри этой свечи
    liquidations: {
      long: number;     // Накопленный объем ликвидаций лонгов ($)
      short: number;    // Накопленный объем ликвидаций шортов ($)

      countLong: number;  // Количество ликвидаций
      countShort: number; // Количество ликвидаций

      maxLong: number;  // "Кит" (максимальная единичная ликвидация)
      maxShort: number;
    };
  };
}

/**
 * DTO для передачи данных от Провайдера в Репозиторий.
 */
export interface MarketData {
  providerId: string;
  marketType: 'spot' | 'futures';
  symbol: string;
  price: number;
  timestamp: number;
  isCandleClosed: boolean;

  ohlc?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };

  indicators?: {
    cvd: number;
    candleDelta: number;
    fundingRate: number;
    openInterest: number;

    liquidationsLong: number;
    liquidationsShort: number;
    liqCountLong: number;
    liqCountShort: number;
    liqMaxLong: number;
    liqMaxShort: number;
  };

  liquidationEvent?: LiquidationEvent;
}