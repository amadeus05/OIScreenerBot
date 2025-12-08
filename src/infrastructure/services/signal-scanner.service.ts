/**
 * Signal Scanner Service
 * Automatically scans coins after candle close, logs results, and sends Telegram alerts
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../shared/logger';
import { SignalAnalyzerService, SignalResult, SupabaseDataProvider } from '../../domain/signal-analyzer';
import { TelegramBotService } from '../telegram/telegram.bot';
import { IAnalizationResultRepository } from '../../domain/interfaces/repositories.interface';
import { AnalizationResult } from '../../domain/entities/analization-result.entity';

export interface SignalScannerConfig {
    /** Scan interval in milliseconds (default: 60000 = 1 minute) */
    intervalMs: number;
    /** Minimum candles required for analysis */
    minCandles: number;
    /** Maximum symbols to scan per cycle */
    maxSymbols: number;
    /** Directory for log files */
    logDir: string;
    /** Chat ID for Telegram notifications (from env) */
    alertChatId: string;
}

const DEFAULT_CONFIG: SignalScannerConfig = {
    intervalMs: 60 * 1000,      // 1 minute
    minCandles: 30,             // Reduced from 50 to allow more coins
    maxSymbols: 50,             // Increased: symbols per cycle
    logDir: 'logs',
    alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID || '',
};

export class SignalScannerService {
    private readonly logger = new Logger('SignalScanner');
    private readonly config: SignalScannerConfig;
    private readonly signalAnalyzer: SignalAnalyzerService;
    private readonly supabaseProvider: SupabaseDataProvider;
    private readonly telegramBot: TelegramBotService;
    private readonly analizationResultRepository: IAnalizationResultRepository;

    private scanTimer: NodeJS.Timeout | null = null;
    private isRunning = false;
    private lastScanTime = 0;

    // Rotation: track which symbols we've scanned
    private allSymbols: string[] = [];
    private rotationIndex = 0;

    constructor(
        signalAnalyzer: SignalAnalyzerService,
        telegramBot: TelegramBotService,
        analizationResultRepository: IAnalizationResultRepository, // Add this parameter
        config: Partial<SignalScannerConfig> = {}
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.signalAnalyzer = signalAnalyzer;
        this.telegramBot = telegramBot;
        this.analizationResultRepository = analizationResultRepository; // Initialize
        this.supabaseProvider = new SupabaseDataProvider();

        // Ensure log directory exists
        this.ensureLogDir();
    }

    /**
     * Start the scanner
     */
    start(): void {
        if (this.isRunning) {
            this.logger.warn('Scanner already running');
            return;
        }

        if (!this.supabaseProvider.isConfigured()) {
            this.logger.error('Supabase not configured, scanner disabled');
            return;
        }

        this.isRunning = true;
        this.logger.info(`Signal Scanner started (interval: ${this.config.intervalMs / 1000}s)`);

        // Run immediately, then on interval
        this.runScan();
        this.scanTimer = setInterval(() => this.runScan(), this.config.intervalMs);
    }

    /**
     * Stop the scanner
     */
    stop(): void {
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        this.isRunning = false;
        this.logger.info('Signal Scanner stopped');
    }

    /**
     * Run a single scan cycle
     */
    private async runScan(): Promise<void> {
        const startTime = Date.now();

        // Prevent overlapping scans
        if (startTime - this.lastScanTime < this.config.intervalMs * 0.8) {
            this.logger.debug('Skipping scan, previous scan still recent');
            return;
        }
        this.lastScanTime = startTime;

        try {
            // Get available symbols from Supabase
            const symbols = await this.getSymbolsToScan();

            if (symbols.length === 0) {
                this.logger.warn('No symbols to scan');
                return;
            }

            this.logger.info(`Scanning ${symbols.length} symbols...`);

            let signalCount = 0;
            const results: SignalResult[] = [];

            // Parallel processing: analyze multiple symbols at once
            const BATCH_SIZE = 10;  // 10 parallel requests at a time

            for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
                const batch = symbols.slice(i, i + BATCH_SIZE);

                const batchResults = await Promise.all(
                    batch.map(async (symbol) => {
                        try {
                            return await this.analyzeSymbol(symbol);
                        } catch (err) {
                            this.logger.error(`Error analyzing ${symbol}:`, err);
                            return null;
                        }
                    })
                );

                for (const result of batchResults) {
                    if (result) {
                        results.push(result);

                        if (result.action !== 'NO_TRADE') {
                            signalCount++;
                            this.logResult(result);
                            await this.sendNotification(result);
                            await this.saveToDatabase(result);
                        }                        
                    }
                }
            }

            const elapsed = Date.now() - startTime;
            this.logger.info(`Scan complete: ${results.length} analyzed, ${signalCount} signals (${elapsed}ms)`);

        } catch (error) {
            this.logger.error('Scan cycle error:', error);
        }
    }

    /**
     * Get symbols to scan from Supabase with rotation
     */
    private async getSymbolsToScan(): Promise<string[]> {
        try {
            // Refresh symbol list every full cycle or if empty
            if (this.allSymbols.length === 0 || this.rotationIndex >= this.allSymbols.length) {
                this.allSymbols = await this.supabaseProvider.getAvailableSymbols();
                this.rotationIndex = 0;
                this.logger.info(`Refreshed symbol list: ${this.allSymbols.length} symbols, starting new cycle`);
            }

            // Get next batch of symbols
            const startIdx = this.rotationIndex;
            const endIdx = Math.min(startIdx + this.config.maxSymbols, this.allSymbols.length);
            const batch = this.allSymbols.slice(startIdx, endIdx);

            // Update rotation index
            this.rotationIndex = endIdx;

            this.logger.info(`Scanning batch ${Math.floor(startIdx / this.config.maxSymbols) + 1}: symbols ${startIdx + 1}-${endIdx} of ${this.allSymbols.length}`);

            return batch;
        } catch (error) {
            this.logger.error('Error getting symbols:', error);
            return [];
        }
    }

    /**
     * Analyze a single symbol
     */
    private async analyzeSymbol(symbol: string): Promise<SignalResult | null> {
        // Check if enough data
        const hasData = await this.supabaseProvider.hasEnoughData(symbol, this.config.minCandles);
        if (!hasData) {
            this.logger.debug(`${symbol}: not enough data (need ${this.config.minCandles})`);
            return null;
        }

        // Fetch history
        const bars = await this.supabaseProvider.getHistory(symbol, 500);
        if (!bars || bars.length < 20) {
            this.logger.debug(`${symbol}: fetched only ${bars?.length || 0} bars`);
            return null;
        }

        // Warm up if needed
        if (!this.signalAnalyzer.isWarmedUp(symbol)) {
            this.signalAnalyzer.warmUp(symbol, bars);
        }

        // Analyze
        return this.signalAnalyzer.analyze(symbol, bars);
    }

    /**
     * Log result to daily file
     */
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

    /**
     * Format log line
     */
    private formatLogLine(result: SignalResult): string {
        // Kiev time (UTC+2)
        const now = new Date();
        const kyivTime = new Date(now.getTime() + (2 * 60 * 60 * 1000));
        const ts = kyivTime.toISOString().replace('T', ' ').slice(0, 19);

        const modules = `OF:${result.modules.orderflow.toFixed(2)} OI:${result.modules.oi.toFixed(2)} M:${result.modules.momentum.toFixed(2)} L:${result.modules.levels.toFixed(2)} Lq:${result.modules.liquidations.toFixed(2)}`;

        // Entry/SL/TP info
        const entry = `E:${result.entryPrice.toFixed(6)}`;
        const sl = `SL:${result.sl.toFixed(6)}`;
        const tp = result.tp[0] ? `TP:${result.tp[0].toFixed(6)}` : 'TP:-';

        return `${ts} | ${result.symbol.padEnd(10)} | ${result.action.padEnd(5)} | conf=${result.confidence.toFixed(2)} | ${entry} ${sl} ${tp} | ${modules} | ${result.reasonTags.slice(0, 3).join(',')}`;
    }

    /**
     * Send Telegram notification for signal
     */
    private async sendNotification(result: SignalResult): Promise<void> {
        const chatId = this.config.alertChatId;

        if (!chatId) {
            this.logger.warn('TELEGRAM_ALERT_CHAT_ID not set, skipping notification');
            return;
        }

        try {
            const message = this.formatTelegramMessage(result);
            await this.telegramBot.sendMessage(parseInt(chatId), message);
            this.logger.info(`📨 Sent signal notification for ${result.symbol}`);
        } catch (error) {
            this.logger.error(`Error sending notification for ${result.symbol}:`, error);
        }
    }

    /**
     * Format Telegram message
     */
    private formatTelegramMessage(result: SignalResult): string {
        const emoji = result.action === 'LONG' ? '🟢' : '🔴';
        const confEmoji = result.confidenceLevel === 'HIGH' ? '🔥' : result.confidenceLevel === 'MEDIUM' ? '✅' : '⚠️';

        const slPct = result.entryPrice > 0
            ? ((result.sl - result.entryPrice) / result.entryPrice * 100).toFixed(2)
            : '0';
        const tp1Pct = result.tpPct[0]?.toFixed(2) || '0';

        return `
${emoji} <b>SIGNAL: ${result.symbol}</b> ${emoji}

📊 <b>Action:</b> ${result.action} ${confEmoji}
🎯 <b>Confidence:</b> ${(result.confidence * 100).toFixed(0)}% (${result.confidenceLevel})

📍 <b>Entry:</b> $${result.entryPrice.toFixed(2)} (${result.entryType})
🛑 <b>SL:</b> $${result.sl.toFixed(2)} (${slPct}%)
🎯 <b>TP1:</b> $${result.tp[0]?.toFixed(2) || '-'} (+${tp1Pct}%)

📈 <b>Модули:</b>
• Orderflow: ${result.modules.orderflow.toFixed(2)}
• OI: ${result.modules.oi.toFixed(2)}
• Momentum: ${result.modules.momentum.toFixed(2)}
• Levels: ${result.modules.levels.toFixed(2)}

🏷️ <b>Теги:</b> ${result.reasonTags.slice(0, 5).join(', ')}

<i>Auto Signal Scanner</i>
        `.trim();
    }

    /**
     * Save analysis result to database
     */
    private async saveToDatabase(signalResult: SignalResult): Promise<void> {
        try {
            const analizationResult = this.mapToAnalizationResult(signalResult);
            await this.analizationResultRepository.save(analizationResult);
            this.logger.debug(`Saved analysis result for ${signalResult.symbol} to database`);
        } catch (error) {
            this.logger.error(`Error saving analysis result for ${signalResult.symbol}:`, error);
        }
    }

    /**
     * Map SignalResult to AnalizationResult entity
     */
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
        result.meta = {
            rawScore: signalResult.meta.rawScore,
            moduleAgreement: signalResult.meta.moduleAgreement
        };

        return result;
    }

    /**
     * Ensure log directory exists
     */
    private ensureLogDir(): void {
        if (!fs.existsSync(this.config.logDir)) {
            fs.mkdirSync(this.config.logDir, { recursive: true });
            this.logger.info(`Created log directory: ${this.config.logDir}`);
        }
    }
}
