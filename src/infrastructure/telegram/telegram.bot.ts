import TelegramBot from 'node-telegram-bot-api';
import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalDto } from '../../application/dto/signal.dto';

interface QueuedMessage {
  chatId: number;
  message: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

@Injectable()
export class TelegramBotService {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramBotService.name);

  // Message queue
  private messageQueue: QueuedMessage[] = [];
  private isProcessing = false;
  private readonly QUEUE_DELAY_MS = 1000;

  constructor(token: string) {
    if (!token) throw new Error('Token missing');
    this.bot = new TelegramBot(token, { polling: true });
  }

  public getBot(): TelegramBot { return this.bot; }

  public async sendMessage(chatId: number, message: string): Promise<void> {
    return this.enqueue(chatId, message);
  }

  private enqueue(chatId: number, message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({ chatId, message, resolve, reject });
      this.logger.debug(`Message queued. Queue size: ${this.messageQueue.length}`);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const item = this.messageQueue.shift()!;

      try {
        await this.bot.sendMessage(item.chatId, item.message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        item.resolve();
        this.logger.debug(`Message sent. Remaining in queue: ${this.messageQueue.length}`);
      } catch (e) {
        this.logger.error('Send error', e);
        item.reject(e instanceof Error ? e : new Error(String(e)));
      }

      // Wait 1 second before next message (if queue not empty)
      if (this.messageQueue.length > 0) {
        await this.delay(this.QUEUE_DELAY_MS);
      }
    }

    this.isProcessing = false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public async sendSignal(chatId: number, signal: SignalDto, interval?: number): Promise<void> {
    const msg = this.formatSignalMessage(signal, interval);
    await this.sendMessage(chatId, msg);
  }

  private formatSignalMessage(s: SignalDto, interval?: number): string {
    const formatPct = (v?: number) => v ? (v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`) : '0%';
    const formatUSD = (v?: number) => {
      if (!v) return '$0';
      if (Math.abs(v) >= 1000000) return `$${(v / 1000000).toFixed(2)}M`;
      if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}K`;
      return `$${v.toFixed(2)}`;
    };
    const formatVol = (v?: number) => {
      if (!v) return '0';
      if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
      if (v >= 1000) return `${(v / 1000).toFixed(2)}K`;
      return v.toFixed(2);
    };

    const intervalText = interval ? `${interval}m` : '';
    const time = s.timestamp ? s.timestamp.toLocaleTimeString('ru-RU') : '';

    // OI emoji and direction
    const oiEmoji = s.oiChangePercent > 0 ? '🟢' : '🔴';
    const oiArrow = s.oiChangePercent > 0 ? '↗️' : '↘️';

    // Divergence: OI direction + Price direction determines sentiment
    // OI↑ + Price↑ = Bulls (new longs)
    // OI↑ + Price↓ = Bears (new shorts)  
    // OI↓ + Price↑ = Bears (shorts covering)
    // OI↓ + Price↓ = Bulls (longs exiting)
    const oiUp = (s.oiChangePercent || 0) > 0;
    const priceUp = (s.priceChangePercent || 0) > 0;
    const isBullish = (oiUp && priceUp) || (!oiUp && !priceUp);
    const divergence = Math.abs((s.oiChangePercent || 0) - (s.priceChangePercent || 0));
    const divText = isBullish ? 'быки' : 'медведи';
    const divEmoji = isBullish ? '🔺' : '🔻';

    // Volume ratio
    const volRatio = (s.previousVolume && s.previousVolume > 0)
      ? (s.totalVolume || 0) / s.previousVolume
      : 0;

    // CVD direction
    const cvd = s.cvdDelta || 0;
    const cvdEmoji = cvd >= 0 ? '🟢' : '🔴';
    const cvdText = cvd >= 0 ? 'покупки' : 'продажи';

    // Volume in USD (rough estimate using current price)
    const volUSD = (s.totalVolume || 0) * (s.currentPrice || 0);
    const prevVolUSD = (s.previousVolume || 0) * (s.previousPrice || s.currentPrice || 0);

    return `
🔔 <b>№${s.signalNumber}</b> · ${s.symbol} · ${intervalText}
💰 $${s.currentPrice?.toFixed(4) || '0'} (${formatPct(s.priceChangePercent)}) · ⏰ ${time}

━━━━━━━━━━━━━━━━
${oiEmoji} <b>Open Interest:</b> ${formatPct(s.oiChangePercent)} ${oiArrow}
${divEmoji} Дивергенция: ${divergence.toFixed(1)}% (${divText})

📊 <b>Volume:</b> ${formatVol(s.totalVolume)} (${formatUSD(volUSD)})
   ├ Ratio: ${volRatio > 1 ? '🚀' : '📉'} ${volRatio.toFixed(2)}x vs prev ${formatUSD(prevVolUSD)}
   └ Delta: ${cvdEmoji} ${formatUSD(cvd)} (${cvdText})

💥 <b>Liquidations:</b> 🟢 ${formatUSD(s.liqLong)} | 🔴 ${formatUSD(s.liqShort)}

<a href="https://www.binance.com/ru/futures/${s.symbol}">Binance</a> | <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${s.symbol}.P">TradingView</a>
`.trim();
  }

  public async stop(): Promise<void> {
    await this.bot.stopPolling();
  }
}