import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class MomentumVetoGate extends BaseGate {
    readonly id = 'momentum-veto';

    evaluate(ctx: GateContext): GateResult {
        const { signal, features } = ctx;

        // 🔥Фильтр ложных пробоев
        // Если мы видим сигнал "Volume Breakout", мы требуем, 
        // чтобы модуль Orderflow тоже кричал "ДА!" (score >= 0.5).
        // Если Orderflow молчит (< 0.5), значит объем дутый (накрученный или останавливающий).
        if (signal.reasonTags.includes('volume_breakout')) {
            const ofScore = Math.abs(signal.modules.orderflow);
            if (ofScore < 0.5) {
                return this.reject(`Fakeout Protection: Breakout without Orderflow support (${ofScore.toFixed(2)} < 0.5)`);
            }
        }

        // 1. Проверка на флэт (оставляем)
        const momentumScore = signal.modules.momentum;
        if (Math.abs(momentumScore) < 0.05) {
            return this.reject(`Low momentum (${momentumScore.toFixed(3)}) - Flat Market`);
        }

        // ЗАЩИТА ОТ ПОКУПКИ НА ХАЯХ (FOMO)
        // Если цена выросла более чем на 3% за 30 мин, и это не пробой уровня (volume_breakout),
        // то входить в ЛОНГ опасно (нужен откат).
        if (signal.action === 'LONG' && features.pChange30m > 0.03) {
            if (!signal.reasonTags.includes('volume_breakout')) {
                 return this.reject(`Price overextended UP (+${(features.pChange30m*100).toFixed(1)}%) - waiting for dip`);
            }
        }

        // ЗАЩИТА ОТ ПРОДАЖИ НА ДНЕ (Panic Sell)
        // Если цена упала более чем на 3% за 30 мин, шортить поздно.
        if (signal.action === 'SHORT' && features.pChange30m < -0.03) {
             if (!signal.reasonTags.includes('volume_breakout')) {
                 return this.reject(`Price overextended DOWN (${(features.pChange30m*100).toFixed(1)}%) - waiting for bounce`);
             }
        }

        // 3. Проверка соответствия моментума (оставляем старую логику)
        const emaDiffPct = (features.emaFast - features.emaSlow) / features.emaSlow;

        if (signal.action === 'LONG' && emaDiffPct < -0.005) {
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