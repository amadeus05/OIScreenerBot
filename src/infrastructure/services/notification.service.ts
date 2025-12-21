import { Inject, Injectable } from '../../shared/decorators';
import { INotificationService, IAnalysisResult, IMarketDataRepository } from '../../domain/interfaces/services.interface';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { SignalDto } from '../../application/dto/signal.dto';
import { SignalHandler } from '../../presentation/telegram/handlers/signal.handler';
import { Logger } from '../../shared/logger';
import { ITradeService, PlaceOrderRequest } from '../../domain/interfaces/trade.interface';
import { TradeSide } from '../../domain/types/trade.types';

@Injectable()
export class NotificationService implements INotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly autoTradeEnabled = process.env.ENABLE_AUTO_TRADE === 'true';
  private readonly defaultUsdtSize = Number(process.env.TRADE_DEFAULT_USDT_SIZE || '10');
  private readonly defaultLeverage = Number(process.env.TRADE_LEVERAGE || '3');
  private readonly stopLossPercent = Number(process.env.TRADE_STOP_LOSS_PCT || '0');
  private readonly takeProfitPercent = Number(process.env.TRADE_TAKE_PROFIT_PCT || '0');

  constructor(
    private readonly signalHandler: SignalHandler,
    @Inject('ISignalRepository') private readonly signalRepository: ISignalRepository,
    @Inject('IMarketDataRepository') private readonly marketDataRepository: IMarketDataRepository,
    @Inject('ITradeService') private readonly tradeService: ITradeService,
  ) { }

  public async processTrigger(trigger: Trigger, result: IAnalysisResult): Promise<void> {
    const signalDto = new SignalDto(
      0, // Будет присвоен в Handler
      result.symbol,
      result.oiChangePercent,
      result.oiStart,
      result.oiEnd,
      result.totalVolume,
      result.previousVolume,
      result.cvdDelta,
      result.liquidations.long,
      result.liquidations.short,
      result.priceChangePercent,
      result.currentPrice,
      result.previousPrice,
      new Date(),
      trigger.timeIntervalMinutes,
    );

    const savedSignal = await this.signalHandler.handleSignal(
      signalDto,
      trigger.id,
      trigger.userId,
      trigger.timeIntervalMinutes,
    );

    if (!this.autoTradeEnabled) return;

    try {
      const side: TradeSide = trigger.direction === 'up' ? 'BUY' : 'SELL';
      const price = this.resolvePrice(result);
      const quantity = this.normalizeQuantity(this.defaultUsdtSize / price);
      const stopLoss = this.computeStopLoss(side, price);
      const takeProfit = this.computeTakeProfit(side, price);

      const order: PlaceOrderRequest = {
        symbol: result.symbol,
        side,
        type: 'MARKET',
        quantity,
        leverage: this.defaultLeverage,
        stopLoss,
        takeProfit,
        signalId: savedSignal.id,
        source: 'auto-trade',
        tags: [`trigger:${trigger.id}`, `interval:${trigger.timeIntervalMinutes}`],
      };

      await this.tradeService.placeOrder(order);
      this.logger.info(`[AUTO-TRADE] Ордер отправлен ${order.symbol} ${order.side} qty=${order.quantity}`);
    } catch (error) {
      this.logger.warn(`[AUTO-TRADE] Не удалось разместить ордер для ${result.symbol}`, error);
    }
  }

  private resolvePrice(result: IAnalysisResult): number {
    const price = result.currentPrice || this.marketDataRepository.getCurrentPrice(result.symbol);
    if (!price || price <= 0) {
      throw new Error(`Нет валидной цены для ${result.symbol}`);
    }
    return price;
  }

  private normalizeQuantity(qty: number): number {
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Некорректное количество: ${qty}`);
    }
    // Округляем до 6 знаков — достаточно для большинства фьючерсных пар
    return Number(qty.toFixed(6));
  }

  private computeStopLoss(side: TradeSide, entryPrice: number): number | undefined {
    if (this.stopLossPercent <= 0) return undefined;
    const delta = entryPrice * (this.stopLossPercent / 100);
    return side === 'BUY' ? entryPrice - delta : entryPrice + delta;
  }

  private computeTakeProfit(side: TradeSide, entryPrice: number): number | undefined {
    if (this.takeProfitPercent <= 0) return undefined;
    const delta = entryPrice * (this.takeProfitPercent / 100);
    return side === 'BUY' ? entryPrice + delta : entryPrice - delta;
  }
}