/**
 * Coin Analyzer Coordinator
 * 
 * Main orchestrator for the coin analysis system.
 * Coordinates filters, strategies, and core services to produce
 * a comprehensive analysis result.
 */

import { Injectable, Inject } from '../../shared/decorators';
import { Logger } from '../../shared/logger';
import { IMarketDataRepository } from '../interfaces/services.interface';
import { SmartCandle } from '../interfaces/market-data.interface';

import {
    ICoinAnalyzer,
    IAnalysisFilter,
    IEntryStrategy,
    IDirectionResolver,
    IEntryTimingResolver,
    IStopLossCalculator,
    IConfidenceScorer,
    IMultiTimeframeService,
} from './interfaces';

import {
    AnalysisContext,
    CoinAnalysisResult,
    ComponentWeights,
    MarketRegime,
    TradeDirection,
    TrendDirection,
    BTCReferenceData,
} from './types';

@Injectable()
export class CoinAnalyzerCoordinator implements ICoinAnalyzer {
    private readonly logger = new Logger(CoinAnalyzerCoordinator.name);

    private filters: IAnalysisFilter[] = [];
    private strategies: IEntryStrategy[] = [];

    constructor(
        @Inject('IMarketDataRepository')
        private readonly marketDataRepo: IMarketDataRepository,
        private readonly multiTFService: IMultiTimeframeService,
        private readonly directionResolver: IDirectionResolver,
        private readonly entryTimingResolver: IEntryTimingResolver,
        private readonly stopLossCalculator: IStopLossCalculator,
        private readonly confidenceScorer: IConfidenceScorer,
    ) { }

    registerFilter(filter: IAnalysisFilter): void {
        this.filters.push(filter);
        this.logger.info(`Registered filter: ${filter.name}`);
    }

    registerStrategy(strategy: IEntryStrategy): void {
        this.strategies.push(strategy);
        this.logger.info(`Registered strategy: ${strategy.name}`);
    }

    async analyze(symbol: string): Promise<CoinAnalysisResult> {
        this.logger.info(`Starting analysis for ${symbol}`);
        const startTime = Date.now();

        // 1. Build analysis context
        const context = await this.buildContext(symbol);

        // 2. Run all filters in parallel
        const filterResults = await Promise.all(
            this.filters.map(filter => filter.analyze(context))
        );

        // Check if any critical filter failed
        const criticalFailure = filterResults.some(r => !r.passed && r.confidence > 0.8);

        // 3. Run all strategies in parallel
        const strategyResults = await Promise.all(
            this.strategies.map(strategy => strategy.evaluate(context))
        );

        // 4. Resolve direction
        const directionResult = this.directionResolver.resolve(strategyResults);

        // 5. Determine if we should trade
        const allFiltersPassed = filterResults.every(r => r.passed);
        const shouldTrade = allFiltersPassed && directionResult.direction !== TradeDirection.NEUTRAL;

        // 6. Calculate entry timing
        const entryTiming = this.entryTimingResolver.resolve(context, directionResult.direction);

        // 7. Calculate stop loss
        const stopLoss = this.stopLossCalculator.calculate(
            context,
            directionResult.direction,
            context.currentPrice
        );

        // 8. Calculate confidence
        const confidence = this.confidenceScorer.calculate(filterResults, strategyResults);

        // 9. Determine market regime
        const marketRegime = this.determineMarketRegime(context);

        // 10. Build result
        const result: CoinAnalysisResult = {
            symbol,
            timestamp: new Date(),
            direction: directionResult.direction,
            confidence,
            shouldTrade,

            entryPrice: context.currentPrice,
            stopLoss,
            entryTiming,

            marketRegime,
            trendAlignment: {
                tf5m: context.multiTF.tf5m.trend,
                tf15m: context.multiTF.tf15m.trend,
                tf1h: context.multiTF.tf1h.trend,
                aligned: this.isTrendAligned(context),
            },

            filterResults,
            strategyResults,

            summary: this.buildSummary(shouldTrade, directionResult, confidence, criticalFailure),
        };

        const elapsed = Date.now() - startTime;
        this.logger.info(`Analysis complete for ${symbol} in ${elapsed}ms: ${result.direction} (${confidence.toFixed(1)}%)`);

        return result;
    }

    getWeights(): ComponentWeights {
        const filterWeights: Record<string, number> = {};
        const strategyWeights: Record<string, number> = {};

        for (const filter of this.filters) {
            filterWeights[filter.name] = filter.weight;
        }

        for (const strategy of this.strategies) {
            strategyWeights[strategy.name] = strategy.weight;
        }

        return {
            filters: filterWeights,
            strategies: strategyWeights,
            lastUpdated: new Date(),
        };
    }

    updateWeights(weights: ComponentWeights): void {
        for (const filter of this.filters) {
            if (weights.filters[filter.name] !== undefined) {
                filter.weight = weights.filters[filter.name];
            }
        }

        for (const strategy of this.strategies) {
            if (weights.strategies[strategy.name] !== undefined) {
                strategy.weight = weights.strategies[strategy.name];
            }
        }

        this.logger.info('Weights updated');
    }

    /**
     * Build full analysis context from market data.
     */
    private async buildContext(symbol: string): Promise<AnalysisContext> {
        const rawCandles = this.marketDataRepo.getHistory(symbol, 1000);
        const currentPrice = this.marketDataRepo.getCurrentPrice(symbol);

        // Build multi-timeframe data
        const multiTF = await this.multiTFService.buildMultiTimeframeData(symbol);

        // Get BTC data for correlation
        const btcData = this.getBTCReferenceData();

        // Get current funding rate (from latest candle)
        const lastCandle = rawCandles[rawCandles.length - 1];
        const fundingRate = lastCandle?.futures.funding || 0;

        // Calculate liquidations from last hour
        const liquidations = this.calculateLiquidations(rawCandles, 60);

        // Calculate OI metrics
        const openInterest = this.calculateOIMetrics(rawCandles, 60);

        // Calculate CVD metrics
        const cvd = this.calculateCVDMetrics(rawCandles, 60);

        return {
            symbol,
            currentPrice,
            timestamp: Date.now(),
            rawCandles,
            multiTF,
            btcData,
            fundingRate,
            liquidations,
            openInterest,
            cvd,
        };
    }

    /**
     * Get BTC reference data.
     */
    private getBTCReferenceData(): BTCReferenceData {
        const btcCandles = this.marketDataRepo.getHistory('BTCUSDT', 1000);
        const currentPrice = this.marketDataRepo.getCurrentPrice('BTCUSDT');

        // Calculate price changes
        let priceChange1h = 0;
        let priceChange24h = 0;

        if (btcCandles.length >= 60) {
            const hourAgoPrice = btcCandles[btcCandles.length - 60].ohlc.c;
            priceChange1h = ((currentPrice - hourAgoPrice) / hourAgoPrice) * 100;
        }

        if (btcCandles.length >= 1000) {
            const dayAgoPrice = btcCandles[0].ohlc.c;
            priceChange24h = ((currentPrice - dayAgoPrice) / dayAgoPrice) * 100;
        }

        return {
            currentPrice,
            priceChange1h,
            priceChange24h,
            candles: btcCandles,
        };
    }

    /**
     * Calculate liquidations over a window.
     */
    private calculateLiquidations(candles: SmartCandle[], windowMinutes: number) {
        const window = candles.slice(-windowMinutes);

        let longTotal = 0;
        let shortTotal = 0;

        for (const candle of window) {
            longTotal += candle.orderFlow.liquidations.long;
            shortTotal += candle.orderFlow.liquidations.short;
        }

        const ratio = shortTotal > 0 ? longTotal / shortTotal : (longTotal > 0 ? Infinity : 1);

        return { longTotal, shortTotal, ratio };
    }

    /**
     * Calculate OI metrics over a window.
     */
    private calculateOIMetrics(candles: SmartCandle[], windowMinutes: number) {
        if (candles.length < windowMinutes) {
            return { current: 0, change1h: 0, changePercent1h: 0 };
        }

        const hourAgoIndex = Math.max(0, candles.length - windowMinutes);
        const current = candles[candles.length - 1].futures.oi;
        const hourAgo = candles[hourAgoIndex].futures.oi;

        const change1h = current - hourAgo;
        const changePercent1h = hourAgo > 0 ? (change1h / hourAgo) * 100 : 0;

        return { current, change1h, changePercent1h };
    }

    /**
     * Calculate CVD metrics over a window.
     */
    private calculateCVDMetrics(candles: SmartCandle[], windowMinutes: number) {
        if (candles.length < windowMinutes) {
            return { current: 0, delta1h: 0 };
        }

        const hourAgoIndex = Math.max(0, candles.length - windowMinutes);
        const current = candles[candles.length - 1].orderFlow.cvd;
        const hourAgo = candles[hourAgoIndex].orderFlow.cvd;

        return { current, delta1h: current - hourAgo };
    }

    /**
     * Determine market regime from context.
     */
    private determineMarketRegime(context: AnalysisContext): MarketRegime {
        const tf15m = context.multiTF.tf15m;
        const atrPercent = (tf15m.atr / context.currentPrice) * 100;

        // Check volatility first
        if (atrPercent > 5) return MarketRegime.HIGH_VOLATILITY;
        if (atrPercent < 0.3) return MarketRegime.LOW_LIQUIDITY;

        // Check trend
        if (tf15m.trend === TrendDirection.UP) return MarketRegime.TRENDING_UP;
        if (tf15m.trend === TrendDirection.DOWN) return MarketRegime.TRENDING_DOWN;

        return MarketRegime.RANGING;
    }

    /**
     * Check if all timeframes are trending in the same direction.
     */
    private isTrendAligned(context: AnalysisContext): boolean {
        const tf5m = context.multiTF.tf5m.trend;
        const tf15m = context.multiTF.tf15m.trend;
        const tf1h = context.multiTF.tf1h.trend;

        // All UP or all DOWN
        return (
            (tf5m === TrendDirection.UP && tf15m === TrendDirection.UP && tf1h === TrendDirection.UP) ||
            (tf5m === TrendDirection.DOWN && tf15m === TrendDirection.DOWN && tf1h === TrendDirection.DOWN)
        );
    }

    /**
     * Build human-readable summary.
     */
    private buildSummary(
        shouldTrade: boolean,
        directionResult: { direction: TradeDirection; confidence: number; reason: string },
        confidence: number,
        criticalFailure: boolean
    ): string {
        if (criticalFailure) {
            return '⛔ Critical filter failed - do not trade';
        }

        if (!shouldTrade) {
            return '⚠️ Conditions not favorable for trading';
        }

        const arrow = directionResult.direction === TradeDirection.LONG ? '🟢 LONG' : '🔴 SHORT';
        return `${arrow} with ${confidence.toFixed(1)}% confidence. ${directionResult.reason}`;
    }
}
