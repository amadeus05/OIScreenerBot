// ========================================================================
// FILE: src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate.ts
// ========================================================================

import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class MeanReversionGate extends BaseGate {
    readonly id = 'mean-reversion-limiter';

    // Минимальное изменение цены (0.2%), чтобы считать это импульсом.
    // 🔥 UPDATED: Теперь проверяем 30-минутное движение, а не 1-минутное
    private readonly minImpulse = 0.02; // 2% за 30 минут для реального пампа (было 0.2% за 1 мин)

    evaluate(ctx: GateContext): GateResult {
        const { features, signal } = ctx;

        // 1. Проверяем, является ли сигнал "Mean Reversion" (разворотным)
        const isReversal = signal.reasonTags.some(t =>
            t.includes('mean_reversion') ||
            t.includes('overbought') ||
            t.includes('oversold') ||
            t.includes('pump')
        );

        if (!isReversal) {
            return this.allow();
        }

        // 2. Проверка импульса (Pump Strength)
        // 🔥 UPDATED: Используем pChange30m (изменение за 30 мин), так как priceReturn - это 1м смена
        // Если цена не выросла значительно за полчаса, то это не памп, и разворачивать тут нечего.
        const impulseStrength = Math.abs(features.pChange30m);

        // Если движение меньше 2% (или настройки minImpulse), то это шум
        if (impulseStrength < this.minImpulse) {
            return this.reject(`No significant impulse (${(impulseStrength * 100).toFixed(2)}% < ${(this.minImpulse * 100)}%)`);
        }

        // 2.1 Анти-контртренд для слабых MR: если импульс слабее 5% и идем против EMA200, отбрасываем
        const priceAboveTrend = features.emaFast > features.trendEma;
        const priceBelowTrend = features.emaFast < features.trendEma;
        const weakImpulse = impulseStrength < 0.05; // 5% за 30 минут считаем слабым для агрессивного разворота

        if (weakImpulse) {
            if (signal.action === 'SHORT' && priceAboveTrend) {
                return this.reject('MR short blocked: weak impulse vs uptrend (EMA200)');
            }
            if (signal.action === 'LONG' && priceBelowTrend) {
                return this.reject('MR long blocked: weak impulse vs downtrend (EMA200)');
            }
        }

        // 3. Подтверждение объемом
        // V-образные развороты требуют кульминации объема.
        // Если volZ < 0 (объем ниже среднего), рынок может просто дрейфовать дальше.
        if (features.volZ < 0) {
            return this.reject(`No volume confirmation (Z: ${features.volZ.toFixed(2)})`);
        }

        if (signal.action === 'SHORT' && features.cvdDominance30m > 0.05) {
             return this.reject(`Aggressive 30m Buying (CVD Dom: ${(features.cvdDominance30m * 100).toFixed(1)}%)`);
        }
        
        // 🔥 НОВОЕ: Проверка МАКСИМАЛЬНОГО импульса (God Candle Protection)
        // Если цена выросла более чем на 12% за 30 минут — это ракета, не шортим.
        // Обычно такие движения продолжаются.
        if (signal.action === 'SHORT' && impulseStrength > 0.12) {
             return this.reject(`Pump too strong for reversal (${(impulseStrength * 100).toFixed(2)}%)`);
        }

        return this.allow();
    }
}