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
      if (!v) return '0$';
      if (v > 1000000) return `${(v / 1000000).toFixed(1)}M$`;
      if (v > 1000) return `${(v / 1000).toFixed(1)}K$`;
      return `${v.toFixed(0)}$`;
    };

    const emoji = s.oiChangePercent > 0 ? '🟢' : '🔴';
    const intervalText = interval ? `${interval}m` : '';

    // CVD Color
    const cvd = s.cvdDelta || 0;

    return `
🚨 <b>${s.symbol}</b> ${intervalText} ${emoji}
OI Change: <b>${formatPct(s.oiChangePercent)}</b>
Price: ${s.currentPrice?.toFixed(4)} (${formatPct(s.priceChangePercent)})

📊 <b>Metrics:</b>
CVD Delta: ${formatUSD(cvd)}
Liquidations: 🟢 ${formatUSD(s.liqLong)} | 🔴 ${formatUSD(s.liqShort)}

<a href="https://www.binance.com/ru/futures/${s.symbol}">Binance</a> | <a href="https://www.tradingview.com/chart/?symbol=BINANCE:${s.symbol}.P">TradingView</a>
`.trim();
  }

  public async stop(): Promise<void> {
    await this.bot.stopPolling();
  }
}