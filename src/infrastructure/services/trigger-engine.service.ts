import { Inject, Injectable } from '../../shared/decorators';
import {
  IDataAggregatorService,
  ITriggerEngineService,
  INotificationService,
} from '../../domain/interfaces/services.interface';
import { ITriggerRepository } from '../../domain/interfaces/repositories.interface';
import { Trigger } from '../../domain/entities/trigger.entity';
import { Logger } from '../../shared/logger';
import { UptimeService } from './uptime.service';
import { OIVelocityFilter } from '../../modules/decision-system/filters/oi-velocity.filter';

const BATCH_PROCESSING_SIZE = Number(process.env.BATCH_PROCESSING_SIZE) || 10;
const PENDING_FLUSH_MS = Number(process.env.TRIGGER_ENGINE_FLUSH_MS) || 50; // flush pending symbols every 50ms (быстрее!)
const METRIC_CACHE_TTL_MS = Number(process.env.TRIGGER_ENGINE_METRIC_CACHE_TTL_MS) || 500; // short local cache
const DEFAULT_MIN_CHECK_INTERVAL_MS = Number(process.env.MIN_CHECK_INTERVAL_MS) || 100; // проверка каждые 100ms (быстрее!)

@Injectable()
export class TriggerEngineService implements ITriggerEngineService {
  private readonly logger = new Logger(TriggerEngineService.name);
  private isRunning = false;

  private pendingSymbols = new Map<string, { price: number; timestamp: number }>();

  private lastCheckTime = new Map<string, number>(); // last attempt time for check (per trigger+symbol)
  private runningChecks = new Set<string>(); // currently running checks keys

  private metricCache = new Map<string, { ts: number; metrics: any }>();

  private pendingTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  private readonly MIN_CHECK_INTERVAL_MS = DEFAULT_MIN_CHECK_INTERVAL_MS;

  private readonly velocityFilter: OIVelocityFilter;

  constructor(
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    @Inject('IDataAggregatorService') private readonly dataAggregator: IDataAggregatorService,
    @Inject('INotificationService') private readonly notificationService: INotificationService,
    private readonly uptimeService: UptimeService,
  ) {
    this.velocityFilter = new OIVelocityFilter();
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.healthTimer = setInterval(() => this.logHealth(), 5 * 60 * 1000);
    this.cleanupTimer = setInterval(() => this.cleanupFireCounters(), 10 * 60 * 1000);

    this.logger.info('TriggerEngineService started');
  }

  public stop(): void {
    this.isRunning = false;

    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.pendingSymbols.clear();
    this.lastCheckTime.clear();
    this.runningChecks.clear();
    this.metricCache.clear();

    this.logger.info('TriggerEngineService stopped');
  }

  public async onPriceUpdate(symbol: string, price: number): Promise<void> {
    if (!this.isRunning || !symbol) return;

    this.pendingSymbols.set(symbol, { price, timestamp: Date.now() });

    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flushPendingSymbols(), PENDING_FLUSH_MS);
    }
  }

  private async flushPendingSymbols(): Promise<void> {
    if (!this.isRunning) return;

    const work = Array.from(this.pendingSymbols.entries()).slice(0, BATCH_PROCESSING_SIZE);
    for (const [symbol] of work) this.pendingSymbols.delete(symbol);

    if (this.pendingSymbols.size === 0 && this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    } else if (this.pendingSymbols.size > 0) {
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.flushPendingSymbols(), PENDING_FLUSH_MS);
    }

    if (work.length === 0) return;

    const activeTriggers = this.triggerRepository.getAllActive();
    if (!activeTriggers || activeTriggers.length === 0) return;

    const triggersBySymbol = this.groupAndSortTriggers(activeTriggers);

    for (const [symbol, { price: currentPrice }] of work) {
      try {
        // @ts-ignore
        if (typeof (this.dataAggregator as any).isWarm === 'function') {
          // @ts-ignore
          if (!(this.dataAggregator as any).isWarm(symbol)) continue;
        }

        const symbolTriggers = triggersBySymbol.get(symbol) || [];
        const globalTriggers = triggersBySymbol.get('*') || [];
        const combined = [...symbolTriggers, ...globalTriggers];

        for (const trigger of combined) {
          try {
            await this.checkTriggerWithRateLimit(trigger, symbol, currentPrice);
          } catch (err) {
            this.logger.error(`checkTriggerWithRateLimit error for ${symbol} / trigger ${trigger.id}:`, err);
          }
        }
      } catch (err) {
        this.logger.error(`Error processing symbol ${symbol}:`, err);
      }
    }
  }

  private groupAndSortTriggers(triggers: Trigger[]): Map<string, Trigger[]> {
    const result = new Map<string, Trigger[]>();

    const key = '*';
    const arr: Trigger[] = [];
    for (const t of triggers) arr.push(t);

    arr.sort((a, b) => (b.oiChangePercent ?? 0) - (a.oiChangePercent ?? 0));
    result.set(key, arr);

    return result;
  }

  private async checkTriggerWithRateLimit(trigger: Trigger, symbol: string, currentPrice: number): Promise<void> {
    const checkKey = `${trigger.id}-${symbol}`;
    const now = Date.now();

    const last = this.lastCheckTime.get(checkKey) || 0;
    if (now - last < this.MIN_CHECK_INTERVAL_MS) return;

    if (this.runningChecks.has(checkKey)) return;

    this.runningChecks.add(checkKey);
    try {
      await this.checkTrigger(trigger, symbol, currentPrice);
    } finally {
      this.runningChecks.delete(checkKey);
      this.lastCheckTime.set(checkKey, Date.now());
    }
  }

  private async checkTrigger(trigger: Trigger, symbol: string, currentPrice: number): Promise<void> {
    const checkKey = `${trigger.id}-${symbol}`;
    
    try {
      const now = Date.now();
      const mainWindowStart = now - trigger.timeIntervalMinutes * 60000;
      
      const alignedWindowEnd = this.alignToBucketBoundary(now);
      const alignedWindowStart = this.alignToBucketBoundary(mainWindowStart);
      
      const mainMetrics = await this.dataAggregator.getMetricChangesForWindow(
        symbol, alignedWindowStart, alignedWindowEnd
      );
      
      const subWindowResults = await this.checkSubWindows(
        trigger, symbol, currentPrice, alignedWindowStart, alignedWindowEnd
      );
      
      if (mainMetrics && this.shouldTriggerFire(trigger, mainMetrics, symbol)) {
        this.fireTrigger(trigger, symbol, mainMetrics, "main-window");
      }
      
      for (const result of subWindowResults) {
        if (result.shouldFire) {
          this.fireTrigger(trigger, symbol, result.metrics, `sub-window-${result.windowType}`);
        }
      }
      
    } catch (err) {
      this.logger.error(`Error checking trigger ${trigger.id} for ${symbol}:`, err);
    }
  }

  private async checkSubWindows(
    trigger: Trigger, 
    symbol: string, 
    currentPrice: number,
    windowStart: number,
    windowEnd: number
  ): Promise<Array<{shouldFire: boolean, metrics: any, windowType: string}>> {
    const results = [];
    
    const alignedWindowEnd = this.alignToBucketBoundary(windowEnd);
    const alignedWindowStart = this.alignToBucketBoundary(windowStart);
    
    const subWindowDurations = [5, 10, 15];
    
    for (const duration of subWindowDurations) {
      if (duration >= trigger.timeIntervalMinutes) continue;
      
      const subWindowEnd = alignedWindowEnd;
      const subWindowStart = this.alignToBucketBoundary(alignedWindowEnd - duration * 60000);
      
      if (subWindowStart >= alignedWindowStart) {
        const metrics = await this.dataAggregator.getMetricChangesForWindow(
          symbol, subWindowStart, subWindowEnd
        );
        
        if (metrics) {
          const shouldFire = this.shouldTriggerFire(trigger, metrics, symbol);
          results.push({
            shouldFire,
            metrics,
            windowType: `${duration}m`,
            windowStart: subWindowStart,
            windowEnd: subWindowEnd
          });
        }
      }
    }
    
    return results;
  }

  private fireTrigger(trigger: Trigger, symbol: string, metrics: any, windowType: string): void {
    this.logger.info(` Trigger ${trigger.id} fired for ${symbol} (${windowType}, OI: ${metrics.oiChangePercent.toFixed(2)}%)`);
    
    try {
      metrics.windowType = windowType;
      metrics.windowDuration = windowType.includes('m') ? 
        parseInt(windowType.replace('m', '')) : trigger.timeIntervalMinutes;
      
      void this.notificationService.processTrigger(trigger, symbol, metrics);
    } catch (err) {
      this.logger.error(`notificationService failed for trigger=${trigger.id} symbol=${symbol}:`, err);
    }
  }

  private shouldTriggerFire(trigger: Trigger, metrics: any, symbol: string): boolean {
    const actual = metrics?.oiChangePercent;
    if (!Number.isFinite(actual)) return false;

    const threshold = Number(trigger.oiChangePercent) || 0;
    const basicPass = trigger.direction === 'up'
      ? actual >= threshold
      : actual <= -Math.abs(threshold);

    if (!basicPass) return false;

    const accessor = this.dataAggregator.createAccessor();
    const velocityResult = this.velocityFilter.evaluate(
      symbol,
      accessor,
      {
        percent: trigger.oiChangePercent,
        oiIntervalMin: trigger.timeIntervalMinutes,
      }
    );
    console.log(`[VelocityFilter ${symbol}]: ${JSON.stringify(velocityResult)} | trigger ${trigger.id}`);
    if (!velocityResult.pass) {
      console.log(`[VelocityFilter] BLOCKED: ${velocityResult.reason} | trigger ${trigger.id}`);
      if (this.isDebug()) {
        this.logger.debug(`[VelocityFilter] BLOCKED: ${velocityResult.reason} | trigger ${trigger.id}`);
      }
      return false;
    }

    if (velocityResult.tags?.includes('ACCELERATING')) {
      metrics.velocity = velocityResult.velocity;
      metrics.acceleration = velocityResult.acceleration;
      metrics.velocityTags = velocityResult.tags;
    }

    return true;
  }

  private logHealth(): void {
    try {
      const activeTriggers = this.triggerRepository.getAllActive();
      // @ts-ignore
      const symbols = typeof (this.dataAggregator as any).getAllKnownSymbols === 'function'
        ? (this.dataAggregator as any).getAllKnownSymbols()
        : [];

      const uptime = this.uptimeService.getUptime?.() || 0;
      if (this.isDebug()) {
        this.logger.debug(`Health: triggers=${activeTriggers?.length || 0} symbols=${symbols?.length || 0} uptime=${uptime}`);
      } else {
        this.logger.info(`Health: triggers=${activeTriggers?.length || 0} symbols=${symbols?.length || 0}`);
      }
    } catch (err) {
      this.logger.debug('Health check failed', err);
    }
  }

  private cleanupFireCounters(): void {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000;

    for (const [k, ts] of Array.from(this.lastCheckTime.entries())) {
      if (now - ts > staleThreshold) {
        this.lastCheckTime.delete(k);
      }
    }

    if (this.isDebug()) this.logger.debug(`🧹 Cleanup done: checks=${this.lastCheckTime.size}`);
  }

  private isDebug(): boolean {
    return Boolean(process.env.DEBUG_TRIGGER_ENGINE);
  }

  private alignToBucketBoundary(timestamp: number, bucketSizeMs: number = 60000): number {
    return Math.floor(timestamp / bucketSizeMs) * bucketSizeMs;
  }
}

