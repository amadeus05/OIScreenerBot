import TelegramBot from 'node-telegram-bot-api';
import { Inject, Injectable } from '../../../shared/decorators';
import { TelegramBotService } from '../../../infrastructure/telegram/telegram.bot';
import { CreateTriggerUseCase } from '../../../application/use-cases/create-trigger.use-case';
import { GetTriggersUseCase } from '../../../application/use-cases/get-triggers.use-case';
import { RemoveTriggerUseCase } from '../../../application/use-cases/remove-trigger.use-case';
import { AnalyzeCoinUseCase } from '../../../application/use-cases/analyze-coin.use-case';
import { CreateTriggerDto } from '../../../application/dto/create-trigger.dto';
import { CoinAnalysisDto } from '../../../application/dto/coin-analysis.dto';
import { validate } from 'class-validator';
import { Logger } from '../../../shared/logger';
import { Direction } from '../../../domain/types/direction.type';
import { Trigger } from '../../../domain/entities/trigger.entity';
import { UptimeService } from '../../../infrastructure/services/uptime.service';
import { TradeDirection, EntryTiming, TrendDirection } from '../../../domain/coin-analyzer/types';

@Injectable()
export class CommandHandler {
  private readonly logger = new Logger(CommandHandler.name);
  private bot: TelegramBot;

  constructor(
    private readonly telegramBotService: TelegramBotService,
    private readonly createTriggerUseCase: CreateTriggerUseCase,
    private readonly getTriggersUseCase: GetTriggersUseCase,
    private readonly removeTriggerUseCase: RemoveTriggerUseCase,
    private readonly uptimeService: UptimeService,
    @Inject('AnalyzeCoinUseCase')
    private readonly analyzeCoinUseCase: AnalyzeCoinUseCase,
  ) {
    this.bot = this.telegramBotService.getBot();
  }

  public initialize(): void {
    this.bot.onText(/\/start/, this.handleStart.bind(this));
    this.bot.onText(/\/add/, this.handleAddTrigger.bind(this));
    this.bot.onText(/\/my_triggers/, this.handleMyTriggers.bind(this));
    this.bot.onText(/\/uptime/, this.handleUptime.bind(this));
    this.bot.onText(/\/status/, this.handleUptime.bind(this));
    // NEW: Analyze command
    this.bot.onText(/\/analyze\s+(\S+)/, this.handleAnalyze.bind(this));
    this.bot.onText(/\/a\s+(\S+)/, this.handleAnalyze.bind(this)); // Short alias
    this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    this.logger.info('Telegram command handlers initialized.');
  }

  // ============================================================================
  // ANALYZE COMMAND
  // ============================================================================

  private async handleAnalyze(msg: TelegramBot.Message, match: RegExpMatchArray | null): Promise<void> {
    const chatId = msg.chat.id;

    if (!match || !match[1]) {
      await this.telegramBotService.sendMessage(
        chatId,
        '❌ Укажите символ. Пример: <code>/analyze BTCUSDT</code> или <code>/a BTC</code>'
      );
      return;
    }

    const symbol = match[1].toUpperCase();

    await this.telegramBotService.sendMessage(chatId, `⏳ Анализирую ${symbol}...`);

    try {
      const result = await this.analyzeCoinUseCase.execute(symbol);
      const message = this.formatAnalysisResult(result);
      await this.telegramBotService.sendMessage(chatId, message);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Analysis failed for ${symbol}:`, error);
      await this.telegramBotService.sendMessage(
        chatId,
        `❌ Ошибка анализа ${symbol}: ${errorMsg}`
      );
    }
  }

  private formatAnalysisResult(result: CoinAnalysisDto): string {
    // Direction emoji and text
    const dirEmoji = result.direction === TradeDirection.LONG ? '🟢' :
      result.direction === TradeDirection.SHORT ? '🔴' : '⚪';
    const dirText = result.direction === TradeDirection.LONG ? 'LONG' :
      result.direction === TradeDirection.SHORT ? 'SHORT' : 'NEUTRAL';

    // Trade recommendation
    const tradeEmoji = result.shouldTrade ? '✅' : '⛔';
    const tradeText = result.shouldTrade ? 'Можно торговать' : 'Не торговать';

    // Entry timing
    const timingEmoji = result.entryTiming === EntryTiming.IMMEDIATE ? '🎯' :
      result.entryTiming === EntryTiming.WAIT_PULLBACK ? '⏳' : '👀';
    const timingText = result.entryTiming === EntryTiming.IMMEDIATE ? 'Сейчас' :
      result.entryTiming === EntryTiming.WAIT_PULLBACK ? 'Ждать откат' : 'Ждать подтверждение';

    // Trend alignment
    const trendEmojis = {
      [TrendDirection.UP]: '↗️',
      [TrendDirection.DOWN]: '↘️',
      [TrendDirection.SIDEWAYS]: '➡️',
    };
    const tf5m = trendEmojis[result.trendAlignment.tf5m];
    const tf15m = trendEmojis[result.trendAlignment.tf15m];
    const tf1h = trendEmojis[result.trendAlignment.tf1h];
    const alignedText = result.trendAlignment.aligned ? '✅ Согласованы' : '⚠️ Разнонаправлены';

    // Filters summary
    const filtersText = result.filterSummaries
      .map(f => `${f.passed ? '✅' : '❌'} ${f.name.replace('Filter', '')}: ${f.reason}`)
      .join('\n');

    // Strategies summary
    const strategiesText = result.strategySummaries
      .map(s => {
        const emoji = s.direction === TradeDirection.LONG ? '🟢' :
          s.direction === TradeDirection.SHORT ? '🔴' : '⚪';
        return `${emoji} ${s.name.replace('Strategy', '')}: ${s.reason}`;
      })
      .join('\n');

    return `
📊 <b>Анализ ${result.symbol}</b>

${dirEmoji} <b>Направление:</b> ${dirText}
📈 <b>Уверенность:</b> ${result.confidence.toFixed(1)}%
${tradeEmoji} <b>Рекомендация:</b> ${tradeText}

━━━━━━━━━━━━━━━━
💰 <b>Entry:</b> $${result.entryPrice.toFixed(4)}
🛑 <b>Stop Loss:</b> $${result.stopLossPrice.toFixed(4)} (-${result.stopLossPercent.toFixed(2)}%)
${timingEmoji} <b>Вход:</b> ${timingText}
   └ ${result.entryTimingReason}

━━━━━━━━━━━━━━━━
📊 <b>Multi-Timeframe:</b>
5m ${tf5m} | 15m ${tf15m} | 1h ${tf1h}
${alignedText}

━━━━━━━━━━━━━━━━
🔍 <b>Фильтры:</b>
${filtersText}

━━━━━━━━━━━━━━━━
📈 <b>Стратегии:</b>
${strategiesText}

━━━━━━━━━━━━━━━━
📝 <b>Итог:</b> ${result.summary}
`.trim();
  }

  // ============================================================================
  // EXISTING COMMANDS
  // ============================================================================

  private async handleUptime(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const uptime = this.uptimeService.getUptime();

    const activeTriggers = await this.getTriggersUseCase.execute(msg.from?.id || 0);

    const statusMessage = `
🤖 <b>Bot Status</b>

⏱️ <b>Uptime:</b> ${uptime}
🎯 <b>Your Active Triggers:</b> ${activeTriggers.length}
📊 <b>System:</b> Online & Monitoring

<i>Use /my_triggers to manage your alerts</i>
<i>Use /analyze SYMBOL to analyze a coin</i>
    `.trim();

    await this.telegramBotService.sendMessage(chatId, statusMessage);
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const uptime = this.uptimeService.getUptime();

    const welcomeMessage = `
👋 <b>Добро пожаловать в OI Alert Bot!</b>

Я отслеживаю изменения Open Interest (OI) в реальном времени по всем USDT парам.

<b>Команды:</b>
/add - Создать триггер
/my_triggers - Ваши триггеры
/uptime - Статус бота
/analyze SYMBOL - 🆕 Анализ монеты (или /a)

<b>Как создать триггер:</b>
<code>/add [up/down] [OI %] [интервал мин] [кулдаун сек]</code>

<b>Пример:</b>
<code>/add up 5 15 60</code>
(Уведомить, если OI вырастет на 5% за 15 минут)

<b>Пример анализа:</b>
<code>/analyze BTCUSDT</code> или <code>/a BTC</code>

<i>Бот работает уже: ${uptime}</i>
    `.trim();
    await this.telegramBotService.sendMessage(chatId, welcomeMessage);
  }

  private async handleAddTrigger(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !msg.text) return;

    const parts = msg.text.trim().split(/\s+/);
    if (parts.length !== 5) {
      await this.telegramBotService.sendMessage(
        chatId,
        '❌ Неверный формат. Пример: <code>/add up 10 15 60</code>',
      );
      return;
    }

    const [, direction, oiPercent, interval, limit] = parts;
    const dto = new CreateTriggerDto();
    dto.userId = userId;
    dto.direction = direction as Direction;
    dto.oiChangePercent = parseFloat(oiPercent);
    dto.timeIntervalMinutes = parseInt(interval, 10);
    dto.notificationLimitSeconds = parseInt(limit, 10);

    const errors = await validate(dto);
    if (errors.length > 0) {
      const errorMessage = errors
        .map((e) => Object.values(e.constraints || {}).join(', '))
        .join('; ');
      await this.telegramBotService.sendMessage(chatId, `❌ Ошибка валидации: ${errorMessage}`);
      return;
    }

    try {
      await this.createTriggerUseCase.execute(dto);
      await this.telegramBotService.sendMessage(
        chatId,
        '✅ Триггер на изменение OI успешно создан!',
      );

      this.logger.debug(
        `➕ User ${userId} created trigger: ${direction} ${oiPercent}% over ${interval}m`,
      );
    } catch (error) {
      this.logger.error('Failed to create trigger:', error);
      await this.telegramBotService.sendMessage(
        chatId,
        '❗️ Произошла ошибка при создании триггера.',
      );
    }
  }

  private async handleMyTriggers(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    const triggers = await this.getTriggersUseCase.execute(userId);

    if (triggers.length === 0) {
      await this.telegramBotService.sendMessage(chatId, 'У вас пока нет активных триггеров.');
      return;
    }

    const message =
      '<b>Ваши активные триггеры:</b>\n\n' + triggers.map(this.formatTrigger).join('\n');
    const options: TelegramBot.SendMessageOptions = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: triggers.map((trigger) => [
          {
            text: `❌ Удалить триггер #${trigger.id}`,
            callback_data: `delete_trigger_${trigger.id}`,
          },
        ]),
      },
    };

    await this.bot.sendMessage(chatId, message, options);
  }

  private formatTrigger(trigger: Trigger): string {
    const directionEmoji = trigger.direction === 'up' ? '📈' : '📉';
    return `${directionEmoji} #${trigger.id}: OI на <b>${trigger.oiChangePercent}%</b> за <b>${trigger.timeIntervalMinutes} мин.</b>`;
  }

  private async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!query.data || !query.message) return;

    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const [action, entity, id] = query.data.split('_');

    if (action === 'delete' && entity === 'trigger') {
      try {
        const triggerId = parseInt(id, 10);
        const success = await this.removeTriggerUseCase.execute(triggerId, userId);

        if (success) {
          await this.bot.answerCallbackQuery(query.id, { text: 'Триггер удален!' });
          await this.bot.editMessageText('Триггер был успешно удален.', {
            chat_id: chatId,
            message_id: query.message.message_id,
          });
        } else {
          await this.bot.answerCallbackQuery(query.id, { text: 'Не удалось найти триггер.' });
        }
      } catch (error) {
        this.logger.error('Failed to delete trigger:', error);
        await this.bot.answerCallbackQuery(query.id, { text: 'Ошибка при удалении.' });
      }
    }
  }
}
