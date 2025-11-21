import TelegramBot from 'node-telegram-bot-api';
import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalDto } from '../../application/dto/signal.dto';

@Injectable()
export class TelegramBotService {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramBotService.name);

  // Rate limiting for Telegram API (30 messages per second)
  private readonly messageQueue = new Map<number, Array<{ message: string; timestamp: number }>>();
  private readonly MAX_MESSAGES_PER_SECOND = 25;
  private readonly RATE_LIMIT_WINDOW_MS = 1000;

  // Detect market type from ENV for proper link generation
  private readonly marketType: string;

  constructor(token: string) {
    if (!token) {
      throw new Error('Telegram Bot Token is not provided!');
    }
    this.bot = new TelegramBot(token, { polling: true });
    this.setupErrorHandling();
    this.setupBotCommands();

    // Detect primary market type from configuration
    this.marketType = this.detectMarketType();
    this.logger.info(`Telegram links configured for: ${this.marketType}`);

    // Cleanup old queue entries every minute
    setInterval(() => this.cleanupQueues(), 60_000);
  }

  public getBot(): TelegramBot {
    return this.bot;
  }

  public async sendMessage(chatId: number, message: string): Promise<void> {
    try {
      // Check rate limit
      if (!(await this.checkRateLimit(chatId))) {
        this.logger.warn(`Rate limit exceeded for chat ${chatId}, message queued`);
        await this.delay(1000);
      }

      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });

      // Track message
      this.trackMessage(chatId);
    } catch (error) {
      this.logger.error(`Failed to send Telegram message to chat ${chatId}:`, error);
    }
  }

  public async sendSignal(
    chatId: number,
    signal: SignalDto,
    triggerIntervalMinutes?: number,
  ): Promise<void> {
    const message = this.formatSignalMessage(signal, triggerIntervalMinutes);
    await this.sendMessage(chatId, message);
  }

  private formatSignalMessage(signal: SignalDto, triggerIntervalMinutes?: number): string {
    const formatVolume = (v?: number): string => {
      if (!v || !Number.isFinite(v)) return '—';
      // Более красивое форматирование: округляем до 2 знаков
      if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
      if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
      return v.toFixed(2);
    };
    const formatQuoteVolume = (v?: number): string => {
      if (!v || !Number.isFinite(v)) return '—';
      const abs = Math.abs(v);
      if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(2)}B`;
      if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
      if (abs >= 1_000) return `$${(abs / 1_000).toFixed(2)}K`;
      return `$${abs.toFixed(2)}`;
    };

    const timeStr = (signal.timestamp ?? new Date()).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const intervalDisplay = triggerIntervalMinutes ? `${triggerIntervalMinutes}m` : '';
    const binanceLink = this.generateBinanceLink(signal.symbol);
    const tradingViewLink = this.generateTradingViewLink(signal.symbol);

    // OI форматирование
    const oiValue = signal.oiChangePercent ?? 0;
    const oiSign = oiValue >= 0 ? '+' : '';
    const oiEmoji = oiValue > 0 ? '🟢' : oiValue < 0 ? '🔴' : '⚪';
    const oiArrow = oiValue > 0 ? '↗️' : oiValue < 0 ? '↘️' : '→';

    // Price форматирование
    const priceValue = signal.priceChangePercent ?? 0;
    const priceSign = priceValue >= 0 ? '+' : '';
    const priceStr = this.formatPrice(signal.currentPrice ?? 0);

    // Дивергенция (разница между OI и ценой)
    const divergence = oiValue - priceValue;
    const divSign = divergence >= 0 ? '+' : '';
    const divEmoji = divergence > 0 ? '🔺' : divergence < 0 ? '🔻' : '⚪';
    const divLabel = divergence > 0 ? 'быки' : divergence < 0 ? 'медведи' : 'нейтрал';

    // Volume
    const totalVolText = formatVolume(signal.totalVolume);
    const totalQuoteVolText = formatQuoteVolume(signal.totalQuoteVolume);
    const deltaQuoteValue = signal.deltaQuoteVolume ?? 0;
    const deltaQuoteText = formatQuoteVolume(Math.abs(deltaQuoteValue));
    const deltaQuoteSign = deltaQuoteValue >= 0 ? '' : '-';
    const deltaVolValue = signal.deltaVolume ?? 0;
    const deltaVolText = formatVolume(Math.abs(deltaVolValue));
    const deltaVolEmoji = deltaVolValue < 0 ? '🔴' : deltaVolValue > 0 ? '🟢' : '⚪';
    const deltaVolSign = deltaVolValue >= 0 ? '' : '-';
    const deltaVolLabel = deltaVolValue < 0 ? 'продажи' : deltaVolValue > 0 ? 'покупки' : 'нейтрал';
    const volumeRatioValue = signal.volumeRatioQuote ?? signal.volumeRatio ?? null;
    const volumeRatioText = volumeRatioValue !== null ? `${volumeRatioValue.toFixed(2)}x` : '—';
    const volumeRatioEmoji = volumeRatioValue === null ? '⚪' : volumeRatioValue > 1 ? '🚀' : volumeRatioValue < 1 ? '📉' : '⚪';
    const baselineVolumeText = formatQuoteVolume(signal.volumeBaselineQuote ?? signal.volumeBaseline);

    return `
🔔 <b>${signal.symbol}</b> · ${intervalDisplay}  
💰 $${priceStr} (${priceSign}${priceValue.toFixed(2)}%) · ⏰ ${timeStr}

━━━━━━━━━━━━━━━━
${oiEmoji} Open Interest: <b>${oiSign}${oiValue.toFixed(2)}%</b> ${oiArrow}
${divEmoji} Дивергенция: <b>${divSign}${Math.abs(divergence).toFixed(1)}%</b> (${divLabel})

📊 Volume: ${totalVolText} (${totalQuoteVolText})
   ├ Ratio: ${volumeRatioEmoji} ${volumeRatioText} vs prev ${baselineVolumeText}
   └ Delta: ${deltaVolEmoji} ${deltaVolSign}${deltaVolText} / ${deltaQuoteSign}${deltaQuoteText} (${deltaVolLabel})

<a href="${binanceLink}">📊 Binance</a> • <a href="${tradingViewLink}">📈 Chart</a>
    `.trim();
  }

  /**
   * Smart price formatting based on value magnitude
   */
  private formatPrice(price: number): string {
    if (!Number.isFinite(price)) return '—';
    if (price >= 1000) {
      return price.toFixed(2);
    } else if (price >= 1) {
      return price.toFixed(4);
    } else if (price >= 0.01) {
      return price.toFixed(4);
    } else {
      return price.toFixed(6);
    }
  }

  /**
   * Generate Binance link based on market type
   */
  private generateBinanceLink(symbol: string): string {
    if (this.marketType === 'futures') {
      return `https://www.binance.com/ru/futures/${symbol}`;
    }
    return `https://www.binance.com/ru/trade/${symbol}`;
  }

  /**
   * Generate TradingView link based on market type
   */
  private generateTradingViewLink(symbol: string): string {
    if (this.marketType === 'futures') {
      // Perpetual futures suffix
      return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}.P`;
    }
    return `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}`;
  }

  /**
   * Detect primary market type from environment configuration
   */
  private detectMarketType(): string {
    // Check inline format first
    const providers = process.env.MARKET_DATA_PROVIDERS || '';
    if (providers.includes(':')) {
      const firstProvider = providers.split(',')[0];
      const [, marketType] = firstProvider.split(':');
      if (marketType) return marketType.toLowerCase();
    }

    // Check specific Binance config
    const binanceMarketType = process.env.BINANCE_MARKET_TYPE?.toLowerCase();
    if (binanceMarketType === 'spot' || binanceMarketType === 'futures') {
      return binanceMarketType;
    }

    // Check global market type
    const globalMarketType = process.env.MARKET_TYPE?.toLowerCase();
    if (globalMarketType === 'spot' || globalMarketType === 'futures') {
      return globalMarketType;
    }

    // Default to spot
    return 'spot';
  }

  private async checkRateLimit(chatId: number): Promise<boolean> {
    const now = Date.now();
    const queue = this.messageQueue.get(chatId) || [];

    // Remove messages outside the rate limit window
    const recentMessages = queue.filter((msg) => now - msg.timestamp < this.RATE_LIMIT_WINDOW_MS);

    if (recentMessages.length >= this.MAX_MESSAGES_PER_SECOND) {
      return false;
    }

    this.messageQueue.set(chatId, recentMessages);
    return true;
  }

  private trackMessage(chatId: number): void {
    const queue = this.messageQueue.get(chatId) || [];
    queue.push({ message: '', timestamp: Date.now() });
    this.messageQueue.set(chatId, queue);
  }

  private cleanupQueues(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [chatId, queue] of this.messageQueue.entries()) {
      const recentMessages = queue.filter((msg) => now - msg.timestamp < this.RATE_LIMIT_WINDOW_MS);
      
      if (recentMessages.length === 0) {
        this.messageQueue.delete(chatId);
        cleaned++;
      } else {
        this.messageQueue.set(chatId, recentMessages);
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`🧹 Cleaned ${cleaned} empty message queues`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async setupBotCommands(): Promise<void> {
    try {
      await this.bot.setMyCommands([
        { command: 'start', description: '🚀 Начать работу с ботом' },
        { command: 'add', description: '➕ Создать новый триггер' },
        { command: 'my_triggers', description: '📋 Показать мои триггеры' },
        { command: 'uptime', description: '⏱️ Статус и время работы бота' },
        { command: 'status', description: '📊 Статус бота (алиас /uptime)' },
      ]);
      this.logger.info('✅ Telegram bot commands menu configured');
    } catch (error) {
      this.logger.error('Failed to set bot commands:', error);
    }
  }

  private setupErrorHandling(): void {
    this.bot.on('error', (error) => {
      this.logger.error('Telegram Bot error:', error);
    });

    this.bot.on('polling_error', (error) => {
      this.logger.error('Telegram Bot polling error:', error);
    });
  }

  public async stop(): Promise<void> {
    if (this.bot.isPolling()) {
      await this.bot.stopPolling();
    }
  }
}
