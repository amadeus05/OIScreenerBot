// ========================================================================
// FILE: src/domain/signal-analyzer/signal-analyzer.service.ts
// ========================================================================

import { Logger } from '../../shared/logger';
import { Inject } from '../../shared/decorators'; // <-- Inject decorator
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
import { BaseModule } from './modules';
import { MarketContext } from './types/context';
import { AnalysisContext } from './modules/base-module'; // <-- Import interface

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

    // Data storage
    private symbolAggregators = new Map<string, TimeframeAggregator>();
    private symbolFeatureEngines = new Map<string, FeatureEngine>();

    // Modules (Injected via DI)
    constructor(
        @Inject('IModules') private readonly modules: BaseModule[], // <-- DI INJECTION
        config: SignalAnalyzerConfig = DEFAULT_CONFIG
    ) {
        this.config = config;
        
        // Initialize Core Services
        this.aggregator = new TimeframeAggregator();
        this.featureEngine = new FeatureEngine(config);
        this.decisionAggregator = new DecisionAggregator(config.weights, config.decision.threshold);
        this.confidenceCalculator = new ConfidenceCalculator(config.decision.threshold);
        this.entryCalculator = new EntryCalculator();
        this.regimeSupervisor = new RegimeSupervisor(config.weights);

        this.logger.info(`SignalAnalyzerService initialized with ${this.modules.length} modules.`);
    }

    public analyze(symbol: string, bars: BarData[], marketContext?: MarketContext): SignalResult {
        if (bars.length < 50) return this.noTradeResult(symbol, 'Insufficient data');

        try {
            // 1. Prepare Data
            const aggregator = this.getOrCreateAggregator(symbol);
            bars.forEach(b => aggregator.addBar(b));
            
            const bars1m = aggregator.getBars('1m', 100) as BarData[];
            const featureEngine = this.getOrCreateFeatureEngine(symbol);
            const features = featureEngine.computeFeatures(bars1m);
            const currentPrice = bars1m[bars1m.length - 1].c;

            // 2. Regime Analysis (Scenario-based)
            const regimeAnalysis = this.regimeSupervisor.analyze(features, currentPrice);
            this.decisionAggregator.setWeights(regimeAnalysis.adjustedWeights);

            // 3. Build Full Context for Modules
            const analysisContext: AnalysisContext = {
                regime: regimeAnalysis.regime,
                globalTrend: marketContext?.globalTrend || 'FLAT',
                currentPrice: currentPrice
            };

            // 4. Run Modules (with Context)
            const moduleOutputs = this.runModules(features, bars1m, analysisContext);

            // 5. Aggregate
            const aggregation = this.decisionAggregator.aggregate(moduleOutputs, features, marketContext);

            if (aggregation.action === 'NO_TRADE') {
                const reason = aggregation.vetoReason ? `Veto: ${aggregation.vetoReason}` : 'Below threshold';
                return this.noTradeResult(symbol, reason, aggregation.rawScore, moduleOutputs);
            }

            // 6. Confidence & Entry
            const nearStrongLevel = this.checkNearStrongLevel(moduleOutputs);
            const confidenceResult = this.confidenceCalculator.calculate(aggregation, features, nearStrongLevel);

            if (confidenceResult.confidence < this.config.position.minConfidence) {
                return this.noTradeResult(symbol, 'Low confidence', aggregation.rawScore, moduleOutputs);
            }

            const entryResult = this.entryCalculator.calculate(
                aggregation.action, bars1m, features, confidenceResult.confidence, regimeAnalysis.regime
            );

            if (!entryResult.isValid) {
                return this.noTradeResult(symbol, entryResult.reason || 'Invalid Entry', aggregation.rawScore, moduleOutputs);
            }

            // 7. Final Result
            const reasonTags = this.decisionAggregator.collectReasonTags(moduleOutputs);
            reasonTags.push(`REGIME_${regimeAnalysis.regime}`);
            if (aggregation.vetoReason) reasonTags.push(aggregation.vetoReason);
            reasonTags.push(...confidenceResult.penaltyReasons);

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
                marketRegime: regimeAnalysis.regime,
                meta: {
                    rawScore: aggregation.rawScore,
                    moduleAgreement: aggregation.moduleAgreement,
                    regime: regimeAnalysis.regime,
                    globalTrend: marketContext?.globalTrend || 'UNKNOWN'
                },
            };

            this.logger.debug(`Signal: ${symbol} ${result.action} [${regimeAnalysis.regime}]`);
            return result;

        } catch (error) {
            this.logger.error(`Error analyzing ${symbol}:`, error);
            return this.noTradeResult(symbol, 'Analysis error');
        }
    }

    public warmUp(symbol: string, bars: BarData[]): void {
        if (bars.length < 20) return;
        
        const aggregator = this.getOrCreateAggregator(symbol);
        const featureEngine = this.getOrCreateFeatureEngine(symbol);

        // Reset modules that have state
        this.modules.forEach(m => {
            if ('reset' in m && typeof (m as any).reset === 'function') (m as any).reset();
        });
        featureEngine.reset();

        // Replay history
        const minBars = 20;
        for (let i = minBars; i <= bars.length; i++) {
            const slice = bars.slice(0, i);
            const currentBar = slice[slice.length - 1];
            aggregator.addBar(currentBar);
            const features = featureEngine.computeFeatures(slice);
            
            // Analyze last 50 bars to warm up module internal states (e.g. Levels)
            if (i > bars.length - 50) {
                 this.runModules(features, slice, { regime: 'RANGING', globalTrend: 'FLAT', currentPrice: currentBar.c });
            }
        }
    }

    public isWarmedUp(symbol: string): boolean {
        return this.symbolFeatureEngines.has(symbol) && this.symbolAggregators.has(symbol);
    }

    public clearSymbol(symbol: string): void {
        this.symbolAggregators.delete(symbol);
        this.symbolFeatureEngines.delete(symbol);
    }

    // --- Private ---

    private runModules(features: Features, bars: (BarData | AggregatedBar)[], context: AnalysisContext): ModuleOutput[] {
        const outputs: ModuleOutput[] = [];
        for (const module of this.modules) {
            try {
                // Pass context to modules!
                const output = module.analyze(features, bars, context);
                outputs.push(output);
            } catch (error) {
                this.logger.error(`Module ${module.name} error:`, error);
                outputs.push({ name: module.name, score: 0, reliability: 0, tags: ['module_error'] });
            }
        }
        return outputs;
    }

    private checkNearStrongLevel(moduleOutputs: ModuleOutput[]): boolean {
        const levelsOutput = moduleOutputs.find(m => m.name === 'levels');
        if (!levelsOutput) return false;
        return levelsOutput.tags.some(t =>
            t.includes('strong_level') || t.includes('at_resistance') || t.includes('at_support')
        );
    }

    private getOrCreateAggregator(symbol: string): TimeframeAggregator {
        let aggregator = this.symbolAggregators.get(symbol);
        if (!aggregator) {
            aggregator = new TimeframeAggregator();
            this.symbolAggregators.set(symbol, aggregator);
        }
        return aggregator;
    }

    private getOrCreateFeatureEngine(symbol: string): FeatureEngine {
        let engine = this.symbolFeatureEngines.get(symbol);
        if (!engine) {
            engine = new FeatureEngine(this.config);
            this.symbolFeatureEngines.set(symbol, engine);
        }
        return engine;
    }

    private noTradeResult(symbol: string, reason: string, rawScore: number = 0, moduleOutputs: ModuleOutput[] = []): SignalResult {
        const moduleScores: Record<ModuleName, number> = {
            momentum: 0, orderflow: 0, oi: 0, liquidations: 0, levels: 0,
        };
        for (const output of moduleOutputs) moduleScores[output.name] = output.score;

        return {
            ts: new Date().toISOString(),
            symbol,
            action: 'NO_TRADE',
            entryType: 'market',
            entryPrice: 0, sl: 0, tp: [], tpPct: [], horizonMin: 0,
            confidence: 0, confidenceLevel: 'LOW',
            modules: moduleScores,
            reasonTags: [reason],
            riskPct: 0,
            meta: { rawScore, moduleAgreement: 0, reason },
        };
    }
}