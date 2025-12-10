import { Inject, Injectable } from './shared/decorators';
import { Logger } from './shared/logger';
import { IMarketDataGateway, ITriggerEngineService, IMarketDataRepository } from './domain/interfaces/services.interface';
import { TelegramBotService } from './infrastructure/telegram/telegram.bot';
import { ITriggerRepository } from './domain/interfaces/repositories.interface';
import { CommandHandler } from './presentation/telegram/handlers/command.handler';
import { SignalScannerService } from './infrastructure/services/signal-scanner.service';
import { SignalVerifierService } from './infrastructure/services/signal-verifier.service';
import { getSupabaseDataProvider } from './domain/signal-analyzer/adapters/supabase.provider';
import { MarketDataRepository } from './infrastructure/repositories/market-data.repository';

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
      const useHistory = process.env.ENABLE_SUPABASE_HISTORY === 'true';

      if (useHistory) {
        this.logger.info('📡 Supabase History is ENABLED. Starting warmup...');
        
        // === ИСПРАВЛЕНИЕ НАЧАЛО ===
        // Создаем провайдер, чтобы получить список монет ИЗ БАЗЫ, а не из памяти
        const supabaseProvider = getSupabaseDataProvider();
        
        // Запрашиваем уникальные символы из таблицы candles
        const allSymbols = await supabaseProvider.getAvailableSymbols();
        
        this.logger.info(`📋 Found ${allSymbols.length} unique symbols in DB to warm up.`);
        
        // Теперь мы прогреем даже те монеты, которые сейчас молчат на бирже
        if (allSymbols.length > 0) {
            await this.warmupBigData(allSymbols);
        } else {
            this.logger.warn('⚠️ No symbols found in Supabase.');
        }
        // === ИСПРАВЛЕНИЕ КОНЕЦ ===
    
      } else {
          this.logger.info('⏩ Supabase History is DISABLED. Starting in "Cold Mode".');
          this.logger.info('⏳ Bot will accumulate live data and start analyzing automatically when enough data is collected.');
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

  private async warmupBigData(symbols: string[]): Promise<void> {
      const supabase = getSupabaseDataProvider();
      if (!supabase.isConfigured()) {
          this.logger.warn('Supabase not configured, skipping warmup.');
          return;
      }

      const BATCH_SIZE = 20; // 50 symbols per request
      const TOTAL = symbols.length;
      
      this.logger.info(`🔥 Warming up history for ${TOTAL} symbols in batches of ${BATCH_SIZE}...`);

      for (let i = 0; i < TOTAL; i += BATCH_SIZE) {
          const batch = symbols.slice(i, i + BATCH_SIZE);
          
          try {
              // 1. Bulk Fetch (1 Request)
              const historyMap = await supabase.getHistoryForMany(batch, 500);
              
              // 2. Inject into Repo
              for (const [symbol, bars] of historyMap.entries()) {
                  if (bars.length > 0) {
                      const smartCandles = this.convertBarsToSmart(bars);
                      // Cast to concrete implementation to access injectHistory
                      (this.marketDataRepository as MarketDataRepository).injectHistory(symbol, smartCandles);
                  }
              }
              
              this.logger.info(`✅ Loaded batch ${Math.ceil((i + 1)/BATCH_SIZE)}/${Math.ceil(TOTAL/BATCH_SIZE)}`);
              await new Promise(r => setTimeout(r, 100)); // Rate limit protection
          } catch (e) {
              this.logger.error(`❌ Error warming up batch starting at ${i}`, e);
          }
      }
      this.logger.info('🔥 Warmup Complete!');
  }

  private convertBarsToSmart(bars: any[]): any[] {
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