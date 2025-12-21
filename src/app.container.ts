import { DIContainer } from './shared/container';
// Repositories
import { SignalRepository } from './infrastructure/repositories/signal.repository';
import { TriggerRepository } from './infrastructure/repositories/trigger.repository';
import { MarketDataRepository } from './infrastructure/repositories/market-data.repository';
import { AnalizationResultRepository } from '@infrastructure/repositories/analization-result.repository';
import { TradeRepository } from './infrastructure/repositories/trade.repository';

// Services
import { UptimeService } from './infrastructure/services/uptime.service';
import { NotificationService } from './infrastructure/services/notification.service';
import { TriggerEngineService } from './infrastructure/services/trigger-engine.service';
import { TechnicalAnalysisService } from './infrastructure/services/technical-analysis.service';
import { SignalScannerService } from './infrastructure/services/signal-scanner.service';
import { SignalVerifierService } from './infrastructure/services/signal-verifier.service';
import { MarketDataGatewayService } from './infrastructure/market-data/market-data-gateway.service';
import { BinanceMarketDataProvider } from './infrastructure/market-data/providers/binance.provider';
import { BinanceTradeService } from './infrastructure/services/binance-trade.service';
// Signal Analyzer (isolated module)
import { OrderflowModule, MomentumModule, MeanReversionModule, OIModule, SignalAnalyzerService } from './domain/signal-analyzer';
import { GlobalTrendService } from './domain/signal-analyzer/services/global-trend.service'; // Обновленный путь

// Telegram
import { TelegramBotService } from './infrastructure/telegram/telegram.bot';
import { CommandHandler } from './presentation/telegram/handlers/command.handler';
import { SignalHandler } from './presentation/telegram/handlers/signal.handler';

// Use Cases
import { CreateTriggerUseCase } from './application/use-cases/create-trigger.use-case';
import { GetTriggersUseCase } from './application/use-cases/get-triggers.use-case';
import { RemoveTriggerUseCase } from './application/use-cases/remove-trigger.use-case';

import { TradeGatekeeper } from './domain/signal-analyzer/gatekeeper/trade-gatekeeper';
import { TrendAlignmentGate } from './domain/signal-analyzer/gatekeeper/gates/trend-alignment.gate';
import { AntiSpamGate } from './domain/signal-analyzer/gatekeeper/gates/anti-spam.gate';
import { MeanReversionGate } from './domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate';
import { TradingSessionGate } from './domain/signal-analyzer/gatekeeper/gates/trading-session.gate';
import { PumpScoutBot } from './app';

export function registerDependencies(): void {
  const container = DIContainer.getInstance();

  // --- 1. Repositories (Data Access) ---
  container.bind('ITriggerRepository', () => new TriggerRepository());
  container.bind('ISignalRepository', () => new SignalRepository());
  container.bind('IMarketDataRepository', () => new MarketDataRepository());
  container.bind('IAnalizationResultRepository', () => new AnalizationResultRepository());
  container.bind('ITradeRepository', () => new TradeRepository());

  // --- 2. Market Data Infrastructure ---
  const gateway = new MarketDataGatewayService(container.get('IMarketDataRepository'));
  // Инициализация провайдера (Binance Futures)
  const binanceProvider = new BinanceMarketDataProvider('futures');
  gateway.registerProvider(binanceProvider);

  container.bind('IMarketDataGateway', () => gateway);

  // --- 3. Domain Services (Logic) ---
  container.bind(UptimeService, () => new UptimeService());
  container.bind('ITechnicalAnalysisService', () => new TechnicalAnalysisService());
  container.bind('ITradeService', () => new BinanceTradeService(
    container.get('ITradeRepository'),
    container.get('IMarketDataRepository'),
  ));

  // --- 4. Presentation / Notification ---
  container.bind(TelegramBotService, () => new TelegramBotService(process.env.TELEGRAM_BOT_TOKEN || ''));
  container.bind(SignalHandler, () => new SignalHandler(container.get(TelegramBotService), container.get('ISignalRepository')));
  container.bind('INotificationService', () => new NotificationService(
    container.get(SignalHandler),
    container.get('ISignalRepository'),
  ));

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

  // --- 6.5. Signal Analyzer (isolated module) ---

  // 1. Регистрируем массив гейтов
  container.bind('IGates', () => [
    new TrendAlignmentGate(),
    new MeanReversionGate(),
    new TradingSessionGate(),
    new AntiSpamGate()
  ]);

  // 2. Регистрируем сам Gatekeeper
  container.bind('TradeGatekeeper', () => new TradeGatekeeper(
    container.get('IGates')
  ));

  container.bind('IModules', () => [
    // new OIModule(),
    new MeanReversionModule(),
    new OrderflowModule(),
    new MomentumModule(),
  ]);
  container.bind(GlobalTrendService, () => new GlobalTrendService(
    container.get('IMarketDataRepository') // Ему нужен доступ к данным
  ));

  // --- 7. Application Entry ---
  container.bind(CommandHandler, () => new CommandHandler(
    container.get(TelegramBotService),
    container.get(CreateTriggerUseCase),
    container.get(GetTriggersUseCase),
    container.get(RemoveTriggerUseCase),
    container.get(UptimeService),
    container.get(SignalAnalyzerService),
    container.get('IMarketDataRepository'),
  ));

  // --- 7.5. Signal Scanner (auto signal detection) ---
  container.bind(SignalScannerService, () => new SignalScannerService(
    container.get(SignalAnalyzerService),
    container.get(TelegramBotService),
    container.get('IAnalizationResultRepository'),
    container.get('IMarketDataRepository'), // <--- UPDATED: Pass memory repository
    container.get(GlobalTrendService)
  ));

  container.bind(SignalVerifierService, () => new SignalVerifierService(
    container.get('IAnalizationResultRepository'),
    container.get('IMarketDataRepository')
  ))

  container.bind(SignalAnalyzerService, () => new SignalAnalyzerService(
    container.get('IModules'),
    container.get('TradeGatekeeper')
  ));

  container.bind(GlobalTrendService, () => new GlobalTrendService(
    container.get('IMarketDataRepository')
  ));

  container.bind(PumpScoutBot, () => new PumpScoutBot(
    container.get('IMarketDataGateway'),
    container.get('ITriggerEngineService'),
    container.get(TelegramBotService),
    container.get('ITriggerRepository'),
    container.get(CommandHandler),
    container.get(SignalScannerService),
    container.get(SignalVerifierService),
    container.get('IMarketDataRepository'), // <--- UPDATED: Pass memory repository to Bot for warmup
  ));
}