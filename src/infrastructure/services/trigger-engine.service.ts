import { Inject, Injectable } from '../../shared/decorators';
import {
  IMarketDataRepository,
  ITechnicalAnalysisService,
  ITriggerEngineService,
  INotificationService,
  IAnalysisResult,
} from '../../domain/interfaces/services.interface';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { Logger } from '../../shared/logger';
import { UptimeService } from './uptime.service';

const BATCH_PROCESSING_SIZE = 50;
const FLUSH_MS = 100; // Debounce window

@Injectable()
export class TriggerEngineService implements ITriggerEngineService {
  private readonly logger = new Logger(TriggerEngineService.name);
  private isRunning = false;
  
  // Очередь обновлений для батчинга
  private pendingSymbols = new Map<string, number>(); 
  private pendingTimer: NodeJS.Timeout | null = null;

  // Rate Limiting
  private runningChecks = new Set<string>();
  private lastNotificationTime = new Map<string, number>();

  constructor(
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    @Inject('IMarketDataRepository') private readonly marketDataRepo: IMarketDataRepository,
    @Inject('ITechnicalAnalysisService') private readonly taService: ITechnicalAnalysisService,
    @Inject('INotificationService') private readonly notificationService: INotificationService,
    private readonly uptimeService: UptimeService,
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('TriggerEngine started');
    setInterval(() => this.cleanupCache(), 3600 * 1000); // Чистка кэша раз в час
  }

  public stop(): void {
    this.isRunning = false;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
  }

  public async onPriceUpdate(symbol: string, price: number): Promise<void> {
    if (!this.isRunning) return;
    
    // Добавляем в очередь. Если символ уже есть, обновляем цену.
    this.pendingSymbols.set(symbol, price);

    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  private async flush(): Promise<void> {
    if (!this.isRunning) return;
    
    // Забираем пачку символов на обработку
    const work = Array.from(this.pendingSymbols.entries()).slice(0, BATCH_PROCESSING_SIZE);
    for (const [symbol] of work) this.pendingSymbols.delete(symbol);

    // Если остались еще, планируем следующий тик
    if (this.pendingSymbols.size > 0 && !this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flush(), FLUSH_MS);
    } else {
      this.pendingTimer = null;
    }

    if (work.length === 0) return;

    // Получаем триггеры
    const activeTriggers = this.triggerRepository.getAllActive();
    if (!activeTriggers.length) return;

    // Сортировка по приоритету (наибольший % изменения - первые)
    const sortedTriggers = activeTriggers.sort((a, b) => 
      Math.abs(b.oiChangePercent) - Math.abs(a.oiChangePercent)
    );

    for (const [symbol, price] of work) {
      // Пропускаем "холодные" символы (без истории)
      if (!this.marketDataRepo.isWarm(symbol)) continue;
      
      for (const trigger of sortedTriggers) {
        await this.checkTrigger(trigger, symbol);
      }
    }
  }

  private async checkTrigger(trigger: Trigger, symbol: string): Promise<void> {
    const checkKey = `${trigger.id}-${symbol}`;
    
    // Защита от двойного чека одного и того же триггера в моменте
    if (this.runningChecks.has(checkKey)) return;
    this.runningChecks.add(checkKey);

    try {
      // 1. Получаем историю
      const history = this.marketDataRepo.getHistory(symbol, 100); 
      
      // 2. Считаем математику
      const result = this.taService.calculateChanges(history, trigger.timeIntervalMinutes);
      
      if (!result) return;
      result.symbol = symbol; // Важно: проставляем символ в результат

      // 3. Проверяем условие
      if (this.shouldFire(trigger, result)) {
        await this.notify(trigger, symbol, result);
      }

    } catch (e) {
      this.logger.error(`Check error ${symbol}`, e);
    } finally {
      this.runningChecks.delete(checkKey);
    }
  }

  private shouldFire(trigger: Trigger, result: IAnalysisResult): boolean {
    const actual = result.oiChangePercent;
    const threshold = trigger.oiChangePercent;
    
    if (trigger.direction === 'up') return actual >= threshold;
    if (trigger.direction === 'down') return actual <= -Math.abs(threshold);
    return false;
  }

  private async notify(trigger: Trigger, symbol: string, result: IAnalysisResult): Promise<void> {
    const key = `${trigger.id}-${symbol}`;
    const now = Date.now();
    const last = this.lastNotificationTime.get(key) || 0;
    const cooldown = (trigger.notificationLimitSeconds || 0) * 1000;

    if (cooldown > 0 && now - last < cooldown) return;

    this.lastNotificationTime.set(key, now);
    this.logger.info(`🔥 SIGNAL: ${symbol} OI: ${result.oiChangePercent.toFixed(2)}%`);
    
    // ИСПРАВЛЕНО: передаем только 2 аргумента. Символ уже внутри result.
    await this.notificationService.processTrigger(trigger, result);
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [k, ts] of this.lastNotificationTime.entries()) {
      // Очищаем кулдауны старше 24 часов
      if (now - ts > 24 * 3600 * 1000) this.lastNotificationTime.delete(k);
    }
  }
}