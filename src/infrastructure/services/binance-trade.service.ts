import Binance, { OrderSide, OrderType, TimeInForce } from 'binance-api-node';
import { Inject, Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import {
  ClosePositionRequest,
  ITradeRepository,
  ITradeService,
  PlaceOrderRequest,
} from '../../domain/interfaces/trade.interface';
import { Trade } from '../../domain/entities/trade.entity';
import { IMarketDataRepository } from '../../domain/interfaces/services.interface';
import { TradeSnapshot, TradeStatus, TradeSide } from '../../domain/types/trade.types';

const DEFAULT_HTTP_BASE =
  process.env.BINANCE_TESTNET_HTTP_BASE || 'https://testnet.binancefuture.com';
const DEFAULT_WS_BASE =
  process.env.BINANCE_TESTNET_WS_BASE || 'wss://stream.binancefuture.com';

@Injectable()
export class BinanceTradeService implements ITradeService {
  private readonly logger = new Logger(BinanceTradeService.name);
  private readonly client;
  private readonly hasCredentials: boolean;

  constructor(
    @Inject('ITradeRepository') private readonly tradeRepo: ITradeRepository,
    @Inject('IMarketDataRepository')
    private readonly marketDataRepo: IMarketDataRepository,
  ) {
    const apiKey = process.env.BINANCE_TESTNET_API_KEY;
    const apiSecret = process.env.BINANCE_TESTNET_SECRET_KEY;

    this.hasCredentials = Boolean(apiKey && apiSecret);
    if (!this.hasCredentials) {
      this.logger.warn(
        'Binance testnet API keys are not set. Trading calls will throw until keys are provided.',
      );
    }

    this.client = Binance({
      apiKey: apiKey || '',
      apiSecret: apiSecret || '',
      httpBase: DEFAULT_HTTP_BASE,
      wsBase: DEFAULT_WS_BASE,
    });
  }

  public async placeOrder(request: PlaceOrderRequest): Promise<Trade> {
    this.ensureCredentials();

    const {
      symbol,
      side,
      type,
      quantity,
      price,
      stopLoss,
      takeProfit,
      leverage = 1,
      timeInForce,
      positionSide,
      clientOrderId,
      signalId,
      source,
      tags,
    } = request;

    const orderPayload = {
      symbol,
      side: side as OrderSide,
      type: type as OrderType,
      quantity: quantity.toString(),
      ...(price ? { price: price.toString() } : {}),
      ...(timeInForce ? { timeInForce: timeInForce as TimeInForce } : {}),
      ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
      ...(positionSide ? { positionSide } : {}),
    };

    const snapshot = this.buildSnapshot(symbol);

    const trade = await this.tradeRepo.createTrade({
      symbol,
      side,
      type,
      quantity,
      price: price ?? null,
      stopLoss: stopLoss ?? null,
      takeProfit: takeProfit ?? null,
      leverage,
      timeInForce: timeInForce ?? null,
      positionSide: positionSide ?? null,
      signalId: signalId ?? null,
      source: source ?? null,
      tags: tags ?? null,
      requestPayload: orderPayload,
      clientOrderId: clientOrderId ?? null,
      snapshot: snapshot ?? null,
      status: 'NEW',
    });

    try {
      await this.applyLeverage(symbol, leverage);

      const orderResponse = await this.client.futuresOrder(orderPayload);
      const avgPrice = (orderResponse as any).avgPrice;

      const updated = await this.tradeRepo.updateTrade(trade.id, {
        binanceOrderId: orderResponse.orderId?.toString() ?? null,
        clientOrderId: orderResponse.clientOrderId ?? clientOrderId ?? null,
        status: (orderResponse.status as TradeStatus) || 'SUBMITTED',
        executedQuantity: orderResponse.executedQty
          ? parseFloat(orderResponse.executedQty)
          : null,
        averagePrice: avgPrice ? parseFloat(avgPrice) : price ?? null,
        exchangeResponse: orderResponse,
      });

      return this.attachProtectionOrders(
        updated,
        side,
        stopLoss,
        takeProfit,
        quantity,
      );
    } catch (error) {
      await this.tradeRepo.updateTrade(trade.id, {
        status: 'FAILED',
        errorPayload: this.serializeError(error),
      });
      this.logger.error(`Failed to place order for ${symbol}`, error);
      throw error;
    }
  }

  public async closePosition(request: ClosePositionRequest): Promise<void> {
    this.ensureCredentials();
    const { symbol, quantity, reason } = request;

    const positions = await this.client.futuresPositionRisk({ symbol });
    const position = positions.find(
      (p: any) => p.symbol === symbol && Number(p.positionAmt) !== 0,
    );

    if (!position) {
      this.logger.warn(`No open position found for ${symbol}`);
      return;
    }

    const amount = Math.abs(Number(position.positionAmt));
    const side =
      Number(position.positionAmt) > 0 ? OrderSide.SELL : OrderSide.BUY;

    // reduceOnly отсутствует в тайпингах binance-api-node, но поддерживается API — приводим к any.
    const closeOrderPayload: any = {
      symbol,
      side,
      type: OrderType.MARKET,
      quantity: (quantity ?? amount).toString(),
      reduceOnly: true,
    };
    await this.client.futuresOrder(closeOrderPayload);

    await this.markSymbolTradesClosed(symbol, reason);
  }

  public async syncTradeStatus(tradeId: number): Promise<Trade> {
    this.ensureCredentials();
    const trade = await this.tradeRepo.findById(tradeId);
    if (!trade || !trade.binanceOrderId) {
      throw new Error(`Trade ${tradeId} not found or missing Binance order id`);
    }

    const order = await this.client.futuresGetOrder({
      symbol: trade.symbol,
      orderId: Number(trade.binanceOrderId),
    });

    const status = (order.status as TradeStatus) || trade.status;
    const avgPrice = (order as any).avgPrice;
    return this.tradeRepo.updateTrade(trade.id, {
      status,
      executedQuantity: order.executedQty
        ? parseFloat(order.executedQty)
        : trade.executedQuantity,
      averagePrice: avgPrice
        ? parseFloat(avgPrice)
        : trade.averagePrice,
      exchangeResponse: {
        ...(trade.exchangeResponse || {}),
        lastSync: Date.now(),
        order,
      },
    });
  }

  public async listOpenPositions(): Promise<unknown> {
    this.ensureCredentials();
    return this.client.futuresPositionRisk();
  }

  private async attachProtectionOrders(
    trade: Trade,
    side: TradeSide,
    stopLoss?: number,
    takeProfit?: number,
    quantity?: number,
  ): Promise<Trade> {
    let stopOrderId: string | null = null;
    let tpOrderId: string | null = null;
    const oppositeSide: OrderSide = side === 'BUY' ? OrderSide.SELL : OrderSide.BUY;

    if (stopLoss) {
      try {
        const stopOrderPayload: any = {
          symbol: trade.symbol,
          side: oppositeSide,
          type: OrderType.STOP_MARKET,
          stopPrice: stopLoss.toString(),
          closePosition: true,
          quantity: quantity?.toString(),
        };
        const stopOrder = await this.client.futuresOrder(stopOrderPayload);
        stopOrderId = stopOrder.orderId?.toString() ?? null;
      } catch (error) {
        this.logger.warn(
          `Failed to set stop-loss for ${trade.symbol}: ${
            (error as Error).message
          }`,
        );
      }
    }

    if (takeProfit) {
      try {
        const tpOrderPayload: any = {
          symbol: trade.symbol,
          side: oppositeSide,
          type: OrderType.TAKE_PROFIT_MARKET,
          stopPrice: takeProfit.toString(),
          closePosition: true,
          quantity: quantity?.toString(),
        };
        const tpOrder = await this.client.futuresOrder(tpOrderPayload);
        tpOrderId = tpOrder.orderId?.toString() ?? null;
      } catch (error) {
        this.logger.warn(
          `Failed to set take-profit for ${trade.symbol}: ${
            (error as Error).message
          }`,
        );
      }
    }

    if (stopOrderId || tpOrderId) {
      return this.tradeRepo.updateTrade(trade.id, {
        stopOrderId,
        takeProfitOrderId: tpOrderId,
      });
    }

    return trade;
  }

  private async applyLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.client.futuresLeverage({ symbol, leverage });
    } catch (error) {
      this.logger.warn(
        `Failed to set leverage ${leverage} for ${symbol}: ${
          (error as Error).message
        }`,
      );
    }
  }

  private async markSymbolTradesClosed(
    symbol: string,
    reason?: string,
  ): Promise<void> {
    const openTrades = await this.tradeRepo.findOpenTrades();
    const toClose = openTrades.filter((t) => t.symbol === symbol);

    await Promise.all(
      toClose.map((trade) =>
        this.tradeRepo.updateTrade(trade.id, {
          status: 'CLOSED',
          closedAt: new Date(),
          errorPayload: reason
            ? { ...(trade.errorPayload || {}), closeReason: reason }
            : trade.errorPayload,
        }),
      ),
    );
  }

  private buildSnapshot(symbol: string): TradeSnapshot | null {
    try {
      const recentCandles =
        this.marketDataRepo.getHistory(symbol, 120)?.slice(-60) || [];
      const lastCandle =
        recentCandles.length > 0 ? recentCandles[recentCandles.length - 1] : undefined;
      const price =
        this.marketDataRepo.getCurrentPrice(symbol) ||
        lastCandle?.ohlc.c ||
        0;

      return {
        takenAt: Date.now(),
        price,
        lastCandle,
        recentCandles,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to build trade snapshot for ${symbol}: ${
          (error as Error).message
        }`,
      );
      return null;
    }
  }

  private ensureCredentials(): void {
    if (!this.hasCredentials) {
      throw new Error(
        'Binance testnet credentials are missing. Set BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_SECRET_KEY.',
      );
    }
  }

  private serializeError(error: unknown): Record<string, unknown> {
    if (!error || typeof error !== 'object') {
      return { message: String(error) };
    }

    const err = error as any;
    return {
      message: err.message,
      name: err.name,
      code: err.code,
      stack: err.stack,
      response: err.response?.data ?? err.response,
    };
  }
}

