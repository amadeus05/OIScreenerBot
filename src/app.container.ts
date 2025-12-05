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
import { AnalyzeCoinUseCase } from './application/use-cases/analyze-coin.use-case';
import { PumpScoutBot } from './app';

// Coin Analyzer Module
import { CoinAnalyzerCoordinator } from './domain/coin-analyzer/coin-analyzer.coordinator';
import { MultiTimeframeService } from './domain/coin-analyzer/services/multi-timeframe.service';
import { DirectionResolver } from './domain/coin-analyzer/services/direction-resolver.service';
import { EntryTimingResolver } from './domain/coin-analyzer/services/entry-timing.service';
import { StopLossCalculator } from './domain/coin-analyzer/services/stop-loss.service';
import { ConfidenceScorer } from './domain/coin-analyzer/services/confidence-scorer.service';
import {
  MarketRegimeFilter,
  BTCCorrelationFilter,
  FundingExtremeFilter,
  TrendAlignmentFilter,
} from './domain/coin-analyzer/filters';
import {
  OIDivergenceStrategy,
  LiquidationCascadeStrategy,
} from './domain/coin-analyzer/strategies';

export function registerDependencies(): void {
  const container = DIContainer.getInstance();

  // --- 1. Repositories (Data Access) ---
  container.bind('ITriggerRepository', () => new TriggerRepository());
  container.bind('ISignalRepository', () => new SignalRepository());
  container.bind('IMarketDataRepository', () => new MarketDataRepository());

  // --- 2. Market Data Infrastructure ---
  const gateway = new MarketDataGatewayService(container.get('IMarketDataRepository'));
  const binanceProvider = new BinanceMarketDataProvider('futures');
  gateway.registerProvider(binanceProvider);

  container.bind('IMarketDataGateway', () => gateway);

  // --- 3. Domain Services (Logic) ---
  container.bind(UptimeService, () => new UptimeService());
  container.bind('ITechnicalAnalysisService', () => new TechnicalAnalysisService());

  // --- 4. Coin Analyzer Module ---
  // Core services
  container.bind('IMultiTimeframeService', () => new MultiTimeframeService(
    container.get('IMarketDataRepository')
  ));
  container.bind('IDirectionResolver', () => new DirectionResolver());
  container.bind('IEntryTimingResolver', () => new EntryTimingResolver());
  container.bind('IStopLossCalculator', () => new StopLossCalculator());
  container.bind('IConfidenceScorer', () => new ConfidenceScorer());

  // Create coordinator and register filters/strategies
  const coinAnalyzer = new CoinAnalyzerCoordinator(
    container.get('IMarketDataRepository'),
    container.get('IMultiTimeframeService'),
    container.get('IDirectionResolver'),
    container.get('IEntryTimingResolver'),
    container.get('IStopLossCalculator'),
    container.get('IConfidenceScorer'),
  );

  // Register filters
  coinAnalyzer.registerFilter(new MarketRegimeFilter());
  coinAnalyzer.registerFilter(new BTCCorrelationFilter());
  coinAnalyzer.registerFilter(new FundingExtremeFilter());
  coinAnalyzer.registerFilter(new TrendAlignmentFilter());

  // Register strategies
  coinAnalyzer.registerStrategy(new OIDivergenceStrategy());
  coinAnalyzer.registerStrategy(new LiquidationCascadeStrategy());

  container.bind('ICoinAnalyzer', () => coinAnalyzer);

  // Analyze use case
  container.bind('AnalyzeCoinUseCase', () => new AnalyzeCoinUseCase(
    container.get('ICoinAnalyzer'),
    container.get('IMarketDataRepository'),
  ));

  // --- 5. Presentation / Notification ---
  container.bind(TelegramBotService, () => new TelegramBotService(process.env.TELEGRAM_BOT_TOKEN || ''));
  container.bind(SignalHandler, () => new SignalHandler(container.get(TelegramBotService), container.get('ISignalRepository')));
  container.bind('INotificationService', () => new NotificationService(container.get(SignalHandler), container.get('ISignalRepository')));

  // --- 6. Engine (Orchestrator) ---
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

  // --- 7. Use Cases ---
  container.bind(CreateTriggerUseCase, () => new CreateTriggerUseCase(container.get('ITriggerRepository')));
  container.bind(GetTriggersUseCase, () => new GetTriggersUseCase(container.get('ITriggerRepository')));
  container.bind(RemoveTriggerUseCase, () => new RemoveTriggerUseCase(container.get('ITriggerRepository')));

  // --- 8. Application Entry ---
  container.bind(CommandHandler, () => new CommandHandler(
    container.get(TelegramBotService),
    container.get(CreateTriggerUseCase),
    container.get(GetTriggersUseCase),
    container.get(RemoveTriggerUseCase),
    container.get(UptimeService),
    container.get('AnalyzeCoinUseCase'),
  ));

  container.bind(PumpScoutBot, () => new PumpScoutBot(
    container.get('IMarketDataGateway'),
    container.get('ITriggerEngineService'),
    container.get(TelegramBotService),
    container.get('ITriggerRepository'),
    container.get(CommandHandler),
  ));
}