import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class MomentumVetoGate extends BaseGate {
    readonly id = 'momentum-veto';

    // Запрещаем Лонг, если EMA Fast сильно ниже EMA Slow (сильный даунтренд локально)
    // Запрещаем Шорт, если EMA Fast сильно выше EMA Slow
    evaluate(ctx: GateContext): GateResult {
        const { signal, features } = ctx;

        // Разница EMA в % от цены (примерно)
        // features.emaFast / features.emaSlow

        const emaDiffPct = (features.emaFast - features.emaSlow) / features.emaSlow;

        // --- NEW: Force Momentum Threshold (Flat Market Filter) ---
        // Если модуль моментума дает слишком слабый сигнал (< 0.05), считаем рынок флэтовым
        // Примечание: signal.modules.momentum уже нормализован (-1..1), но часто бывает около 0
        const momentumScore = signal.modules.momentum;

        if (Math.abs(momentumScore) < 0.05) {
            return this.reject(`Low momentum (${momentumScore.toFixed(3)}) - Flat Market`);
        }

        // Если пытаемся лонговать, но импульс сильно вниз (> 0.5%)
        if (signal.action === 'LONG' && emaDiffPct < -0.005) {
            // Исключение: это ловля ножа (oversold reversal)
            if (!signal.reasonTags.includes('oversold_reversal')) {
                return this.reject(`Negative momentum mismatch (${(emaDiffPct * 100).toFixed(2)}%)`);
            }
        }

        if (signal.action === 'SHORT' && emaDiffPct > 0.005) {
            if (!signal.reasonTags.includes('overbought_reversal')) {
                return this.reject(`Positive momentum mismatch (${(emaDiffPct * 100).toFixed(2)}%)`);
            }
        }

        return this.allow();
    }
}