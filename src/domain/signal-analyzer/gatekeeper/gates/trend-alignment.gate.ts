import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';
import { Predicates as P } from '../../rules/predicates';
import { Logger } from '../../../../shared/logger';

export class TrendAlignmentGate extends BaseGate {
    readonly id = 'trend-alignment';
    private readonly logger = new Logger('TrendAlignmentGate');

    evaluate(ctx: GateContext): GateResult {
        const { signal, features, marketContext } = ctx;

        // 1. Защита от краха/пампа BTC (у вас это уже было, оставляем)
        if (marketContext) {
            if (signal.action === 'LONG' && marketContext.globalTrend === 'CRASH') {
                return this.reject('Blocked: BTC CRASH in progress');
            }
            if (signal.action === 'SHORT' && marketContext.globalTrend === 'PUMP') {
                return this.reject('Blocked: BTC PUMP in progress');
            }
        }

        // Если это разворотная стратегия (Mean Reversion), пропускаем фильтр тренда,
        // НО только если сигнал очень сильный
        const isReversal = signal.reasonTags.some(t =>
            t.includes('mean_reversion') || t.includes('exhaustion')
        );

        if (isReversal) return this.allow();

        // 🔥 ИЗМЕНЕНИЕ: Фильтр по EMA 200 (Trend EMA)
        // features.trendEma - это EMA 200
        // features.emaFast - это быстрая цена (EMA 8)

        // ЗАПРЕЩАЕМ ЛОНГ, если цена ниже EMA 200 (Глобальный даунтренд)
        if (signal.action === 'LONG' && features.emaFast < features.trendEma) {
             return this.reject('Against Trend: Price below EMA 200');
        }

        // ЗАПРЕЩАЕМ ШОРТ, если цена выше EMA 200 (Глобальный аптренд)
        if (signal.action === 'SHORT' && features.emaFast > features.trendEma) {
             return this.reject('Against Trend: Price above EMA 200');
        }

        return this.allow();
    }
}
