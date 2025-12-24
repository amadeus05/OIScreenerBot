// ========================================================================
// FILE: src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate.ts
// ========================================================================

import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class MeanReversionGate extends BaseGate {
    readonly id = 'mean-reversion-limiter';

    // 🔥 PRO: ATR-normalized thresholds (вместо фиксированных %)
    private readonly MIN_IMPULSE_ATR = 1.5;    // 1.5 ATR = минимальный импульс для MR
    private readonly WEAK_IMPULSE_ATR = 3.0;   // 3 ATR = слабый импульс (требует подтверждения тренда)
    private readonly MAX_IMPULSE_ATR = 8.0;    // 8 ATR = слишком сильная ракета (не шортим)

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

        // 2. Проверка импульса (Pump Strength) - теперь в ATR
        const impulseStrengthATR = Math.abs(features.trueImpulseATR);

        // Если импульс меньше 1.5 ATR, это шум
        if (impulseStrengthATR < this.MIN_IMPULSE_ATR) {
            return this.reject(`No significant impulse (${impulseStrengthATR.toFixed(1)} ATR < ${this.MIN_IMPULSE_ATR} ATR)`);
        }

        // 2.1 Анти-контртренд для слабых MR: если импульс слабее 3 ATR и идем против EMA200, отбрасываем
        const priceAboveTrend = features.emaFast > features.trendEma;
        const priceBelowTrend = features.emaFast < features.trendEma;
        const weakImpulse = impulseStrengthATR < this.WEAK_IMPULSE_ATR;

        if (weakImpulse) {
            if (signal.action === 'SHORT' && priceAboveTrend) {
                return this.reject('MR short blocked: weak impulse vs uptrend (EMA200)');
            }
            if (signal.action === 'LONG' && priceBelowTrend) {
                return this.reject('MR long blocked: weak impulse vs downtrend (EMA200)');
            }
        }

        // 3. Подтверждение объемом
        if (features.volZ < 0) {
            return this.reject(`No volume confirmation (Z: ${features.volZ.toFixed(2)})`);
        }

        if (signal.action === 'SHORT' && features.cvdDominance30m > 0.05) {
            return this.reject(`Aggressive 30m Buying (CVD Dom: ${(features.cvdDominance30m * 100).toFixed(1)}%)`);
        }

        // 🔥 НОВОЕ: Проверка МАКСИМАЛЬНОГО импульса (God Candle Protection)
        // Если цена прошла более 8 ATR за 30 минут — это ракета, не шортим.
        if (signal.action === 'SHORT' && impulseStrengthATR > this.MAX_IMPULSE_ATR) {
            return this.reject(`Pump too strong for reversal (${impulseStrengthATR.toFixed(1)} ATR)`);
        }

        return this.allow();
    }
}
