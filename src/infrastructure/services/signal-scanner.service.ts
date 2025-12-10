import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../shared/logger';
import { SignalAnalyzerService, SignalResult, smartCandlesToBarData } from '../../domain/signal-analyzer';
import { TelegramBotService } from '../telegram/telegram.bot';
import { IAnalizationResultRepository } from '../../domain/interfaces/repositories.interface';
import { AnalizationResult } from '../../domain/entities/analization-result.entity';
import { Inject } from '../../shared/decorators';
import { IMarketDataRepository } from '../../domain/interfaces/services.interface';

export interface SignalScannerConfig {
    intervalMs: number;
    minCandles: number;
    maxSymbols: number;
    logDir: string;
    alertChatId: string;

    min24hVolumeUSD: number;
    blacklistedSymbols: string[]
}

const DEFAULT_CONFIG: SignalScannerConfig = {
    intervalMs: 60 * 1000,
    minCandles: 30,
    maxSymbols: 50,
    logDir: 'logs',
    alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID || '',

    // Фильтр: Минимальный суточный объем $10,000,000
    // Все, что меньше — мусор, который легко манипулируется
    min24hVolumeUSD: 10_000_000, 
    
    // Черный список (можно пополнять)
    blacklistedSymbols: [
        // Стейблкоины (они не пампятся, только шумят)
        'USDCUSDT', 'USDPUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'DAIUSDT', 'EURUSDT',
        // Токены с проблемами / Делистинг / Странное поведение
        'BTCDOMUSDT', 'BLUEBIRDUSDT', '1000LUNCUSDT', 'USTCUSDT' 
    ]
};

export class SignalScannerService {
    private readonly logger = new Logger('SignalScanner');
    private readonly config: SignalScannerConfig;
    private readonly signalAnalyzer: SignalAnalyzerService;
    private readonly telegramBot: TelegramBotService;
    private readonly analizationResultRepository: IAnalizationResultRepository;

    private scanTimer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private lastScanTime = 0;
    
    private allSymbols: string[] = [];
    private rotationIndex = 0;

    constructor(
        signalAnalyzer: SignalAnalyzerService,
        telegramBot: TelegramBotService,
        analizationResultRepository: IAnalizationResultRepository,
        @Inject('IMarketDataRepository') private readonly marketDataRepository: IMarketDataRepository, // <--- INJECTED
        config: Partial<SignalScannerConfig> = {}
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.signalAnalyzer = signalAnalyzer;
        this.telegramBot = telegramBot;
        this.analizationResultRepository = analizationResultRepository;
        this.ensureLogDir();
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

            this.logger.info(`Scanning ${symbols.length} symbols (RAM)...`);

            let signalCount = 0;
            const results: SignalResult[] = [];
            
            // В памяти это происходит очень быстро, батчинг можно уменьшить или делать всё сразу
            for (const symbol of symbols) {
                try {
                    const result = await this.analyzeSymbol(symbol);
                    if (result) {
                        results.push(result);
                        if (result.action !== 'NO_TRADE') {
                            signalCount++;
                            this.logResult(result);
                            await this.sendNotification(result);
                            await this.saveToDatabase(result);
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
        // Получаем список всех монет из памяти
        this.allSymbols = this.marketDataRepository.getAllKnownSymbols();
        
        if (this.allSymbols.length === 0) return [];

        return this.allSymbols;
    }

    private async analyzeSymbol(symbol: string): Promise<SignalResult | null> {
        // 0. ФИЛЬТР: ЧЕРНЫЙ СПИСОК (Самый быстрый, проверяем первым)
        if (this.config.blacklistedSymbols?.includes(symbol)) {
            return null;
        }

        // 1. БЕРЕМ ИЗ ПАМЯТИ
        const candles = this.marketDataRepository.getHistory(symbol, 500);

        // 2. ПРОВЕРКА НАЛИЧИЯ ДАННЫХ
        if (!candles || candles.length < this.config.minCandles) {
            return null;
        }

        // === 3. ФИЛЬТР: ОБЪЕМ ТОРГОВ (Используем candles) ===
        if (this.config.min24hVolumeUSD > 0) {
            // Берем последние 100 свечей (или сколько есть) для оценки
            const checkWindow = Math.min(candles.length, 100);
            // slice(-N) берет N последних элементов
            const sample = candles.slice(-checkWindow); 
            
            let sumVolumeUSD = 0;
            for (const c of sample) {
                // Объем ($) = кол-во монет * цена закрытия
                sumVolumeUSD += c.ohlc.v * c.ohlc.c; 
            }
            
            const avgVolumePerMinute = sumVolumeUSD / checkWindow;
            const estimated24hVol = avgVolumePerMinute * 1440; // 1440 минут в сутках

            // Если объем меньше лимита — выходим.
            // Переменная 'bars' еще не создана, ресурсы не потрачены.
            if (estimated24hVol < this.config.min24hVolumeUSD) {
                // this.logger.debug(`Skipping ${symbol}: Low Vol`);
                return null;
            }
        }

        // 4. КОНВЕРТАЦИЯ (Создаем bars только сейчас)
        const bars = smartCandlesToBarData(candles, symbol);

        // 5. WARMUP АНАЛИЗАТОРА
        if (!this.signalAnalyzer.isWarmedUp(symbol)) {
            this.signalAnalyzer.warmUp(symbol, bars);
        }

        // 6. АНАЛИЗ
        return this.signalAnalyzer.analyze(symbol, bars);
    }

    // ... (logResult, formatLogLine, sendNotification, formatTelegramMessage, saveToDatabase, mapToAnalizationResult, ensureLogDir remain unchanged)
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
        
        // === ДОБАВЛЯЕМ ВЫВОД REGIME ===
        // padEnd(8) выровняет строку, чтобы логи были ровными (VOLATILE - самое длинное слово)
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
            moduleAgreement: signalResult.meta.moduleAgreement 
        };

        return result;
    }

    private ensureLogDir(): void {
        if (!fs.existsSync(this.config.logDir)) {
            fs.mkdirSync(this.config.logDir, { recursive: true });
        }
    }
}