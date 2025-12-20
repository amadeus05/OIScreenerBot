// ========================================================================
// FILE: src/domain/signal-analyzer/signal-analyzer.service.ts
// ========================================================================

import { Logger } from '../../shared/logger';
import { Inject } from '../../shared/decorators';
import {
    BarData,
    SignalResult,
    ModuleOutput,
    SignalAnalyzerConfig,
    DEFAULT_CONFIG,
    Features,
    AggregatedBar,
} from './types';
import {
    TimeframeAggregator,
    FeatureEngine,
    DecisionAggregator,
    EntryCalculator,
    RegimeSupervisor
} from './services';
import { BaseModule } from './modules';
import { MarketContext } from './types/context';
import { AnalysisContext } from './modules/base-module';
import { TradeGatekeeper } from './gatekeeper/trade-gatekeeper';
import { GateContext } from './gatekeeper/types';

export class SignalAnalyzerService {
    private readonly logger = new Logger('SignalAnalyzer');
    private readonly config: SignalAnalyzerConfig;

    // --- Core Services ---
    private readonly aggregator: TimeframeAggregator;
    private readonly featureEngine: FeatureEngine;
    private readonly decisionAggregator: DecisionAggregator;
    private readonly entryCalculator: EntryCalculator;
    private readonly regimeSupervisor: RegimeSupervisor;
    private readonly gatekeeper: TradeGatekeeper;

    // --- State ---
    private symbolAggregators = new Map<string, TimeframeAggregator>();
    private symbolFeatureEngines = new Map<string, FeatureEngine>();
    private lastSignalTimes = new Map<string, number>();

    constructor(
        @Inject('IModules') private readonly modules: BaseModule[],
        @Inject('TradeGatekeeper') gatekeeper: TradeGatekeeper,
        config: SignalAnalyzerConfig = DEFAULT_CONFIG
    ) {
        this.config = config;
        this.gatekeeper = gatekeeper;

        this.aggregator = new TimeframeAggregator();
        this.featureEngine = new FeatureEngine(config);
        this.decisionAggregator = new DecisionAggregator(config.weights, config.decision.threshold);
        this.entryCalculator = new EntryCalculator(config);
        this.regimeSupervisor = new RegimeSupervisor(config.weights);

        this.logger.info(`✅ SignalAnalyzerService started with ${this.modules.length} modules.`);
    }

    /**
     * Main analysis method.
     * @param currentBalance - Текущий баланс портфеля (для точного расчета риск-менеджмента)
     */
    public analyze(
        symbol: string, 
        bars: BarData[], 
        marketContext?: MarketContext,
        currentBalance?: number // <--- 1. НОВЫЙ АРГУМЕНТ
    ): SignalResult {
        try {
            // === ЗАЩИТА ОТ МУСОРНЫХ МОНЕТ ===
            // Защита от мусорных монет (работает и в тесте, и в лайве)
            if (bars.length > 0) {
                const lastBar = bars[bars.length - 1];
                const minuteVolumeUsd = lastBar.v * lastBar.c; // Объем последней свечи в $
                
                // Если объем меньше 50k$ за минуту — до свидания
                // (Для BTC/ETH это копейки, для щиткоинов — фильтр от "мертвого" рынка)
                if (minuteVolumeUsd < 50_000) {
                    return this.createEmptyResult(symbol, 'Low Liquidity Filter');
                }
            }
            // ================================

            // 1. Data Aggregation
            const aggregator = this.getOrCreateAggregator(symbol);
            const lastTs = aggregator.getLastTs();
            const newBars = bars.filter(b => b.ts > lastTs);
            
            if (newBars.length === 0 && bars.length > 0) {
                const lastInput = bars[bars.length - 1];
                if (lastInput.ts === lastTs) {
                    aggregator.addBar(lastInput); 
                }
            } else {
                newBars.forEach(b => aggregator.addBar(b));
            }

            // 2. Data Checks
            const barCounts = aggregator.getBarCounts();
            if (barCounts.bars1m < 50) {
                return this.createEmptyResult(symbol, 'Insufficient data');
            }

            const bars1m = aggregator.getBars('1m', 120) as BarData[];
            const featureEngine = this.getOrCreateFeatureEngine(symbol);
            const features = featureEngine.computeFeatures(bars1m);
            const currentPrice = bars1m[bars1m.length - 1].c;
            const currentTs = bars1m[bars1m.length - 1].ts;

            // 3. Regime
            const regimeAnalysis = this.regimeSupervisor.analyze(features, currentPrice);
            this.decisionAggregator.setWeights(regimeAnalysis.adjustedWeights);

            // 4. Modules
            const analysisContext: AnalysisContext = {
                regime: regimeAnalysis.regime,
                globalTrend: marketContext?.globalTrend || 'FLAT',
                currentPrice: currentPrice
            };

            const moduleOutputs = this.runModules(features, bars1m, analysisContext);
            const aggregation = this.decisionAggregator.aggregate(moduleOutputs, features, marketContext);

            if (aggregation.action === 'NO_TRADE') {
                return this.createEmptyResult(symbol, aggregation.vetoReason || 'No setup detected', aggregation.rawScore, moduleOutputs);
            }

            // 5. Entry Calculation
            // 🔥 Передаем currentBalance в калькулятор
            const confidence = Math.min(
                1,
                Math.max(
                    0.4,
                    Math.abs(aggregation.rawScore) * 0.8 + aggregation.moduleAgreement * 0.2
                )
            );

            const entryResult = this.entryCalculator.calculate(
                aggregation.action,
                bars1m,
                features,
                confidence, 
                regimeAnalysis.regime,
                currentBalance // <--- 2. ПРОКИДЫВАЕМ ДАЛЬШЕ
            );

            if (!entryResult.isValid) {
                return this.createEmptyResult(symbol, entryResult.reason || 'Invalid Entry Parameters', aggregation.rawScore, moduleOutputs);
            }

            // 6. Result Construction
            const result: SignalResult = {
                ts: new Date(currentTs).toISOString(),
                symbol,
                action: aggregation.action,
                entryType: entryResult.entryType,
                entryPrice: entryResult.entryPrice,
                sl: entryResult.sl,
                tp: entryResult.tp,
                tpPct: entryResult.tpPct,
                horizonMin: entryResult.horizonMin,
                confidence: 1.0,
                confidenceLevel: 'HIGH',
                modules: this.decisionAggregator.getModuleScoresRecord(moduleOutputs),
                reasonTags: [
                    ...this.decisionAggregator.collectReasonTags(moduleOutputs),
                    `REGIME_${regimeAnalysis.regime}`
                ],
                riskPct: entryResult.riskPct,

                // 🔥 3. ВАЖНО: Возвращаем рассчитанный объем, чтобы бэктест не гадал
                quantity: entryResult.quantity,
                positionSizeUsd: entryResult.positionSizeUsd,

                marketRegime: regimeAnalysis.regime,
                meta: {
                    rawScore: aggregation.rawScore,
                    moduleAgreement: aggregation.moduleAgreement,
                    regime: regimeAnalysis.regime,
                    globalTrend: marketContext?.globalTrend,
                    isBrokenCorrelation: marketContext?.isBrokenCorrelation
                },
            };

            // 7. Gatekeeper
            const gateContext: GateContext = {
                signal: result,
                features: features,
                marketContext: marketContext,
                lastSignalTs: this.lastSignalTimes.get(symbol) || 0,
                currentTs
            };

            const gateVerdict = this.gatekeeper.evaluate(gateContext);

            if (!gateVerdict.allowed) {
                return this.createEmptyResult(symbol, `Gatekeeper: ${gateVerdict.reason}`, aggregation.rawScore, moduleOutputs);
            }

            this.lastSignalTimes.set(symbol, currentTs);
            this.logger.info(`🚀 SIGNAL [${symbol}]: ${result.action} @ ${result.entryPrice} | Score: ${aggregation.rawScore.toFixed(2)}`);

            return result;

        } catch (error) {
            this.logger.error(`CRITICAL: Error analyzing ${symbol}`, error);
            return this.createEmptyResult(symbol, 'System Error');
        }
    }

    private runModules(features: Features, bars: (BarData | AggregatedBar)[], context: AnalysisContext): ModuleOutput[] {
        return this.modules.map(module => {
            try {
                return module.analyze(features, bars, context);
            } catch (e) {
                this.logger.error(`Module ${module.name} failed`, e);
                return { name: module.name, score: 0, reliability: 0, tags: [] };
            }
        });
    }

    public isWarmedUp(symbol: string): boolean {
        const agg = this.symbolAggregators.get(symbol);
        return !!agg && agg.getBarCounts().bars1m >= 50; 
    }

    public warmUp(symbol: string, bars: BarData[]): void {
        if (bars.length < 50) return;
        
        const aggregator = this.getOrCreateAggregator(symbol);
        const featureEngine = this.getOrCreateFeatureEngine(symbol);

        bars.forEach(bar => aggregator.addBar(bar));

        const cleanBars = aggregator.getBars('1m') as BarData[];

        featureEngine.hydrate(cleanBars);
        this.modules.forEach(module => module.hydrate(cleanBars));

        this.logger.debug(`🔥 Warmed up ${symbol}: ${cleanBars.length} bars processed (Stats Hydrated).`);
    }

    public clearSymbol(symbol: string): void {
        this.symbolAggregators.delete(symbol);
        this.symbolFeatureEngines.delete(symbol);
        this.lastSignalTimes.delete(symbol);
    }

    private getOrCreateAggregator(symbol: string): TimeframeAggregator {
        let agg = this.symbolAggregators.get(symbol);
        if (!agg) {
            agg = new TimeframeAggregator();
            this.symbolAggregators.set(symbol, agg);
        }
        return agg;
    }

    private getOrCreateFeatureEngine(symbol: string): FeatureEngine {
        let eng = this.symbolFeatureEngines.get(symbol);
        if (!eng) {
            eng = new FeatureEngine(this.config);
            this.symbolFeatureEngines.set(symbol, eng);
        }
        return eng;
    }

    private createEmptyResult(symbol: string, reason: string, rawScore: number = 0, moduleOutputs: ModuleOutput[] = []): SignalResult {
        const moduleScores: Record<string, number> = {};
        moduleOutputs.forEach(m => moduleScores[m.name] = m.score);

        return {
            ts: new Date().toISOString(),
            symbol,
            action: 'NO_TRADE',
            entryType: 'market',
            entryPrice: 0, sl: 0, tp: [], tpPct: [], horizonMin: 0,
            confidence: 0, confidenceLevel: 'LOW',
            modules: moduleScores as any,
            reasonTags: [reason],
            riskPct: 0,
            meta: { rawScore, moduleAgreement: 0, reason },
            marketRegime: 'RANGING'
        };
    }
}