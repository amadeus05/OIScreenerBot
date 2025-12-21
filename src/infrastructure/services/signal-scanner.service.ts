import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../shared/logger';
import { SignalAnalyzerService, SignalResult, smartCandlesToBarData } from '../../domain/signal-analyzer';
import { TelegramBotService } from '../telegram/telegram.bot';
import { IAnalizationResultRepository } from '../../domain/interfaces/repositories.interface';
import { AnalizationResult } from '../../domain/entities/analization-result.entity';
import { Inject } from '../../shared/decorators';
import { IMarketDataRepository } from '../../domain/interfaces/services.interface';
import { ITradeRepository, ITradeService, PlaceOrderRequest } from '../../domain/interfaces/trade.interface';

import { GlobalTrendService } from '../../domain/signal-analyzer/services/global-trend.service';
import { MarketContext } from '../../domain/signal-analyzer/types/context';

export interface AutoTradeConfig {
    enabled: boolean;
    defaultQuantityUSDT: number;
    defaultLeverage: number;
    minConfidence: number;
    maxOpenTrades: number;
    cooldownMs: number;
}

export interface SignalScannerConfig {
    intervalMs: number;
    minCandles: number;
    maxSymbols: number;
    logDir: string;
    alertChatId: string;

    min24hVolumeUSD: number;
    blacklistedSymbols: string[];

    autoTrade: AutoTradeConfig;
}

const DEFAULT_CONFIG: SignalScannerConfig = {
    intervalMs: 60 * 1000,
    minCandles: 30,
    maxSymbols: 50,
    logDir: 'logs',
    alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID || '',

    // Фильтр: Минимальный суточный объем $10,000,000
    min24hVolumeUSD: 10_000_000, 
    
    // Черный список
    blacklistedSymbols: [
        'USDCUSDT', 'USDPUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'DAIUSDT', 'EURUSDT',
        'BTCDOMUSDT', 'BLUEBIRDUSDT', '1000LUNCUSDT', 'USTCUSDT' 
    ],

    // Автоматический трейдинг на Binance Testnet
    autoTrade: {
        enabled: process.env.AUTO_TRADE_ENABLED === 'true',
        defaultQuantityUSDT: Number(process.env.AUTO_TRADE_QUANTITY_USDT) || 100,
        defaultLeverage: Number(process.env.AUTO_TRADE_LEVERAGE) || 5,
        minConfidence: Number(process.env.AUTO_TRADE_MIN_CONFIDENCE) || 0.7,
        maxOpenTrades: Number(process.env.AUTO_TRADE_MAX_OPEN) || 3,
        cooldownMs: Number(process.env.AUTO_TRADE_COOLDOWN_MS) || 3 * 60 * 1000, // 3 минуты
    }
};

export class SignalScannerService {
    private readonly logger = new Logger('SignalScanner');
    private readonly config: SignalScannerConfig;
    private readonly signalAnalyzer: SignalAnalyzerService;
    private readonly telegramBot: TelegramBotService;
    private readonly analizationResultRepository: IAnalizationResultRepository;
    private readonly tradeService: ITradeService | null;
    private readonly tradeRepository: ITradeRepository | null;
    private readonly hasTestnetKeys: boolean;

    private scanTimer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private lastScanTime = 0;
    private lastTradeTimestamps: Map<string, number> = new Map();
    
    private allSymbols: string[] = [];

    constructor(
        signalAnalyzer: SignalAnalyzerService,
        telegramBot: TelegramBotService,
        analizationResultRepository: IAnalizationResultRepository,
        @Inject('IMarketDataRepository') private readonly marketDataRepository: IMarketDataRepository,
        private readonly globalTrendService: GlobalTrendService,
        @Inject('ITradeService') tradeService: ITradeService | null,
        @Inject('ITradeRepository') tradeRepository: ITradeRepository | null,
        config: Partial<SignalScannerConfig> = {},
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.signalAnalyzer = signalAnalyzer;
        this.telegramBot = telegramBot;
        this.analizationResultRepository = analizationResultRepository;
        this.tradeService = tradeService;
        this.tradeRepository = tradeRepository;
        this.hasTestnetKeys = Boolean(process.env.BINANCE_TESTNET_API_KEY && process.env.BINANCE_TESTNET_SECRET_KEY);
        this.ensureLogDir();

        if (this.config.autoTrade.enabled) {
            this.logger.info(`🤖 Auto-trading ENABLED: ${this.config.autoTrade.defaultQuantityUSDT} USDT, ${this.config.autoTrade.defaultLeverage}x leverage`);
            if (!this.hasTestnetKeys) {
                this.logger.warn('⚠️ Auto-trade enabled, но BINANCE_TESTNET_API_KEY/SECRET не заданы. Ордеры не будут выполнены.');
            }
        }
    }

    start(): void {
        if (this.isRunning) {
            this.logger.warn('Scanner already running');
            return;
        }

        this.isRunning = true;
        this.logger.info(`Signal Scanner started (interval: ${this.config.intervalMs / 1000}s, RAM Mode)`);
        
        // Initial wait to allow data accumulation
        setTimeout(() => this.runScan(), 5000);
        this.scanTimer = setInterval(() => this.runScan(), this.config.intervalMs);
    }

    stop(): void {
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        this.isRunning = false;
        this.logger.info('Signal Scanner stopped');
    }

    private async runScan(): Promise<void> {
        const startTime = Date.now();
        if (startTime - this.lastScanTime < this.config.intervalMs * 0.8) {
            return;
        }
        this.lastScanTime = startTime;

        try {
            const symbols = this.getSymbolsToScan();
            if (symbols.length === 0) return;

            // === 1. ПОЛУЧАЕМ ГЛОБАЛЬНЫЙ КОНТЕКСТ (Один раз на весь цикл) ===
            const context: MarketContext = await this.globalTrendService.analyze();
            
            // Логируем состояние рынка (для отладки в консоли)
            if (context.riskLevel !== 'LOW') {
                this.logger.info(`⚠️ Market Context: Global=${context.globalTrend}, Risk=${context.riskLevel}. ${context.permissions.reason}`);
            }

            // Если риск CRASH (Крах рынка), можно вообще остановить сканирование или искать только шорты
            // Но мы передадим контекст внутрь, пусть анализатор решает.

            this.logger.info(`Scanning ${symbols.length} symbols (RAM)...`);

            let signalCount = 0;
            const results: SignalResult[] = [];

            for (const symbol of symbols) {
                // Пропускаем BTC и ETH, так как они сами формируют контекст (чтобы не было рекурсии логики)
                if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') continue;

                try {
                    // === 2. ПЕРЕДАЕМ КОНТЕКСТ В АНАЛИЗАТОР ===
                    const result = await this.analyzeSymbol(symbol, context);
                    
                    if (result) {
                        results.push(result);
                        if (result.action !== 'NO_TRADE') {
                            signalCount++;
                            this.logResult(result);
                            await this.sendNotification(result);
                            await this.saveToDatabase(result);
                            
                            // 🤖 Автоматическое создание трейда
                            await this.executeAutoTrade(result);
                        }
                    }
                } catch (err) {
                    this.logger.error(`Error analyzing ${symbol}:`, err);
                }
            }

            const elapsed = Date.now() - startTime;
            this.logger.info(`Scan complete: ${results.length} analyzed, ${signalCount} signals (${elapsed}ms)`);

        } catch (error) {
            this.logger.error('Scan cycle error:', error);
        }
    }

    private getSymbolsToScan(): string[] {
        this.allSymbols = this.marketDataRepository.getAllKnownSymbols();
        if (this.allSymbols.length === 0) return [];
        return this.allSymbols;
    }

    private async analyzeSymbol(symbol: string, context: MarketContext): Promise<SignalResult | null> {
        // 0. ФИЛЬТР: ЧЕРНЫЙ СПИСОК
        if (this.config.blacklistedSymbols?.includes(symbol)) {
            return null;
        }

        // 1. БЕРЕМ ИЗ ПАМЯТИ
        const candles = this.marketDataRepository.getHistory(symbol, 500);

        // 2. ПРОВЕРКА НАЛИЧИЯ ДАННЫХ
        if (!candles || candles.length < this.config.minCandles) {
            return null;
        }

        // 3. ФИЛЬТР: ОБЪЕМ ТОРГОВ
        if (this.config.min24hVolumeUSD > 0) {
            const checkWindow = Math.min(candles.length, 100);
            const sample = candles.slice(-checkWindow);
            let sumVolumeUSD = 0;
            for (const c of sample) {
                sumVolumeUSD += c.ohlc.v * c.ohlc.c;
            }
            const avgVolumePerMinute = sumVolumeUSD / checkWindow;
            const estimated24hVol = avgVolumePerMinute * 1440;

            if (estimated24hVol < this.config.min24hVolumeUSD) {
                return null;
            }
        }

        // 4. КОНВЕРТАЦИЯ
        const bars = smartCandlesToBarData(candles, symbol);

        // 5. WARMUP АНАЛИЗАТОРА
        if (!this.signalAnalyzer.isWarmedUp(symbol)) {
            this.signalAnalyzer.warmUp(symbol, bars);
        }

        // 6. АНАЛИЗ (С учетом контекста)
        return this.signalAnalyzer.analyze(symbol, bars, context);
    }

    private logResult(result: SignalResult): void {
        try {
            const date = new Date().toISOString().split('T')[0];
            const filename = path.join(this.config.logDir, `signals-${date}.log`);
            const line = this.formatLogLine(result);
            fs.appendFileSync(filename, line + '\n', 'utf8');
        } catch (error) {
            this.logger.error('Error writing log:', error);
        }
    }

    private formatLogLine(result: SignalResult): string {
        const now = new Date();
        const kyivTime = new Date(now.getTime() + (2 * 60 * 60 * 1000));
        const ts = kyivTime.toISOString().replace('T', ' ').slice(0, 19);
        const modules = `OF:${result.modules.orderflow.toFixed(2)} OI:${result.modules.oi.toFixed(2)} M:${result.modules.momentum.toFixed(2)} L:${result.modules.levels.toFixed(2)} Lq:${result.modules.liquidations.toFixed(2)}`;
        const entry = `E:${result.entryPrice.toFixed(6)}`;
        const sl = `SL:${result.sl.toFixed(6)}`;
        const tp = result.tp[0] ? `TP:${result.tp[0].toFixed(6)}` : 'TP:-';
        
        const regime = (result.marketRegime || 'N/A').padEnd(8);
        return `${ts} | ${result.symbol.padEnd(10)} | ${result.action.padEnd(5)} | conf=${result.confidence.toFixed(2)} | ${entry} ${sl} ${tp} | ${modules} | ${regime} | ${result.reasonTags.slice(0, 3).join(',')}`;
    }

    private async sendNotification(result: SignalResult): Promise<void> {
        const chatId = this.config.alertChatId;
        if (!chatId) return;
        try {
            const message = this.formatTelegramMessage(result);
            await this.telegramBot.sendMessage(parseInt(chatId), message);
        } catch (error) {
            this.logger.error(`Error sending notification for ${result.symbol}:`, error);
        }
    }

    private formatTelegramMessage(result: SignalResult): string {
        const emoji = result.action === 'LONG' ? '🟢' : '🔴';
        const confEmoji = result.confidenceLevel === 'HIGH' ? '🔥' : result.confidenceLevel === 'MEDIUM' ? '✅' : '⚠️';
        const slPct = result.entryPrice > 0 ? ((result.sl - result.entryPrice) / result.entryPrice * 100).toFixed(2) : '0';
        const tp1Pct = result.tpPct[0]?.toFixed(2) || '0';
        return `
${emoji} <b>SIGNAL: ${result.symbol}</b> ${emoji}
📊 <b>Action:</b> ${result.action} ${confEmoji}
🎯 <b>Confidence:</b> ${(result.confidence * 100).toFixed(0)}% (${result.confidenceLevel})
📍 <b>Entry:</b> $${result.entryPrice.toFixed(2)} (${result.entryType})
🛑 <b>SL:</b> $${result.sl.toFixed(2)} (${slPct}%)
🎯 <b>TP1:</b> $${result.tp[0]?.toFixed(2) || '-'} (+${tp1Pct}%)
📈 <b>Modules:</b> OF:${result.modules.orderflow.toFixed(2)} | OI:${result.modules.oi.toFixed(2)}
🏷️ <b>Tags:</b> ${result.reasonTags.slice(0, 5).join(', ')}
<i>Auto Signal Scanner</i>`.trim();
    }

    private async saveToDatabase(signalResult: SignalResult): Promise<void> {
        try {
            const analizationResult = this.mapToAnalizationResult(signalResult);
            await this.analizationResultRepository.save(analizationResult);
        } catch (error) {
            this.logger.error(`Error saving analysis result for ${signalResult.symbol}:`, error);
        }
    }

    private mapToAnalizationResult(signalResult: SignalResult): AnalizationResult {
        const result = new AnalizationResult();
        result.ts = new Date();
        result.symbol = signalResult.symbol;
        result.action = signalResult.action;
        result.entryType = signalResult.entryType;
        result.entryPrice = signalResult.entryPrice;
        result.sl = signalResult.sl;
        result.tp = signalResult.tp;
        result.tpPct = signalResult.tpPct;
        result.horizonMin = signalResult.horizonMin;
        result.confidence = signalResult.confidence;
        result.confidenceLevel = signalResult.confidenceLevel;
        result.modules = signalResult.modules;
        result.reasonTags = signalResult.reasonTags;
        result.riskPct = signalResult.riskPct;

        result.marketRegime = signalResult.marketRegime || 'RANGING';
        result.meta = { 
            rawScore: signalResult.meta.rawScore, 
            moduleAgreement: signalResult.meta.moduleAgreement,
            globalTrend: signalResult.meta.globalTrend // Сохраняем и глобальный тренд
        };
        return result;
    }

    private ensureLogDir(): void {
        if (!fs.existsSync(this.config.logDir)) {
            fs.mkdirSync(this.config.logDir, { recursive: true });
        }
    }

    // ==================== AUTO-TRADING ====================

    private async executeAutoTrade(signal: SignalResult): Promise<void> {
        const { autoTrade } = this.config;

        // 1. Проверяем, включен ли автотрейдинг
        if (!autoTrade.enabled) return;

        // 1.1. Проверка наличия ключей
        if (!this.hasTestnetKeys) {
            this.logger.warn('⚠️ Testnet ключи не заданы, пропускаем автотрейд.');
            return;
        }

        // 2. Проверяем наличие трейд-сервиса
        if (!this.tradeService) {
            this.logger.warn('⚠️ Auto-trade enabled but ITradeService not available');
            return;
        }

        // 2.1. Проверяем лимит открытых сделок через репозиторий
        const openCount = await this.getOpenTradesCount();
        if (openCount >= autoTrade.maxOpenTrades) {
            this.logger.warn(`⚠️ Max open trades reached (${autoTrade.maxOpenTrades}), skipping ${signal.symbol}`);
            return;
        }

        // 2.2. Анти-спам по символу (cooldown)
        const lastTs = this.lastTradeTimestamps.get(signal.symbol) || 0;
        if (Date.now() - lastTs < autoTrade.cooldownMs) {
            this.logger.debug(`Skip trade: cooldown active for ${signal.symbol}`);
            return;
        }

        // 3. Проверяем минимальную уверенность сигнала
        if (signal.confidence < autoTrade.minConfidence) {
            this.logger.debug(`Skip trade: confidence ${signal.confidence.toFixed(2)} < ${autoTrade.minConfidence}`);
            return;
        }

        // 5. Рассчитываем quantity на основе USDT
        const quantity = this.calculateQuantity(signal.entryPrice, autoTrade.defaultQuantityUSDT, autoTrade.defaultLeverage);
        if (quantity <= 0) {
            this.logger.warn(`⚠️ Cannot calculate quantity for ${signal.symbol}`);
            return;
        }

        // 6. Формируем запрос на ордер
        const orderRequest: PlaceOrderRequest = {
            symbol: signal.symbol,
            side: signal.action === 'LONG' ? 'BUY' : 'SELL',
            type: 'MARKET',
            quantity,
            stopLoss: signal.sl,
            takeProfit: signal.tp[0], // Первый TP
            leverage: autoTrade.defaultLeverage,
            source: 'signal-scanner',
            tags: signal.reasonTags.slice(0, 5),
        };

        try {
            this.logger.info(`🚀 Placing ${signal.action} order for ${signal.symbol}: qty=${quantity}, SL=${signal.sl}, TP=${signal.tp[0]}`);
            
            const trade = await this.tradeService.placeOrder(orderRequest);
            this.lastTradeTimestamps.set(signal.symbol, Date.now());
            
            this.logger.info(`✅ Trade placed: ${signal.symbol} #${trade.id} (${trade.status})`);
            
            // Отправляем уведомление об открытии трейда
            await this.sendTradeNotification(signal, trade);
        } catch (error) {
            this.logger.error(`❌ Failed to place trade for ${signal.symbol}:`, error);
        }
    }

    private calculateQuantity(price: number, usdtAmount: number, leverage: number): number {
        if (price <= 0) return 0;
        const notional = usdtAmount * (leverage > 0 ? leverage : 1);
        const rawQty = notional / price;

        // Минимальная квота — грубая оценка, чтобы не получить 0
        const minStep = 0.0001;

        // Округляем вниз до разумной точности, но не ниже minStep
        let qty: number;
        if (price > 1000) {
            qty = Math.floor(rawQty * 1000) / 1000;
        } else if (price > 1) {
            qty = Math.floor(rawQty * 100) / 100;
        } else {
            qty = Math.floor(rawQty * 10) / 10;
        }

        return Math.max(qty, minStep);
    }

    private async sendTradeNotification(signal: SignalResult, trade: { id: number; status: string }): Promise<void> {
        const chatId = this.config.alertChatId;
        if (!chatId) return;

        const emoji = signal.action === 'LONG' ? '🟢' : '🔴';
        const message = `
${emoji} <b>TRADE OPENED: ${signal.symbol}</b> ${emoji}
🆔 <b>Trade ID:</b> #${trade.id}
📊 <b>Status:</b> ${trade.status}
📍 <b>Entry:</b> $${signal.entryPrice.toFixed(4)}
🛑 <b>SL:</b> $${signal.sl.toFixed(4)}
🎯 <b>TP:</b> $${signal.tp[0]?.toFixed(4) || '-'}
⚡ <b>Leverage:</b> ${this.config.autoTrade.defaultLeverage}x
💰 <b>Size:</b> $${this.config.autoTrade.defaultQuantityUSDT}
<i>Auto-Trade Bot</i>`.trim();

        try {
            await this.telegramBot.sendMessage(parseInt(chatId), message);
        } catch (error) {
            this.logger.error(`Error sending trade notification:`, error);
        }
    }

    private async getOpenTradesCount(): Promise<number> {
        try {
            if (!this.tradeRepository) return 0;
            const open = await this.tradeRepository.findOpenTrades();
            return open.length;
        } catch (error) {
            this.logger.warn('⚠️ Cannot fetch open trades count, fallback to 0', error as Error);
            return 0;
        }
    }
}