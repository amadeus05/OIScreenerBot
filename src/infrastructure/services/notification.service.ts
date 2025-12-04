import { Inject, Injectable } from '../../shared/decorators';
import { INotificationService, IAnalysisResult } from '../../domain/interfaces/services.interface';
import { ISignalRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { SignalDto } from '../../application/dto/signal.dto';
import { SignalHandler } from '../../presentation/telegram/handlers/signal.handler';
import { Logger } from '../../shared/logger';

@Injectable()
export class NotificationService implements INotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly signalHandler: SignalHandler,
    @Inject('ISignalRepository') private readonly signalRepository: ISignalRepository,
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

    await this.signalHandler.handleSignal(
      signalDto,
      trigger.id,
      trigger.userId,
      trigger.timeIntervalMinutes,
    );
  }
}