import { Inject, Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import {
  IMarketDataGateway,
  IMarketDataRepository,
} from '../../domain/interfaces/services.interface';
import {
  IMarketDataProvider,
} from '../../domain/interfaces/market-data-provider.interface';
import { MarketData } from '../../domain/interfaces/market-data.interface';

@Injectable()
export class MarketDataGatewayService implements IMarketDataGateway {
  private readonly logger = new Logger('MarketDataGateway');
  private providers: IMarketDataProvider[] = [];
  private isConnected = false;

  constructor(
    // ⚠️ ВАЖНО: Мы теперь инжектим Репозиторий, а не Агрегатор
    @Inject('IMarketDataRepository')
    private readonly repository: IMarketDataRepository,
  ) {}

  public registerProvider(provider: IMarketDataProvider): void {
    // Избегаем дубликатов
    if (this.providers.some((p) => p.providerId === provider.providerId)) {
      this.logger.warn(`Provider ${provider.providerId} already registered`);
      return;
    }

    this.providers.push(provider);
    
    // Подписка на поток данных от провайдера
    // Провайдер теперь присылает объект MarketData
    provider.onPriceUpdate((data: MarketData) => {
      this.handleMarketUpdate(data);
    });

    this.logger.info(`Registered provider: ${provider.providerId}`);
  }

  public async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.providers.length === 0) {
      // Это не критическая ошибка, просто варнинг, если запускаем без провайдеров
      this.logger.warn('No providers registered to connect');
      return;
    }

    this.logger.info(`Connecting ${this.providers.length} providers...`);
    
    const results = await Promise.allSettled(
      this.providers.map((provider) => provider.connect())
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    
    // Если хотя бы один подключился - считаем успех
    if (successful > 0) {
      this.isConnected = true;
      this.logger.info(`Gateway connected: ${successful}/${this.providers.length} providers active`);
      this.startHealthMonitoring();
    } else {
      this.logger.error('All providers failed to connect');
      throw new Error('All providers failed to connect');
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    this.logger.info('Disconnecting all providers...');
    await Promise.allSettled(this.providers.map((p) => p.disconnect()));
    
    this.isConnected = false;
    this.stopHealthMonitoring();
    this.logger.info('Gateway disconnected');
  }

  /**
   * Центральный обработчик входящих данных
   */
  private handleMarketUpdate(data: MarketData): void {
    try {
      // ⚠️ ИСПРАВЛЕНИЕ: Вызываем updateMarketData у репозитория
      this.repository.updateMarketData(data);
    } catch (error) {
      this.logger.error(`Error processing update from ${data.providerId}:`, error);
    }
  }

  // --- Health Check ---

  private healthMonitorTimer: NodeJS.Timeout | null = null;

  private startHealthMonitoring(): void {
    // Логируем состояние раз в 5 минут
    this.healthMonitorTimer = setInterval(() => {
        this.providers.forEach(p => {
            const h = p.getHealthStatus();
            this.logger.info(`[Health] ${h.providerId}: msgs=${h.messageCount} err=${h.errorCount} conn=${h.isConnected}`);
        });
    }, 5 * 60 * 1000);
  }

  private stopHealthMonitoring(): void {
    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
    }
  }
}