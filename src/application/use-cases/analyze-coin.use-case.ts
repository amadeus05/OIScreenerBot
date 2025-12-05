/**
 * Analyze Coin Use Case
 * 
 * Application layer use case for analyzing a coin.
 * Validates input and delegates to CoinAnalyzer.
 */

import { Injectable, Inject } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { ICoinAnalyzer } from '../../domain/coin-analyzer/interfaces';
import { IMarketDataRepository } from '../../domain/interfaces/services.interface';
import { CoinAnalysisDto } from '../dto/coin-analysis.dto';

@Injectable()
export class AnalyzeCoinUseCase {
    private readonly logger = new Logger(AnalyzeCoinUseCase.name);

    constructor(
        @Inject('ICoinAnalyzer')
        private readonly coinAnalyzer: ICoinAnalyzer,
        @Inject('IMarketDataRepository')
        private readonly marketDataRepo: IMarketDataRepository,
    ) { }

    /**
     * Execute coin analysis.
     * 
     * @param symbol Symbol to analyze (e.g., 'BTCUSDT')
     * @returns Analysis result DTO
     * @throws Error if symbol not found or insufficient data
     */
    async execute(symbol: string): Promise<CoinAnalysisDto> {
        // Normalize symbol
        const normalizedSymbol = this.normalizeSymbol(symbol);

        // Validate symbol exists
        const knownSymbols = this.marketDataRepo.getAllKnownSymbols();
        if (!knownSymbols.includes(normalizedSymbol)) {
            throw new Error(`Symbol ${normalizedSymbol} not found. Make sure the bot is tracking this pair.`);
        }

        // Check if we have enough data
        if (!this.marketDataRepo.isWarm(normalizedSymbol)) {
            throw new Error(`Not enough data for ${normalizedSymbol}. Please wait for more candles to accumulate.`);
        }

        this.logger.info(`Executing analysis for ${normalizedSymbol}`);

        // Perform analysis
        const result = await this.coinAnalyzer.analyze(normalizedSymbol);

        // Convert to DTO
        return CoinAnalysisDto.fromResult(result);
    }

    /**
     * Normalize symbol format.
     */
    private normalizeSymbol(symbol: string): string {
        let normalized = symbol.toUpperCase().trim();

        // Add USDT if not present
        if (!normalized.endsWith('USDT') && !normalized.endsWith('BUSD')) {
            normalized += 'USDT';
        }

        return normalized;
    }
}
