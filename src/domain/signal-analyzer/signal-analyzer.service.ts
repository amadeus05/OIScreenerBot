/**
 * Signal Analyzer Module - Main Service
 * Orchestrates the complete signal analysis workflow
 */

import { Logger } from '../../shared/logger';
import {
    BarData,
    SignalResult,
    ModuleOutput,
    SignalAnalyzerConfig,
    DEFAULT_CONFIG,
    Features,
    AggregatedBar,
    ModuleName,
} from './types';
import {
    TimeframeAggregator,
    FeatureEngine,
    DecisionAggregator,
    ConfidenceCalculator,
    EntryCalculator,
    RegimeSupervisor
} from './services';
import {
    MomentumModule,
    OrderflowModule,
    OIModule,
    LiquidationModule,
    LevelsModule,
    BaseModule,
} from './modules';

/**
 * Main Signal Analyzer Service
 * Coordinates all components to produce trading signals
 */
export class SignalAnalyzerService {
    private readonly logger = new Logger('SignalAnalyzer');
    private readonly config: SignalAnalyzerConfig;

    // Components
    private readonly aggregator: TimeframeAggregator;
    private readonly featureEngine: FeatureEngine;
    private readonly decisionAggregator: DecisionAggregator;
    private readonly confidenceCalculator: ConfidenceCalculator;
    private readonly entryCalculator: EntryCalculator;
    private readonly regimeSupervisor: RegimeSupervisor;

    // Modules
    private readonly modules: BaseModule[];
    private readonly levelsModule: LevelsModule;

    // Data storage per symbol
    private symbolAggregators = new Map<string, TimeframeAggregator>();
    private symbolFeatureEngines = new Map<string, FeatureEngine>();

    constructor(config: SignalAnalyzerConfig = DEFAULT_CONFIG) {
        this.config = config;

        // Initialize components
        this.aggregator = new TimeframeAggregator();
        this.featureEngine = new FeatureEngine(config);
        this.decisionAggregator = new DecisionAggregator(
            config.weights,
            config.decision.threshold
        );
        this.confidenceCalculator = new ConfidenceCalculator(config.decision.threshold);
        this.entryCalculator = new EntryCalculator();
        this.regimeSupervisor = new RegimeSupervisor(config.weights);

        // Initialize modules
        this.levelsModule = new LevelsModule();
        this.modules = [
            new MomentumModule(),
            new OrderflowModule(),
            new OIModule(),
            new LiquidationModule(),
            this.levelsModule,
        ];

        this.logger.info('SignalAnalyzerService initialized');
    }

    /**
     * Analyze a symbol and generate a trading signal
     * @param symbol Trading pair symbol (e.g., 'BTCUSDT')
     * @param bars Recent 1m bar history (newest last)
     * @returns Signal result with trade recommendation
     */
    analyze(symbol: string, bars: BarData[]): SignalResult {
        if (bars.length < 50) {
            this.logger.warn(`Not enough bars for analysis: ${bars.length} < 20`);
            return this.noTradeResult(symbol, 'Insufficient data');
        }

        try {
            // 1. Get or create aggregator for this symbol
            const aggregator = this.getOrCreateAggregator(symbol);

            // 2. Update aggregator with all bars
            for (const bar of bars) {
                aggregator.addBar(bar);
            }

            // 3. Get multi-timeframe data
            const bars1m = aggregator.getBars('1m', 100) as BarData[];
            const bars5m = aggregator.getBars('5m', 30);
            const bars15m = aggregator.getBars('15m', 15);

            // 4. Compute features for 1m timeframe (primary)
            const featureEngine = this.getOrCreateFeatureEngine(symbol);
            const features = featureEngine.computeFeatures(bars1m);

            // 4.1. Determine Market Regime & Adjust Weights
            const currentPrice = bars1m[bars1m.length - 1].c;
            const regimeAnalysis = this.regimeSupervisor.analyze(features, currentPrice);

            // Динамически обновляем веса в агрегаторе перед принятием решения
            this.decisionAggregator.setWeights(regimeAnalysis.adjustedWeights);

            // 5. Run all analysis modules
            const moduleOutputs = this.runModules(features, bars1m);

            // 6. Aggregate module scores
            // [FIX] Передаем features вторым аргументом для "Умной фильтрации" (Veto)
            const aggregation = this.decisionAggregator.aggregate(moduleOutputs, features);

            // 7. If NO_TRADE, return early
            if (aggregation.action === 'NO_TRADE') {
                // Если был VetoReason, добавляем его в причину
                const reason = aggregation.vetoReason ? `Veto: ${aggregation.vetoReason}` : 'Below threshold';
                return this.noTradeResult(symbol, reason, aggregation.rawScore, moduleOutputs);
            }

            // 8. Calculate confidence with penalties
            const nearStrongLevel = this.checkNearStrongLevel(moduleOutputs);
            const confidenceResult = this.confidenceCalculator.calculate(
                aggregation,
                features,
                nearStrongLevel
            );

            // 9. Check minimum confidence
            if (confidenceResult.confidence < this.config.position.minConfidence) {
                return this.noTradeResult(symbol, 'Low confidence', aggregation.rawScore, moduleOutputs);
            }

            // 10. Calculate entry/SL/TP
            // [FIX] Передаем режим рынка (regime) для адаптивных стопов и тейков
            const entryResult = this.entryCalculator.calculate(
                aggregation.action,
                bars1m,
                features,
                confidenceResult.confidence,
                regimeAnalysis.regime
            );

            // 11. Collect all tags
            const reasonTags = this.decisionAggregator.collectReasonTags(moduleOutputs);
            
            // Добавляем теги режима и причины Veto/Flip
            reasonTags.push(`REGIME_${regimeAnalysis.regime}`);
            if (aggregation.vetoReason) {
                reasonTags.push(aggregation.vetoReason);
            }
            if (confidenceResult.penaltyReasons.length > 0) {
                reasonTags.push(...confidenceResult.penaltyReasons);
            }

            // 12. Build final result
            const result: SignalResult = {
                ts: new Date().toISOString(),
                symbol,
                action: aggregation.action,
                entryType: entryResult.entryType,
                entryPrice: entryResult.entryPrice,
                sl: entryResult.sl,
                tp: entryResult.tp,
                tpPct: entryResult.tpPct,
                horizonMin: entryResult.horizonMin,
                confidence: confidenceResult.confidence,
                confidenceLevel: confidenceResult.confidenceLevel,
                modules: this.decisionAggregator.getModuleScoresRecord(moduleOutputs),
                reasonTags,
                riskPct: entryResult.riskPct,
                meta: {
                    rawScore: aggregation.rawScore,
                    moduleAgreement: aggregation.moduleAgreement,
                    penalties: confidenceResult.penalties,
                    atr: features.atr,
                    volZ: features.volZ,
                    flowImb: features.flowImb,
                    regime: regimeAnalysis.regime // Полезно для отладки
                },
            };

            this.logger.debug(`Signal generated for ${symbol}: ${result.action} @ ${result.confidence.toFixed(2)} [${regimeAnalysis.regime}]`);
            return result;

        } catch (error) {
            this.logger.error(`Error analyzing ${symbol}:`, error);
            return this.noTradeResult(symbol, 'Analysis error');
        }
    }

    /**
     * Warm up stateful components with historical data
     * This must be called BEFORE analyze() for accurate results
     * 
     * @param symbol Trading pair symbol
     * @param bars Historical bars (oldest first, newest last)
     */
    warmUp(symbol: string, bars: BarData[]): void {
        if (bars.length < 20) {
            this.logger.warn(`Not enough bars for warm-up: ${bars.length} < 20`);
            return;
        }

        this.logger.info(`Warming up ${symbol} with ${bars.length} bars...`);

        // Get or create components for this symbol
        const aggregator = this.getOrCreateAggregator(symbol);
        const featureEngine = this.getOrCreateFeatureEngine(symbol);

        // Reset modules to ensure clean state
        for (const module of this.modules) {
            if ('reset' in module && typeof (module as any).reset === 'function') {
                (module as any).reset();
            }
        }
        featureEngine.reset();

        // Process bars one by one to build up state
        // Start from minimum required bars (20) and grow the window
        const minBars = 20;

        for (let i = minBars; i <= bars.length; i++) {
            const slice = bars.slice(0, i);
            const currentBar = slice[slice.length - 1];

            // Add bar to aggregator
            aggregator.addBar(currentBar);

            // Compute features (this updates RollingStats internally)
            const features = featureEngine.computeFeatures(slice);

            // Run modules to build their internal state (only on last few bars to save time)
            // Full module analysis only for last 50 bars, minimal processing for earlier
            if (i > bars.length - 50) {
                for (const module of this.modules) {
                    try {
                        module.analyze(features, slice);
                    } catch (error) {
                        // Silently ignore errors during warm-up
                    }
                }
            }
        }

        this.logger.info(`Warm-up complete for ${symbol}. State initialized with ${bars.length} bars.`);
    }

    /**
     * Check if a symbol has warmed up state
     */
    isWarmedUp(symbol: string): boolean {
        return this.symbolFeatureEngines.has(symbol) && this.symbolAggregators.has(symbol);
    }

    /**
     * Run all analysis modules
     */
    private runModules(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput[] {
        const outputs: ModuleOutput[] = [];

        for (const module of this.modules) {
            try {
                const output = module.analyze(features, bars);
                outputs.push(output);
            } catch (error) {
                this.logger.error(`Module ${module.name} error:`, error);
                // Add neutral output on error
                outputs.push({
                    name: module.name,
                    score: 0,
                    reliability: 0,
                    tags: ['module_error'],
                });
            }
        }

        return outputs;
    }

    /**
     * Check if price is near a strong level
     */
    private checkNearStrongLevel(moduleOutputs: ModuleOutput[]): boolean {
        const levelsOutput = moduleOutputs.find(m => m.name === 'levels');
        if (!levelsOutput) return false;
        return levelsOutput.tags.some(t =>
            t.includes('strong_level') || t.includes('at_resistance') || t.includes('at_support')
        );
    }

    /**
     * Get or create aggregator for a symbol
     */
    private getOrCreateAggregator(symbol: string): TimeframeAggregator {
        let aggregator = this.symbolAggregators.get(symbol);
        if (!aggregator) {
            aggregator = new TimeframeAggregator();
            this.symbolAggregators.set(symbol, aggregator);
        }
        return aggregator;
    }

    /**
     * Get or create feature engine for a symbol
     */
    private getOrCreateFeatureEngine(symbol: string): FeatureEngine {
        let engine = this.symbolFeatureEngines.get(symbol);
        if (!engine) {
            engine = new FeatureEngine(this.config);
            this.symbolFeatureEngines.set(symbol, engine);
        }
        return engine;
    }

    /**
     * Create NO_TRADE result
     */
    private noTradeResult(
        symbol: string,
        reason: string,
        rawScore: number = 0,
        moduleOutputs: ModuleOutput[] = []
    ): SignalResult {
        const moduleScores: Record<ModuleName, number> = {
            momentum: 0,
            orderflow: 0,
            oi: 0,
            liquidations: 0,
            levels: 0,
        };

        for (const output of moduleOutputs) {
            moduleScores[output.name] = output.score;
        }

        return {
            ts: new Date().toISOString(),
            symbol,
            action: 'NO_TRADE',
            entryType: 'market',
            entryPrice: 0,
            sl: 0,
            tp: [],
            tpPct: [],
            horizonMin: 0,
            confidence: 0,
            confidenceLevel: 'LOW',
            modules: moduleScores,
            reasonTags: [reason],
            riskPct: 0,
            meta: {
                rawScore,
                moduleAgreement: 0,
                reason,
            },
        };
    }

    /**
     * Clear cached data for a symbol
     */
    clearSymbol(symbol: string): void {
        this.symbolAggregators.delete(symbol);
        this.symbolFeatureEngines.delete(symbol);
    }

    /**
     * Clear all cached data
     */
    clearAll(): void {
        this.symbolAggregators.clear();
        this.symbolFeatureEngines.clear();
        this.levelsModule.reset();
    }

    /**
     * Get detected levels for a symbol (debugging)
     */
    getLevels(): { supports: any[]; resistances: any[] } {
        return this.levelsModule.getLevels();
    }
}

export default SignalAnalyzerService;