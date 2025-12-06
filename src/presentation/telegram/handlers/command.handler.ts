import TelegramBot from 'node-telegram-bot-api';
import { Inject, Injectable } from '../../../shared/decorators';
import { TelegramBotService } from '../../../infrastructure/telegram/telegram.bot';
import { CreateTriggerUseCase } from '../../../application/use-cases/create-trigger.use-case';
import { GetTriggersUseCase } from '../../../application/use-cases/get-triggers.use-case';
import { RemoveTriggerUseCase } from '../../../application/use-cases/remove-trigger.use-case';
import { CreateTriggerDto } from '../../../application/dto/create-trigger.dto';
import { validate } from 'class-validator';
import { Logger } from '../../../shared/logger';
import { Direction } from '../../../domain/types/direction.type';
import { Trigger } from '../../../domain/entities/trigger.entity';
import { PumpScoutBot } from '../../../app';
import { UptimeService } from '../../../infrastructure/services/uptime.service';
import { SignalAnalyzerService, SignalResult, smartCandlesToBarData, SupabaseDataProvider } from '../../../domain/signal-analyzer';
import { IMarketDataRepository } from '../../../domain/interfaces/services.interface';



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
    private readonly signalAnalyzer?: SignalAnalyzerService,
    private readonly marketDataRepo?: IMarketDataRepository,
  ) {
    this.bot = this.telegramBotService.getBot();
  }

  public initialize(): void {
    this.bot.onText(/\/start/, this.handleStart.bind(this));
    this.bot.onText(/\/add/, this.handleAddTrigger.bind(this));
    this.bot.onText(/\/my_triggers/, this.handleMyTriggers.bind(this));
    // ADD: New uptime command
    this.bot.onText(/\/uptime/, this.handleUptime.bind(this));
    this.bot.onText(/\/status/, this.handleUptime.bind(this)); // Alias
    // ADD: Signal analyzer command
    this.bot.onText(/\/analyze/, this.handleAnalyze.bind(this));
    this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    this.logger.info('Telegram command handlers initialized.');
  }

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
    `.trim();

    await this.telegramBotService.sendMessage(chatId, statusMessage);
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const uptime = this.uptimeService.getUptime();

    const welcomeMessage = `
👋 <b>Добро пожаловать в OI Alert Bot!</b>

Я отслеживаю изменения Open Interest (OI) в реальном времени по всем USDT парам.

<b>Как создать триггер:</b>
<code>/add [up/down] [OI %] [интервал мин] [кулдаун сек]</code>

<b>Пример:</b>
<code>/add up 5 15 60</code>
(Уведомить, если OI вырастет на 5% за 15 минут. Кулдаун 60 секунд)

<b>Команды:</b>
/add - Создать триггер
/my_triggers - Ваши триггеры
/uptime - Статус бота

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
      // <-- Теперь ожидаем 5 частей
      await this.telegramBotService.sendMessage(
        chatId,
        '❌ Неверный формат. Пример: <code>/add up 10 15 60</code>',
      );
      return;
    }

    // Fix variable names
    const [, direction, oiPercent, interval, limit] = parts;
    const dto = new CreateTriggerDto();
    dto.userId = userId;
    dto.direction = direction as Direction;
    // Use OI field
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

      // ADD: Debug log for successful trigger creation
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
          // Редактируем сообщение, чтобы убрать кнопку
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

  // =============================================
  // SIGNAL ANALYZER COMMAND
  // =============================================
  private async handleAnalyze(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    if (!this.signalAnalyzer) {
      await this.telegramBotService.sendMessage(
        chatId,
        '❌ Signal Analyzer не доступен.'
      );
      return;
    }

    const parts = msg.text?.trim().split(/\s+/) || [];
    if (parts.length < 2) {
      await this.telegramBotService.sendMessage(
        chatId,
        '❌ Укажите символ. Пример: <code>/analyze BTCUSDT</code>'
      );
      return;
    }

    const symbol = parts[1].toUpperCase();

    // Read at runtime (not module load time) to ensure dotenv has loaded
    const dataSourceConfig = process.env.SIGNAL_ANALYZER_DATA_SOURCE || 'memory';
    const useSupabase = dataSourceConfig === 'supabase';

    // Debug: log data source
    this.logger.info(`🔍 /analyze ${symbol}: DATA_SOURCE='${dataSourceConfig}', useSupabase=${useSupabase}`);

    try {
      let bars;
      let dataSource: string;

      if (useSupabase) {
        // Fetch from Supabase
        const supabaseProvider = new SupabaseDataProvider();

        this.logger.info(`🔌 Supabase isConfigured: ${supabaseProvider.isConfigured()}`);

        if (!supabaseProvider.isConfigured()) {
          this.logger.error('❌ Supabase credentials missing');
          await this.telegramBotService.sendMessage(
            chatId,
            '❌ Supabase не настроен. Установите SUPABASE_URL и SUPABASE_API_KEY.'
          );
          return;
        }

        this.logger.info(`📊 Checking hasEnoughData for ${symbol}...`);
        const hasData = await supabaseProvider.hasEnoughData(symbol, 20);
        this.logger.info(`📊 hasEnoughData(${symbol}): ${hasData}`);

        if (!hasData) {
          await this.telegramBotService.sendMessage(
            chatId,
            `⏳ Недостаточно данных для <b>${symbol}</b> в Supabase.`
          );
          return;
        }

        this.logger.info(`📥 Fetching history for ${symbol}...`);
        bars = await supabaseProvider.getHistory(symbol, 500);
        this.logger.info(`📥 Fetched ${bars?.length || 0} bars for ${symbol}`);
        dataSource = 'Supabase';
      } else {
        // Use in-memory repository
        if (!this.marketDataRepo) {
          await this.telegramBotService.sendMessage(
            chatId,
            '❌ Репозиторий данных не запущен.'
          );
          return;
        }

        const knownSymbols = this.marketDataRepo.getAllKnownSymbols();
        if (!knownSymbols.includes(symbol)) {
          await this.telegramBotService.sendMessage(
            chatId,
            `❌ Символ <b>${symbol}</b> не найден. Доступно: ${knownSymbols.length} символов.`
          );
          return;
        }

        if (!this.marketDataRepo.isWarm(symbol)) {
          await this.telegramBotService.sendMessage(
            chatId,
            `⏳ Недостаточно данных для <b>${symbol}</b>. Подождите несколько минут.`
          );
          return;
        }

        const candles = this.marketDataRepo.getHistory(symbol, 500);
        bars = smartCandlesToBarData(candles, symbol);
        dataSource = 'Memory';
      }

      if (!bars || bars.length < 20) {
        await this.telegramBotService.sendMessage(
          chatId,
          `❌ Недостаточно данных для анализа <b>${symbol}</b>.`
        );
        return;
      }

      // CRITICAL: Warm up stateful modules with historical data BEFORE analyzing
      // This ensures RollingStats, OIModule history, LevelsModule swings, etc. are properly initialized
      if (!this.signalAnalyzer.isWarmedUp(symbol)) {
        this.logger.info(`🔥 Warming up ${symbol} with ${bars.length} historical bars...`);
        this.signalAnalyzer.warmUp(symbol, bars);
      }

      // Analyze (now modules have proper state)
      const result = this.signalAnalyzer.analyze(symbol, bars);

      // Format and send response
      const message = this.formatSignalResult(result, dataSource);
      await this.telegramBotService.sendMessage(chatId, message);

      this.logger.debug(`Analyze command for ${symbol}: ${result.action} (source: ${dataSource})`);
    } catch (error) {
      this.logger.error(`Error analyzing ${symbol}:`, error);
      await this.telegramBotService.sendMessage(
        chatId,
        `❗️ Ошибка анализа <b>${symbol}</b>.`
      );
    }
  }

  /**
   * Format SignalResult for Telegram message
   */
  private formatSignalResult(result: SignalResult, dataSource?: string): string {
    const actionEmoji = result.action === 'LONG' ? '🟢' : result.action === 'SHORT' ? '🔴' : '⚪';
    const confEmoji = result.confidenceLevel === 'HIGH' ? '🔥' : result.confidenceLevel === 'MEDIUM' ? '✅' : '⚠️';
    const sourceLabel = dataSource ? ` (${dataSource})` : '';

    if (result.action === 'NO_TRADE') {
      return `
📊 <b>Анализ: ${result.symbol}</b>${sourceLabel}

${actionEmoji} <b>Сигнал:</b> NO_TRADE

${confEmoji} <b>Причина:</b> ${result.reasonTags.join(', ') || 'Ниже порога'}

📈 <b>Скоры модулей:</b>
• Orderflow: ${(result.modules.orderflow || 0).toFixed(2)}
• OI: ${(result.modules.oi || 0).toFixed(2)}
• Momentum: ${(result.modules.momentum || 0).toFixed(2)}
• Levels: ${(result.modules.levels || 0).toFixed(2)}
• Liquidations: ${(result.modules.liquidations || 0).toFixed(2)}

<i>Raw Score: ${result.meta.rawScore?.toFixed(3) || '0'}</i>
      `.trim();
    }

    const slPct = ((result.sl - result.entryPrice) / result.entryPrice * 100).toFixed(2);
    const tp1Pct = result.tpPct[0]?.toFixed(2) || '0';
    const tp2Pct = result.tpPct[1]?.toFixed(2) || '0';

    return `
📊 <b>Анализ: ${result.symbol}</b>${sourceLabel}

${actionEmoji} <b>Сигнал:</b> ${result.action} ${confEmoji}
🎯 <b>Confidence:</b> ${(result.confidence * 100).toFixed(0)}% (${result.confidenceLevel})

📍 <b>Entry:</b> $${result.entryPrice.toFixed(2)} (${result.entryType})
🛑 <b>SL:</b> $${result.sl.toFixed(2)} (${slPct}%)
🎯 <b>TP1:</b> $${result.tp[0]?.toFixed(2) || '-'} (+${tp1Pct}%)
🎯 <b>TP2:</b> $${result.tp[1]?.toFixed(2) || '-'} (+${tp2Pct}%)

⏱️ <b>Горизонт:</b> ~${result.horizonMin} мин
💰 <b>Риск:</b> ${result.riskPct.toFixed(2)}%

📈 <b>Модули:</b>
• Orderflow: ${(result.modules.orderflow || 0).toFixed(2)}
• OI: ${(result.modules.oi || 0).toFixed(2)}
• Momentum: ${(result.modules.momentum || 0).toFixed(2)}
• Levels: ${(result.modules.levels || 0).toFixed(2)}
• Liquidations: ${(result.modules.liquidations || 0).toFixed(2)}

🏷️ <b>Теги:</b> ${result.reasonTags.slice(0, 5).join(', ')}
    `.trim();
  }
}
