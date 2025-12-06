import { ModuleOutput, TradeAction, ModuleName } from '../types';
import { DEFAULT_CONFIG, ModuleWeights } from '../types/config';

export interface AggregationResult {
    rawScore: number;         // Взвешенный итог [-1, 1]
    action: TradeAction;
    moduleAgreement: number;  // [0, 1] % веса модулей, которые активно согласны
    conflictLevel: number;    // [0, 1] Насколько модули противоречат друг другу
    weightedReliability: number;
    participatingWeight: number; // Абсолютная сумма весов, участвовавших в решении
}

export class DecisionAggregator {
    private readonly weights: ModuleWeights;
    private readonly threshold: number;

    constructor(
        weights: ModuleWeights = DEFAULT_CONFIG.weights,
        threshold: number = DEFAULT_CONFIG.decision.threshold
    ) {
        this.weights = weights;
        this.threshold = threshold;
    }

    aggregate(moduleOutputs: ModuleOutput[]): AggregationResult {
        if (moduleOutputs.length === 0) {
            return this.createEmptyResult();
        }

        let weightedSum = 0;
        let totalReliabilityWeight = 0;

        // Для расчета конфликта: сумма положительных и отрицательных векторов
        let sumPositive = 0;
        let sumNegative = 0;

        for (const output of moduleOutputs) {
            const weight = this.weights[output.name] || 0;
            // Эффективный вес = статический вес * надежность сигнала
            const effectiveWeight = weight * output.reliability;

            if (effectiveWeight === 0) continue;

            // ЕСЛИ СКОР ~0 — МОДУЛЬ "ВОЗДЕРЖАЛСЯ"
            // Не учитываем его полный вес в делителе, чтобы не разбавлять сильные сигналы
            if (Math.abs(output.score) < 0.01) {
                // Модуль воздержался: учитываем только 10% его веса
                totalReliabilityWeight += effectiveWeight * 0.1;
                // weightedSum += 0 (вклад в сумму нулевой)
            } else {
                const contribution = output.score * effectiveWeight;
                weightedSum += contribution;
                totalReliabilityWeight += effectiveWeight;

                // Накапливаем вектора для расчета конфликта
                if (output.score > 0) sumPositive += contribution;
                if (output.score < 0) sumNegative += Math.abs(contribution);
            }
        }

        // 1. RAW SCORE
        const rawScore = totalReliabilityWeight > 0
            ? weightedSum / totalReliabilityWeight
            : 0;

        // 2. ACTION
        let action: TradeAction = 'NO_TRADE';
        if (Math.abs(rawScore) >= this.threshold) {
            action = rawScore > 0 ? 'LONG' : 'SHORT';
        }

        // 3. AGREEMENT & CONFLICT
        // Agreement: Доля веса модулей, знак которых совпадает с итоговым
        // Conflict: 1 - (|Сумма| / (|Pos| + |Neg|)). Если все тянут в одну сторону, конфликт 0.

        let agreeingWeight = 0;
        const finalSign = Math.sign(rawScore);
        const totalFlux = sumPositive + sumNegative; // Общая "энергия" сигналов

        if (totalReliabilityWeight > 0 && finalSign !== 0) {
            for (const output of moduleOutputs) {
                // Игнорируем нейтральные (0), они не подтверждают
                if (output.score !== 0 && Math.sign(output.score) === finalSign) {
                    agreeingWeight += (this.weights[output.name] || 0) * output.reliability;
                }
            }
        }

        const moduleAgreement = totalReliabilityWeight > 0
            ? agreeingWeight / totalReliabilityWeight
            : 0;

        // Конфликт: если Pos=10, Neg=10 -> Sum=0 -> Conflict = 1.0 (Полный хаос)
        // Если Pos=20, Neg=0 -> Sum=20 -> Conflict = 0.0 (Полное единодушие)
        const conflictLevel = totalFlux > 0
            ? 1 - (Math.abs(weightedSum) / totalFlux)
            : 0;

        // 4. WEIGHTED RELIABILITY (Average reliability of active modules)
        // Считаем среднюю надежность только по тем модулям, которые дали голос
        // Это более честно, чем считать по всем.
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
            participatingWeight: totalReliabilityWeight
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

    getModuleScoresRecord(moduleOutputs: ModuleOutput[]): Record<ModuleName, number> {
        const record: Partial<Record<ModuleName, number>> = {};
        for (const output of moduleOutputs) {
            record[output.name] = output.score;
        }
        return record as Record<ModuleName, number>;
    }

    collectReasonTags(moduleOutputs: ModuleOutput[]): string[] {
        // Используем Set для уникальности, но сохраняем порядок через Array.from
        const tags = new Set<string>();
        // Сортируем модули по весу, чтобы теги важных модулей шли первыми
        const sortedOutputs = [...moduleOutputs].sort((a, b) => {
            return (this.weights[b.name] || 0) - (this.weights[a.name] || 0);
        });

        for (const output of sortedOutputs) {
            // Добавляем теги только если модуль активен (score != 0)
            if (output.score !== 0) {
                for (const tag of output.tags) {
                    tags.add(tag);
                }
            }
        }
        return Array.from(tags);
    }
}