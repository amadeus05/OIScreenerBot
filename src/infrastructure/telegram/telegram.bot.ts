import TelegramBot from 'node-telegram-bot-api';
import { Injectable } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { SignalDto } from '../../application/dto/signal.dto';

@Injectable()
export class TelegramBotService {
  private bot: TelegramBot;
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(token: string) {
    if (!token) throw new Error('Token missing');
    this.bot = new TelegramBot(token, { polling: true });
  }

  public getBot(): TelegramBot { return this.bot; }

  public async sendMessage(chatId: number, message: string): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      this.logger.error('Send error', e);
    }
  }

  public async sendSignal(chatId: number, signal: SignalDto, interval?: number): Promise<void> {
    const msg = this.formatSignalMessage(signal, interval);
    await this.sendMessage(chatId, msg);
  }

  private formatSignalMessage(s: SignalDto, interval?: number): string {
    const formatPct = (v?: number) => v ? (v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`) : '0%';
    const formatUSD = (v?: number) => {
        if (!v) return '0$';
        if (v > 1000000) return `${(v/1000000).toFixed(1)}M$`;
        if (v > 1000) return `${(v/1000).toFixed(1)}K$`;
        return `${v.toFixed(0)}$`;
    };

    const emoji = s.oiChangePercent > 0 ? '🟢' : '🔴';
    const intervalText = interval ? `${interval}m` : '';

    // CVD Color
    const cvd = s.cvdDelta || 0;
    const cvdEmoji = cvd > 0 ? 'bull' : 'bear'; // Text placeholder or emoji

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