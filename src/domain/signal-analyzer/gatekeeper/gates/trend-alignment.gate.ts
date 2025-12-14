import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';
import { Predicates as P } from '../../rules/predicates';

export class TrendAlignmentGate extends BaseGate {
    readonly id = 'trend-alignment';

    evaluate(ctx: GateContext): GateResult {
        const { signal, features, marketContext } = ctx;

        // Если это разворотная стратегия (SFP, Mean Reversion), тренд можно игнорировать
        const isReversal = signal.reasonTags.some(t =>
            t.includes('reversal') || t.includes('SFP') || t.includes('mean_reversion')
        );

        if (isReversal) return this.allow();

        // Для трендовых стратегий проверяем глобальный тренд
        if (signal.action === 'LONG' && !P.Trend.IsBullish(features, { currentPrice: features.emaFast })) { // упрощенный контекст
            // Если есть глобальный контекст, проверяем его
            if (marketContext && marketContext.globalTrend === 'DOWN') {
                return this.reject('Against Global Downtrend');
            }
        }

        if (signal.action === 'SHORT' && !P.Trend.IsBearish(features, { currentPrice: features.emaFast })) {
            if (marketContext && marketContext.globalTrend === 'UP') {
                return this.reject('Against Global Uptrend');
            }
        }

        return this.allow();
    }
}