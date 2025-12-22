import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class MomentumVetoGate extends BaseGate {
    readonly id = 'momentum-veto';

    // Запрещаем Лонг, если EMA Fast сильно ниже EMA Slow (сильный даунтренд локально)
    // Запрещаем Шорт, если EMA Fast сильно выше EMA Slow
    evaluate(ctx: GateContext): GateResult {
        const { signal, features } = ctx;

        // 1. Проверка на флэт (оставляем)
        const momentumScore = signal.modules.momentum;
        if (Math.abs(momentumScore) < 0.05) {
            return this.reject(`Low momentum (${momentumScore.toFixed(3)}) - Flat Market`);
        }

        // 2. Расчет отклонения цены от средней (EMA 20)
        // features.deviation - это (Price - EMA20) / ATR
        // Если deviation > 2.0, цена улетела на 2 ATR вверх (перекуплена).
        // Если deviation < -2.0, цена улетела на 2 ATR вниз (перепродана).
        
        const deviation = features.lastPriceGap * 100; // Это не совсем то, лучше взять из контекста если есть, или посчитать
        // В FeatureEngine deviation не экспортируется напрямую, но мы можем использовать (emaFast - emaSlow) / emaSlow
        
        // Давайте используем простую эвристику на основе EMA разрыва
        const priceVsEmaFast = (features.priceReturn); // Грубая оценка, но лучше использовать EMA
        
        // ВНИМАНИЕ: Лучше использовать готовый `features.lastPriceGap` или посчитать тут
        // Но самое надежное - проверить 'Buy High / Sell Low' через RSI или Боллинджера, 
        // но у нас их нет в features. 
        
        // ИСПОЛЬЗУЕМ СУЩЕСТВУЮЩИЕ ДАННЫЕ:
        // features.pChange30m показывает, насколько цена улетела за 30 минут.
        
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