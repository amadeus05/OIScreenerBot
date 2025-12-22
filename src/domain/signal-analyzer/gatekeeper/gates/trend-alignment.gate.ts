import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';
import { Predicates as P } from '../../rules/predicates';
import { Logger } from '../../../../shared/logger';

export class TrendAlignmentGate extends BaseGate {
    readonly id = 'trend-alignment';
    private readonly logger = new Logger('TrendAlignmentGate');

    evaluate(ctx: GateContext): GateResult {
        const { signal, features, marketContext } = ctx;

        // 1. Макро-фильтр (BTC PUMP/CRASH) - оставляем как есть
        if (marketContext) {
            if (signal.action === 'LONG' && marketContext.globalTrend === 'CRASH') {
                return this.reject('Blocked: BTC CRASH in progress');
            }
            if (signal.action === 'SHORT' && marketContext.globalTrend === 'PUMP') {
                return this.reject('Blocked: BTC PUMP in progress');
            }
        }

        // 2. Определение силы сигнала для контртренда
        // Разрешаем контртренд ТОЛЬКО если это спец. паттерн разворота ("exhaustion", "pump_pullback")
        // Обычные дивергенции ("cvd_bearish_div") - НЕДОСТАТОЧНО сильны для входа против EMA 200.
        const isStrongReversal = signal.reasonTags.some(t =>
            t.includes('mean_reversion') || 
            t.includes('exhaustion') || 
            t.includes('pump_pullback') || 
            t.includes('dump_rebound')
        );

        // 3. Жесткий фильтр EMA 200
        // features.trendEma - это EMA 200
        // features.emaFast - это текущая структура цены (EMA 8)

        // Если мы хотим ЛОНГ, но цена ПОД EMA 200 -> ЗАПРЕТ (кроме сильного разворота)
        if (signal.action === 'LONG' && features.emaFast < features.trendEma) {
             if (!isStrongReversal) {
                 return this.reject('No LONG in Downtrend (Price < EMA200)');
             }
        }

        // Если мы хотим ШОРТ, но цена НАД EMA 200 -> ЗАПРЕТ (кроме сильного разворота)
        if (signal.action === 'SHORT' && features.emaFast > features.trendEma) {
             if (!isStrongReversal) {
                 return this.reject('No SHORT in Uptrend (Price > EMA200)');
             }
        }

        return this.allow();
    }
}
