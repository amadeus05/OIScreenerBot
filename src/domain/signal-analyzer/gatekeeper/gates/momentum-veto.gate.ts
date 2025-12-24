import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class MomentumVetoGate extends BaseGate {
    readonly id = 'momentum-veto';

    // 🔥 PRO: ATR-normalized threshold for overextension
    private readonly OVEREXTENDED_ATR = 2.0;  // 2 ATR = перекуплено/перепродано

    evaluate(ctx: GateContext): GateResult {
        const { signal, features } = ctx;


         // 🔥 ОБЯЗАТЕЛЬНОЕ ПОДТВЕРЖДЕНИЕ ПОТОКОМ
        // Если мы хотим ЛОНГ, поток (CVD) не должен падать.
        // Если мы хотим ШОРТ, поток не должен расти.
        
        // dCVD - это изменение кумулятивного объема.
        // flowImb - это дисбаланс покупок/продаж.

        if (signal.action === 'LONG') {
            // Если CVD падает ИЛИ Продавцы доминируют -> ЗАПРЕТ
            if (features.dCVD < 0 && features.flowImb < -0.05) {
                return this.reject(`No Orderflow Support for LONG (dCVD < 0, Imb: ${features.flowImb.toFixed(2)})`);
            }
        }

        if (signal.action === 'SHORT') {
            // Если CVD растет ИЛИ Покупатели доминируют -> ЗАПРЕТ
            if (features.dCVD > 0 && features.flowImb > 0.05) {
                return this.reject(`No Orderflow Support for SHORT (dCVD > 0, Imb: ${features.flowImb.toFixed(2)})`);
            }
        }

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
        // 🔥 Теперь используем ATR-нормализованный порог
        if (signal.action === 'LONG' && features.trueImpulseATR > this.OVEREXTENDED_ATR) {
            if (!signal.reasonTags.includes('volume_breakout')) {
                return this.reject(`Price overextended UP (+${features.trueImpulseATR.toFixed(1)} ATR) - waiting for dip`);
            }
        }

        // ЗАЩИТА ОТ ПРОДАЖИ НА ДНЕ (Panic Sell)
        if (signal.action === 'SHORT' && features.trueImpulseATR < -this.OVEREXTENDED_ATR) {
            if (!signal.reasonTags.includes('volume_breakout')) {
                return this.reject(`Price overextended DOWN (${features.trueImpulseATR.toFixed(1)} ATR) - waiting for bounce`);
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
