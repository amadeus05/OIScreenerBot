import { ModuleOutput, TradeAction, ModuleName, Features } from '../types';
import { DEFAULT_CONFIG, ModuleWeights } from '../types/config';

export interface AggregationResult {
    rawScore: number;         // Взвешенный итог [-1, 1]
    action: TradeAction;
    moduleAgreement: number;  // [0, 1] % веса модулей, которые активно согласны
    conflictLevel: number;    // [0, 1] Насколько модули противоречат друг другу
    weightedReliability: number;
    participatingWeight: number; // Абсолютная сумма весов, участвовавших в решении
    vetoReason?: string;      // Причина отмены или переворота сделки
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
    aggregate(moduleOutputs: ModuleOutput[], features: Features): AggregationResult {
        if (moduleOutputs.length === 0) {
            return this.createEmptyResult();
        }

        let weightedSum = 0;
        let totalReliabilityWeight = 0;

        // Вектора для расчета конфликта
        let sumPositive = 0;
        let sumNegative = 0;

        // ---------------------------------------------------------------------
        // 1. БАЗОВЫЙ РАСЧЕТ (ВЗВЕШЕННАЯ СУММА)
        // ---------------------------------------------------------------------
        for (const output of moduleOutputs) {
            const weight = this.weights[output.name] || 0;
            const effectiveWeight = weight * output.reliability;

            if (effectiveWeight === 0) continue;

            // Если модуль "воздержался" (score ~ 0), учитываем лишь малую часть его веса
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

        // ---------------------------------------------------------------------
        // 2. OPPORTUNISTIC FLIP LOGIC (ПРЕВРАЩАЕМ ОШИБКИ В ПРИБЫЛЬ)
        // Логика: Если мы пытаемся торговать ПРОТИВ сильного тренда без веской причины,
        // мы не просто отменяем сделку, а ПЕРЕВОРАЧИВАЕМСЯ по тренду.
        // ---------------------------------------------------------------------
        
        let vetoReason: string | undefined;
        let isFlipped = false;

        if (action !== 'NO_TRADE') {
            const momentumScore = this.getModuleScore(moduleOutputs, 'momentum');
            
            // Список тегов, которые разрешают контртренд (это "умные" развороты, их не трогаем)
            const reversalWhitelist = [
                'resistance_SFP_rejection', 'support_SFP_rejection',
                'short_squeeze_climax_reversal', 'long_cascade_climax_reversal',
                'panic_short_squeeze', 'panic_long_cascade'
            ];
            const tags = this.collectReasonTags(moduleOutputs);
            const isReversalSetup = tags.some(t => reversalWhitelist.includes(t));

            // SCENARIO A: FLIP TO LONG (Исправление ошибки CUDIS/HBAR)
            // Бот хочет ШОРТ (action=SHORT), но Тренд Вверх (EMA Fast > Slow) И Моментум положителен.
            if (action === 'SHORT' && !isReversalSetup) {
                if (features.emaFast > features.emaSlow && momentumScore > 0.15) {
                    // Мы пытаемся шортить растущий рынок. Глупо.
                    // Переворачиваемся в ЛОНГ на продолжение тренда!
                    action = 'LONG';
                    rawScore = Math.abs(rawScore); // Делаем скор положительным
                    vetoReason = 'FLIP_TREND_FOLLOW_LONG'; // Помечаем как особый тип входа
                    isFlipped = true;
                    
                    // Добавляем тег для логов
                    this.addTagToModule(moduleOutputs, 'momentum', 'AUTO_FLIP_LONG');
                }
            }

            // SCENARIO B: FLIP TO SHORT
            // Бот хочет ЛОНГ, но Тренд Вниз И Моментум отрицателен.
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

        // ---------------------------------------------------------------------
        // 3. SMART SANITY CHECK (VETO LOGIC)
        // Если мы не перевернулись, проверяем стандартные запреты.
        // ---------------------------------------------------------------------

        if (action !== 'NO_TRADE' && !isFlipped) {
            const tags = this.collectReasonTags(moduleOutputs);
            const isLong = action === 'LONG';
            
            // VETO 1: Не покупай в сопротивление / Не продавай в поддержку (если это не пробой)
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

            // VETO 2: Фильтр мертвого рынка (как на DYDX)
            // Запрещаем торговать пробои (breakout), если волатильность на нуле.
            if (tags.includes('dead_market')) {
                const isBreakout = tags.includes('resistance_breakout') || tags.includes('support_breakdown');
                if (isBreakout) {
                    action = 'NO_TRADE';
                    rawScore = 0;
                    vetoReason = 'VETO_VOLATILITY_DEAD';
                }
            }
            
            // VETO 3: Защита от глупого контртренда (если Flip не сработал, но тренд сильный)
            // Просто блокируем сделку, чтобы не терять деньги.
            if (!vetoReason) {
                // Пытаемся шортить, а тренд явно вверх
                if (!isLong && features.emaFast > features.emaSlow) {
                    // Разрешаем только если это SFP (умный разворот)
                    const isSFP = tags.includes('resistance_SFP_rejection');
                    if (!isSFP) {
                         action = 'NO_TRADE';
                         rawScore = 0;
                         vetoReason = 'VETO_TREND_MISMATCH';
                    }
                }
                // Пытаемся лонговать, а тренд явно вниз
                if (isLong && features.emaFast < features.emaSlow) {
                    const isSFP = tags.includes('support_SFP_rejection');
                    if (!isSFP) {
                         action = 'NO_TRADE';
                         rawScore = 0;
                         vetoReason = 'VETO_TREND_MISMATCH';
                    }
                }
            }
        }

        // ---------------------------------------------------------------------
        // 4. РАСЧЕТ ИТОГОВЫХ МЕТРИК
        // ---------------------------------------------------------------------

        // Agreement: Доля веса модулей, согласных с финальным решением
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

        const moduleAgreement = totalReliabilityWeight > 0
            ? agreeingWeight / totalReliabilityWeight
            : 0;

        const conflictLevel = totalFlux > 0
            ? 1 - (Math.abs(weightedSum) / totalFlux)
            : 0;

        // Взвешенная надежность активных модулей
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

    // Хелпер: Получить скор конкретного модуля
    private getModuleScore(outputs: ModuleOutput[], name: ModuleName): number {
        const module = outputs.find(m => m.name === name);
        return module ? module.score : 0;
    }

    // Хелпер: Добавить тег модулю (для логов FLIP)
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