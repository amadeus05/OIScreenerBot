// src/domain/signal-analyzer/modules/orderflow.module.ts

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { BaseModule } from './base-module';

export class OrderflowModule extends BaseModule {
    readonly name = 'orderflow' as const;

    private readonly CVD_Z_THRESH = 1.2;      // было 1.6
    private readonly OI_FLOW_THRESH = 0.5;    // было 0.8
    private readonly VOL_Z_MIN = 0.5;         // было 0.9 — минимум объёма для доверия

    analyze(features: Features, bars: (BarData | AggregatedBar)[], context?: any): ModuleOutput {
        let score = 0;
        const tags = new Set<string>();

        const { deltaZ, volZ, oiFlow, cvdDominance30m, flowImb, priceReturn } = features;

        // 1. CVD Divergence (цена против потока)
        if (volZ > this.VOL_Z_MIN) {
            // Цена вверх, но CVD вниз → скрытая продажа → SHORT
            if (priceReturn > 0 && deltaZ < -this.CVD_Z_THRESH) {
                score -= 0.65;
                tags.add('cvd_bearish_div');
            }
            // Цена вниз, но CVD вверх → скрытая покупка → LONG
            if (priceReturn < 0 && deltaZ > this.CVD_Z_THRESH) {
                score += 0.65;
                tags.add('cvd_bullish_div');
            }

            // 30m CVD Dominance усиливает сигнал
            if (Math.abs(cvdDominance30m) > 0.04) {
                score += cvdDominance30m > 0 ? 0.25 : -0.25; // положительный CVD → long bias
                tags.add('cvd_dominance');
            }
        }

        // 2. OI Flow (увеличение OI + направление)
        if (Math.abs(oiFlow) > this.OI_FLOW_THRESH) {
            if (oiFlow > 0) {
                // OI растёт → новые деньги, усиливает текущий импульс
                score += priceReturn > 0 ? 0.3 : -0.3;
                tags.add('oi_inflow');
            } else {
                // OI падает → закрытие позиций
                score += priceReturn < 0 ? 0.3 : -0.3;
                tags.add('oi_outflow');
            }
        }

        // 3. Flow Imbalance (агрессивный buying/selling)
        if (Math.abs(flowImb) > 0.18 && volZ > 0.5) {
            score += flowImb > 0 ? 0.4 : -0.4; // положительный flowImb = больше buy volume → long
            tags.add('flow_imbalance');
        }

        // 4. 🔥 Consistency Check (мягкий штраф за противоречия)
        if (oiFlow > 0.5 && cvdDominance30m > 0.05 && score < 0) {
            score *= 0.6; // Мягкий штраф
            tags.add('flow_conflict_bullish');
        }
        if (oiFlow > 0.5 && cvdDominance30m < -0.05 && score > 0) {
            score *= 0.6; // Мягкий штраф
            tags.add('flow_conflict_bearish');
        }

        const reliability = Math.min(0.95, 0.6 + volZ * 0.35);

        return this.createOutput(
            this.clampScore(score),
            this.clampScore(reliability),
            Array.from(tags)
        );
    }

    reset(): void { }
}
