import { Trade } from '../entities/trade.entity';
import {
  PositionSide,
  TimeInForce,
  TradeSide,
  TradeStatus,
  TradeType,
  TradeSnapshot,
} from '../types/trade.types';

export interface PlaceOrderRequest {
  symbol: string;
  side: TradeSide;
  type: TradeType;
  quantity: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  timeInForce?: TimeInForce;
  positionSide?: PositionSide;
  clientOrderId?: string;
  signalId?: number;
  source?: string;
  tags?: string[];
}

export interface ClosePositionRequest {
  symbol: string;
  quantity?: number;
  reason?: string;
}

export interface ITradeRepository {
  createTrade(payload: {
    symbol: string;
    side: TradeSide;
    type: TradeType;
    quantity: number;
    price?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
    leverage?: number | null;
    timeInForce?: TimeInForce | null;
    positionSide?: PositionSide | null;
    signalId?: number | null;
    source?: string | null;
    tags?: string[] | null;
    requestPayload?: Record<string, unknown> | null;
    clientOrderId?: string | null;
    snapshot?: TradeSnapshot | null;
    status?: TradeStatus;
  }): Promise<Trade>;
  updateTrade(id: number, patch: Partial<Trade>): Promise<Trade>;
  findById(id: number): Promise<Trade | null>;
  findOpenTrades(): Promise<Trade[]>;
}

export interface ITradeService {
  placeOrder(request: PlaceOrderRequest): Promise<Trade>;
  closePosition(request: ClosePositionRequest): Promise<void>;
  syncTradeStatus(tradeId: number): Promise<Trade>;
  listOpenPositions(): Promise<unknown>;
}

