import { DIContainer } from './shared/container';
// Repositories
import { SignalRepository } from './infrastructure/repositories/signal.repository';
import { TriggerRepository } from './infrastructure/repositories/trigger.repository';
import { MarketDataRepository } from './infrastructure/repositories/market-data.repository';

// Services
import { UptimeService } from './infrastructure/services/uptime.service';
import { NotificationService } from './infrastructure/services/notification.service';
import { TriggerEngineService } from './infrastructure/services/trigger-engine.service';
import { TechnicalAnalysisService } from './infrastructure/services/technical-analysis.service';
import { MarketDataGatewayService } from './infrastructure/market-data/market-data-gateway.service';
import { BinanceMarketDataProvider } from './infrastructure/market-data/providers/binance.provider';

// Telegram
import { TelegramBotService } from './infrastructure/telegram/telegram.bot';
import { CommandHandler } from './presentation/telegram/handlers/command.handler';
import { SignalHandler } from './presentation/telegram/handlers/signal.handler';

// Use Cases
import { CreateTriggerUseCase } from './application/use-cases/create-trigger.use-case';
import { GetTriggersUseCase } from './application/use-cases/get-triggers.use-case';
import { RemoveTriggerUseCase } from './application/use-cases/remove-trigger.use-case';
import { PumpScoutBot } from './app';

export function registerDependencies(): void {
  const container = DIContainer.getInstance();

  // --- 1. Repositories (Data Access) ---
  container.bind('ITriggerRepository', () => new TriggerRepository());
  container.bind('ISignalRepository', () => new SignalRepository());
  container.bind('ISymbolMetadataRepository', () => new SymbolMetadataRepository());
  container.bind('IMarketDataRepository', () => new MarketDataRepository());

  // --- 2. Market Data Infrastructure ---
  const gateway = new MarketDataGatewayService(container.get('IMarketDataRepository'));
  // Инициализация провайдера (Binance Futures)
  const binanceProvider = new BinanceMarketDataProvider('futures');
  gateway.registerProvider(binanceProvider);
  
  container.bind('IMarketDataGateway', () => gateway);

  // --- 3. Domain Services (Logic) ---
  container.bind(UptimeService, () => new UptimeService());
  container.bind('ITechnicalAnalysisService', () => new TechnicalAnalysisService());

  // --- 4. Presentation / Notification ---
  container.bind(TelegramBotService, () => new TelegramBotService(process.env.TELEGRAM_BOT_TOKEN || ''));
  container.bind(SignalHandler, () => new SignalHandler(container.get(TelegramBotService), container.get('ISignalRepository')));
  container.bind('INotificationService', () => new NotificationService(container.get(SignalHandler), container.get('ISignalRepository')));

  // --- 5. Engine (Orchestrator) ---
  const engine = new TriggerEngineService(
    container.get('ITriggerRepository'),
    container.get('IMarketDataRepository'),
    container.get('ITechnicalAnalysisService'),
    container.get('INotificationService'),
    container.get(UptimeService)
  );
  container.bind('ITriggerEngineService', () => engine);

  // Обратная связь: Репозиторий должен пинать Движок при обновлении цены
  const repo = container.get('IMarketDataRepository') as MarketDataRepository;
  repo.setTriggerEngine(engine);

  // --- 6. Use Cases ---
  container.bind(CreateTriggerUseCase, () => new CreateTriggerUseCase(container.get('ITriggerRepository')));
  container.bind(GetTriggersUseCase, () => new GetTriggersUseCase(container.get('ITriggerRepository')));
  container.bind(RemoveTriggerUseCase, () => new RemoveTriggerUseCase(container.get('ITriggerRepository')));

  // --- 7. Application Entry ---
  container.bind(CommandHandler, () => new CommandHandler(
    container.get(TelegramBotService),
    container.get(CreateTriggerUseCase),
    container.get(GetTriggersUseCase),
    container.get(RemoveTriggerUseCase),
    container.get(UptimeService),
  ));

  container.bind(PumpScoutBot, () => new PumpScoutBot(
    container.get('IMarketDataGateway'),
    container.get('ITriggerEngineService'),
    container.get(TelegramBotService),
    container.get('ITriggerRepository'),
    container.get(CommandHandler),
  ));
}