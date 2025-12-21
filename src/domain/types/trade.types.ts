export type TradeSide = 'BUY' | 'SELL';

export type TradeType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT_MARKET';

export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export type TradeStatus =
  | 'NEW'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PENDING_CANCEL'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CLOSED';

export type PositionSide = 'LONG' | 'SHORT';

