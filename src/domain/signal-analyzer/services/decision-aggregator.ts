import { ModuleOutput, TradeAction, ModuleName, Features } from '../types';
import { DEFAULT_CONFIG, ModuleWeights } from '../types/config';
import { MarketContext } from '../types/context'; // Импортируем контекст

export interface AggregationResult {
    rawScore: number;
    action: TradeAction;
    moduleAgreement: number;
    conflictLevel: number;
    weightedReliability: number;
    participatingWeight: number;
    vetoReason?: string;
}

export class DecisionAggregator {
    private weights: ModuleWeights;
    private readonly threshold: number;

    constructor(
        weights: ModuleWeights = DEFAULT_CONFIG.weights,
        threshold: number = DEFAULT_CONFIG.decision.threshold
    ) {
        this.weights = weights;
        this.threshold = threshold;
    }

    public setWeights(weights: ModuleWeights): void {
        this.weights = weights;
    }

    /**
     * Агрегирует сигналы, применяет логику переворота (Flip) и фильтрации (Veto)
     */
    aggregate(
        moduleOutputs: ModuleOutput[], 
        features: Features, 
        context?: MarketContext // Опциональный контекст (чтобы не ломать старые тесты)
    ): AggregationResult {
        
        if (moduleOutputs.length === 0) {
            return this.createEmptyResult();
        }

        let weightedSum = 0;
        let totalReliabilityWeight = 0;
        let sumPositive = 0;
        let sumNegative = 0;

        // 1. БАЗОВЫЙ РАСЧЕТ
        for (const output of moduleOutputs) {
            const weight = this.weights[output.name] || 0;
            const effectiveWeight = weight * output.reliability;

            if (effectiveWeight === 0) continue;

            if (Math.abs(output.score) < 0.01) {
                totalReliabilityWeight += effectiveWeight * 0.1;
            } else {
                const contribution = output.score * effectiveWeight;
                weightedSum += contribution;
                totalReliabilityWeight += effectiveWeight;

                if (output.score > 0) sumPositive += contribution;
                if (output.score < 0) sumNegative += Math.abs(contribution);
            }
        }

        let rawScore = totalReliabilityWeight > 0 ? weightedSum / totalReliabilityWeight : 0;
        let action: TradeAction = 'NO_TRADE';

        if (Math.abs(rawScore) >= this.threshold) {
            action = rawScore > 0 ? 'LONG' : 'SHORT';
        }

        // 2. OPPORTUNISTIC FLIP LOGIC
        let vetoReason: string | undefined;
        let isFlipped = false;

        if (action !== 'NO_TRADE') {
            const momentumScore = this.getModuleScore(moduleOutputs, 'momentum');
            const reversalWhitelist = [
                'resistance_SFP_rejection', 'support_SFP_rejection',
                'short_squeeze_climax_reversal', 'long_cascade_climax_reversal',
                'panic_short_squeeze', 'panic_long_cascade'
            ];
            const tags = this.collectReasonTags(moduleOutputs);
            const isReversalSetup = tags.some(t => reversalWhitelist.includes(t));

            // FLIP TO LONG
            if (action === 'SHORT' && !isReversalSetup) {
                if (features.emaFast > features.emaSlow && momentumScore > 0.15) {
                    action = 'LONG';
                    rawScore = Math.abs(rawScore);
                    vetoReason = 'FLIP_TREND_FOLLOW_LONG';
                    isFlipped = true;
                    this.addTagToModule(moduleOutputs, 'momentum', 'AUTO_FLIP_LONG');
                }
            }
            // FLIP TO SHORT
            else if (action === 'LONG' && !isReversalSetup) {
                if (features.emaFast < features.emaSlow && momentumScore < -0.15) {
                    action = 'SHORT';
                    rawScore = -Math.abs(rawScore);
                    vetoReason = 'FLIP_TREND_FOLLOW_SHORT';
                    isFlipped = true;
                    this.addTagToModule(moduleOutputs, 'momentum', 'AUTO_FLIP_SHORT');
                }
            }
        }

        // 3. SMART SANITY CHECK (VETO LOGIC)
        if (action !== 'NO_TRADE' && !isFlipped) {
            const tags = this.collectReasonTags(moduleOutputs);
            const isLong = action === 'LONG';
            
            // --- VETO 1-3: Существующие проверки ---
            if (isLong) {
                if (tags.includes('near_resistance') && !tags.includes('resistance_breakout') && !tags.includes('volume_breakout')) {
                    action = 'NO_TRADE';
                    rawScore = 0;
                    vetoReason = 'VETO_LEVELS_RESISTANCE';
                }
            } else {
                if (tags.includes('near_support') && !tags.includes('support_breakdown') && !tags.includes('volume_breakdown')) {
                    action = 'NO_TRADE';
                    rawScore = 0;
                    vetoReason = 'VETO_LEVELS_SUPPORT';
                }
            }

            if (tags.includes('dead_market')) {
                const isBreakout = tags.includes('resistance_breakout') || tags.includes('support_breakdown');
                if (isBreakout) {
                    action = 'NO_TRADE';
                    rawScore = 0;
                    vetoReason = 'VETO_VOLATILITY_DEAD';
                }
            }
            
            // --- VETO 4: FAKE BREAKOUT IN VOLATILITY ---
            // Если режим VOLATILE (определяется супервайзером), мы торгуем только на ликвидациях.
            // Но здесь мы не знаем режим напрямую (он в супервайзере). 
            // Но мы можем проверить наличие ликвидаций в features.
            if (tags.includes('resistance_breakout') || tags.includes('support_breakdown')) {
                 if (features.volZ > 2.5 && !features.liquidationSignal) {
                     // Высокая волатильность, пробой, но без ликвидаций -> Часто ловушка.
                     // (Optional strict check)
                 }
            }

            // === VETO 5: GLOBAL MARKET CONTEXT (УМНЫЙ ФИЛЬТР) ===
            // Если контекст передан, используем его разрешения
            if (context) {
                if (action === 'LONG' && !context.permissions.allowLong) {
                    // Исключение: Очень сильный SFP (разворот) иногда может сработать против тренда,
                    // но для безопасности лучше следовать глобальному тренду.
                    action = 'NO_TRADE';
                    rawScore = 0;
                    // Форматируем причину: VETO_GLOBAL_DOWNTREND или VETO_GLOBAL_PANIC_DUMP
                    vetoReason = `VETO_GLOBAL_${context.permissions.reason.toUpperCase().replace(/\s+/g, '_')}`;
                }

                if (action === 'SHORT' && !context.permissions.allowShort) {
                    action = 'NO_TRADE';
                    rawScore = 0;
                    vetoReason = `VETO_GLOBAL_${context.permissions.reason.toUpperCase().replace(/\s+/g, '_')}`;
                }

                // Доп. защита при высоком риске
                if (context.riskLevel === 'HIGH' || context.riskLevel === 'EXTREME') {
                    if (action !== 'NO_TRADE') {
                        // При высоком риске требуем, чтобы сигнал был ОЧЕНЬ сильным (> 0.75)
                        if (Math.abs(rawScore) < 0.75) {
                            action = 'NO_TRADE';
                            rawScore = 0;
                            vetoReason = 'VETO_HIGH_RISK_WEAK_SIGNAL';
                        }
                    }
                }
            }
        }

        // 4. РАСЧЕТ ИТОГОВЫХ МЕТРИК
        let agreeingWeight = 0;
        const finalSign = Math.sign(rawScore);
        const totalFlux = sumPositive + sumNegative;
        if (totalReliabilityWeight > 0 && finalSign !== 0) {
            for (const output of moduleOutputs) {
                if (output.score !== 0 && Math.sign(output.score) === finalSign) {
                    agreeingWeight += (this.weights[output.name] || 0) * output.reliability;
                }
            }
        }

        const moduleAgreement = totalReliabilityWeight > 0 ? agreeingWeight / totalReliabilityWeight : 0;
        const conflictLevel = totalFlux > 0 ? 1 - (Math.abs(weightedSum) / totalFlux) : 0;

        let sumRel = 0;
        let countRel = 0;
        for (const output of moduleOutputs) {
            if (output.score !== 0) {
                const w = this.weights[output.name] || 0;
                sumRel += output.reliability * w;
                countRel += w;
            }
        }
        const weightedReliability = countRel > 0 ? sumRel / countRel : 0;

        return {
            rawScore,
            action,
            moduleAgreement,
            conflictLevel,
            weightedReliability,
            participatingWeight: totalReliabilityWeight,
            vetoReason
        };
    }

    private createEmptyResult(): AggregationResult {
        return {
            rawScore: 0,
            action: 'NO_TRADE',
            moduleAgreement: 0,
            conflictLevel: 0,
            weightedReliability: 0,
            participatingWeight: 0
        };
    }

    private getModuleScore(outputs: ModuleOutput[], name: ModuleName): number {
        const module = outputs.find(m => m.name === name);
        return module ? module.score : 0;
    }

    private addTagToModule(outputs: ModuleOutput[], name: ModuleName, tag: string): void {
        const module = outputs.find(m => m.name === name);
        if (module) {
            module.tags.push(tag);
        }
    }

    getModuleScoresRecord(moduleOutputs: ModuleOutput[]): Record<ModuleName, number> {
        const record: Partial<Record<ModuleName, number>> = {};
        for (const output of moduleOutputs) {
            record[output.name] = output.score;
        }
        return record as Record<ModuleName, number>;
    }

    collectReasonTags(moduleOutputs: ModuleOutput[]): string[] {
        const tags = new Set<string>();
        const sortedOutputs = [...moduleOutputs].sort((a, b) => {
            return (this.weights[b.name] || 0) - (this.weights[a.name] || 0);
        });
        for (const output of sortedOutputs) {
            if (output.score !== 0) {
                for (const tag of output.tags) {
                    tags.add(tag);
                }
            }
        }
        return Array.from(tags);
    }
}