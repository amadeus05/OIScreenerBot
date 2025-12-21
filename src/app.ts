import { Inject, Injectable } from './shared/decorators';
import { Logger } from './shared/logger';
import { IMarketDataGateway, ITriggerEngineService, IMarketDataRepository } from './domain/interfaces/services.interface';
import { TelegramBotService } from './infrastructure/telegram/telegram.bot';
import { ITriggerRepository } from './domain/interfaces/repositories.interface';
import { CommandHandler } from './presentation/telegram/handlers/command.handler';
import { SignalScannerService } from './infrastructure/services/signal-scanner.service';
import { SignalVerifierService } from './infrastructure/services/signal-verifier.service';
import { getSupabaseDataProvider } from './domain/signal-analyzer/adapters/supabase.provider';
import { getCockroachDBDataProvider } from './domain/signal-analyzer/adapters/cockoroach.provider';
import { MarketDataRepository } from './infrastructure/repositories/market-data.repository';
import type { BarData } from './domain/signal-analyzer/types';

type HistoryProvider = {
  isConfigured(): boolean;
  getAvailableSymbols(): Promise<string[]>;
  getHistoryForMany(symbols: string[], limitPerSymbol: number): Promise<Map<string, BarData[]>>;
};

type HistoryProviderChoice = {
  name: 'CockroachDB' | 'Supabase';
  provider: HistoryProvider;
};

@Injectable()
export class PumpScoutBot {
  private readonly logger = new Logger(PumpScoutBot.name);

  constructor(
    @Inject('IMarketDataGateway') private readonly marketDataGateway: IMarketDataGateway,
    @Inject('ITriggerEngineService') private readonly triggerEngine: ITriggerEngineService,
    private readonly telegramBotService: TelegramBotService,
    @Inject('ITriggerRepository') private readonly triggerRepository: ITriggerRepository,
    private readonly commandHandler: CommandHandler,
    private readonly signalScanner: SignalScannerService,
    private readonly signalVerifier: SignalVerifierService,
    @Inject('IMarketDataRepository') private readonly marketDataRepository: IMarketDataRepository // <--- INJECTED
  ) { }

  public async start(): Promise<void> {
    this.logger.info('🚀 Starting Pump Scout Bot...');
    try {
      await this.triggerRepository.init();
      this.logger.info(`Trigger repository initialized.`);

      // 1. CONNECT WEBSOCKET (Start buffering live data)
      await this.marketDataGateway.connect();
      this.logger.info('✅ WebSocket Connected. Buffering live data...');

      // 2. OPTIONAL HISTORY WARMUP
      const warmupEnabled =
        (process.env.ENABLE_HISTORY_WARMUP ?? process.env.ENABLE_SUPABASE_HISTORY) === 'true';

      if (warmupEnabled) {
        const historySource = this.getHistoryProvider();

        if (!historySource) {
          this.logger.warn('♨️ Warmup включен, но провайдер CockroachDB/Supabase не сконфигурирован.');
        } else {
          const { name, provider } = historySource;
          this.logger.info(`📡 Исторический прогрев включен. Источник: ${name}.`);

          const allSymbols = await provider.getAvailableSymbols();
          this.logger.info(`📋 Найдено ${allSymbols.length} уникальных символов в ${name} для прогрева.`);

          if (allSymbols.length > 0) {
            await this.warmupBigData(historySource, allSymbols);
          } else {
            this.logger.warn(`⚠️ В ${name} не найдено символов для прогрева.`);
          }
        }
      } else {
        this.logger.info('⏩ История отключена. Стартуем в "Cold Mode".');
        this.logger.info('⏳ Бот накопит лайв-данные и перейдет к анализу автоматически.');
      }

      // 3. START ENGINES
      this.triggerEngine.start();
      this.commandHandler.initialize();
      this.signalScanner.start();
      this.signalVerifier.start();

      this.logger.info('🤖 Pump Scout Bot started successfully!');
    } catch (error) {
      this.logger.error('Failed to initialize Pump Scout Bot:', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Pump Scout Bot...');
    this.signalScanner.stop();
    this.triggerEngine.stop();
    await this.marketDataGateway.disconnect();
    await this.telegramBotService.stop();
    this.logger.info('Pump Scout Bot stopped gracefully.');
  }

  private getHistoryProvider(): HistoryProviderChoice | null {
    const cockroach = getCockroachDBDataProvider();
    if (cockroach.isConfigured()) {
      return { name: 'CockroachDB', provider: cockroach };
    }

    const supabase = getSupabaseDataProvider();
    if (supabase.isConfigured()) {
      return { name: 'Supabase', provider: supabase };
    }

    return null;
  }

  private async warmupBigData(source: HistoryProviderChoice, symbols: string[]): Promise<void> {
    const { name, provider } = source;

    if (!provider.isConfigured()) {
      this.logger.warn(`${name} provider not configured, skipping warmup.`);
      return;
    }

    const BATCH_SIZE = 20;
    const TOTAL = symbols.length;

    this.logger.info(`🔥 Warming up history from ${name} for ${TOTAL} symbols (batch ${BATCH_SIZE})...`);

    for (let i = 0; i < TOTAL; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);

      try {
        const historyMap = await provider.getHistoryForMany(batch, 500);

        for (const [symbol, bars] of historyMap.entries()) {
          if (bars.length > 0) {
            const smartCandles = this.convertBarsToSmart(bars);
            (this.marketDataRepository as MarketDataRepository).injectHistory(symbol, smartCandles);
          }
        }

        this.logger.info(`✅ Loaded batch ${Math.ceil((i + 1) / BATCH_SIZE)}/${Math.ceil(TOTAL / BATCH_SIZE)} from ${name}`);
        await new Promise(r => setTimeout(r, 100)); // Rate limit protection
      } catch (e) {
        this.logger.error(`❌ Error warming up batch starting at ${i} from ${name}`, e);
      }
    }

    this.logger.info(`🔥 Warmup Complete from ${name}!`);
  }

  private convertBarsToSmart(bars: BarData[]): any[] {
    return bars.map(b => ({
      ts: b.ts,
      ohlc: { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v },
      futures: { oi: b.oi, funding: b.funding },
      orderFlow: {
        cvd: b.cvd,
        delta: b.delta,
        liquidations: b.liquidations || { long: 0, short: 0, countLong: 0, countShort: 0, maxLong: 0, maxShort: 0 }
      }
    }));
  }
}