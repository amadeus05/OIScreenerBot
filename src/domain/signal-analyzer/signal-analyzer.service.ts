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
    ModuleName,
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
    private readonly entryCalculator: EntryCalculator; // Расчет SL/TP
    private readonly regimeSupervisor: RegimeSupervisor; // Веса (Волатильность vs Тренд)
    private readonly gatekeeper: TradeGatekeeper; // Финальный фильтр (Anti-Spam)

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

        // Инициализация "движков"
        this.aggregator = new TimeframeAggregator();
        this.featureEngine = new FeatureEngine(config);

        // Агрегатор решений (суммирует баллы от сценариев)
        this.decisionAggregator = new DecisionAggregator(config.weights, config.decision.threshold);

        // Калькулятор входа (ATR стопы, уровни)
        this.entryCalculator = new EntryCalculator();

        // Супервизор режима (определяет Panic/Quiet для весов)
        this.regimeSupervisor = new RegimeSupervisor(config.weights);

        this.logger.info(`✅ SignalAnalyzerService started with ${this.modules.length} modules.`);
    }

    public analyze(symbol: string, bars: BarData[], marketContext?: MarketContext): SignalResult {
        // Минимальное требование к истории
        if (bars.length < 50) return this.createEmptyResult(symbol, 'Insufficient data');

        try {
            // 1. Data & Feature Engineering
            // ==========================================
            const aggregator = this.getOrCreateAggregator(symbol);
            bars.forEach(b => aggregator.addBar(b)); // Важно: в реале добавляем только новые, тут упрощено

            const bars1m = aggregator.getBars('1m', 120) as BarData[]; // Берем чуть больше для индикаторов
            const featureEngine = this.getOrCreateFeatureEngine(symbol);
            const features = featureEngine.computeFeatures(bars1m);
            const currentPrice = bars1m[bars1m.length - 1].c;

            // 2. Regime Detection (Определяем веса)
            // ==========================================
            // Если рынок в ПАНИКЕ -> веса MeanReversion и Liquidation повышаются
            const regimeAnalysis = this.regimeSupervisor.analyze(features, currentPrice);
            this.decisionAggregator.setWeights(regimeAnalysis.adjustedWeights);

            // 3. Run All Modules (Scenario Checks)
            // ==========================================
            const analysisContext: AnalysisContext = {
                regime: regimeAnalysis.regime,
                globalTrend: marketContext?.globalTrend || 'FLAT',
                currentPrice: currentPrice
            };

            const moduleOutputs = this.runModules(features, bars1m, analysisContext);
            // 4. Aggregation (Sum Scores)
            // ==========================================
            // Здесь решается конфликт: Momentum (+0.6) + MeanReversion (-0.9) = Short (-0.3)
            const aggregation = this.decisionAggregator.aggregate(moduleOutputs, features, marketContext);

            if (aggregation.action === 'NO_TRADE') {
                return this.createEmptyResult(symbol, aggregation.vetoReason || 'No setup detected', aggregation.rawScore, moduleOutputs);
            }

            // 5. Entry Calculation (SL / TP / Position Size)
            // ==========================================
            // Рассчитываем динамический стоп по ATR и тейк
            const entryResult = this.entryCalculator.calculate(
                aggregation.action,
                bars1m,
                features,
                1.0, // Confidence теперь всегда 1.0, если сценарий сработал (он сам по себе надежен)
                regimeAnalysis.regime
            );

            if (!entryResult.isValid) {
                return this.createEmptyResult(symbol, entryResult.reason || 'Invalid Entry Parameters', aggregation.rawScore, moduleOutputs);
            }

            // 6. Result Construction
            // ==========================================
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
                confidence: 1.0, // Сценарий = 100% доверие к логике
                confidenceLevel: 'HIGH',
                modules: this.decisionAggregator.getModuleScoresRecord(moduleOutputs),
                reasonTags: [
                    ...this.decisionAggregator.collectReasonTags(moduleOutputs),
                    `REGIME_${regimeAnalysis.regime}`
                ],
                riskPct: entryResult.riskPct,
                marketRegime: regimeAnalysis.regime,
                meta: {
                    rawScore: aggregation.rawScore,
                    moduleAgreement: aggregation.moduleAgreement,
                    regime: regimeAnalysis.regime,
                },
            };

            // 7. 🔥 GATEKEEPER (The Final Boss)
            // ==========================================
            // Проверка на спам, повторы сигналов и жесткие запреты
            const gateContext: GateContext = {
                signal: result,
                features: features,
                marketContext: marketContext,
                lastSignalTs: this.lastSignalTimes.get(symbol) || 0
            };

            const gateVerdict = this.gatekeeper.evaluate(gateContext);

            if (!gateVerdict.allowed) {
                return this.createEmptyResult(symbol, `Gatekeeper: ${gateVerdict.reason}`, aggregation.rawScore, moduleOutputs);
            }

            // Успех! Запоминаем время
            this.lastSignalTimes.set(symbol, Date.now());
            this.logger.info(`🚀 SIGNAL [${symbol}]: ${result.action} @ ${result.entryPrice} | Score: ${aggregation.rawScore.toFixed(2)}`);

            return result;

        } catch (error) {
            this.logger.error(`CRITICAL: Error analyzing ${symbol}`, error);
            return this.createEmptyResult(symbol, 'System Error');
        }
    }

    // --- Helpers ---

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

    // WarmUp нужен для корректного расчета ATR/RSI перед стартом
    public warmUp(symbol: string, bars: BarData[]): void {
        if (bars.length < 20) return;
        const aggregator = this.getOrCreateAggregator(symbol);
        const featureEngine = this.getOrCreateFeatureEngine(symbol);

        // Reset state
        featureEngine.reset();

        // Fast-forward history
        // Оптимизация: не прогоняем модули на истории, только фичи
        bars.forEach(bar => {
            aggregator.addBar(bar);
            // Периодически обновляем фичи, чтобы заполнить буферы индикаторов
            // (можно делать реже для скорости, но для точности лучше каждый бар)
        });

        // Финальный прогон фичей, чтобы убедиться, что всё готово
        featureEngine.computeFeatures(aggregator.getBars('1m', 100) as BarData[]);
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
            marketRegime: 'RANGING' // Default
        };
    }
}