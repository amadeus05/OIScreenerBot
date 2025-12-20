// src/domain/signal-analyzer/modules/momentum.module.ts

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { BaseModule } from './base-module';

export class MomentumModule extends BaseModule {
    readonly name = 'momentum' as const;

    private readonly IMPULSE_THRESH = 0.04; // 4% импульс за 30m (было 8%)

    analyze(features: Features, bars: (BarData | AggregatedBar)[], context?: any): ModuleOutput {
        let score = 0;
        const tags = new Set<string>();

        const { pChange30m, priceReturn, atr, volZ } = features;

        // 1. Pullback в сильном движении (классика)
        if (Math.abs(pChange30m) >= this.IMPULSE_THRESH) {
            const impulseDir = pChange30m > 0 ? 1 : -1;
            const recentMove = priceReturn * impulseDir;

            // Откат против импульса со снижением объёма
            if (recentMove < -0.005 && volZ < 0.3) {
                score += impulseDir > 0 ? 0.7 : -0.7; // продолжение импульса
                tags.add('momentum_pullback');
                tags.add(impulseDir > 0 ? 'bullish_continuation' : 'bearish_continuation');
            }
        }

        // 2. Breakout с объёмом
        if (volZ > 1.0 && atr > 0 && Math.abs(priceReturn) > atr * 0.008) {
            score += priceReturn > 0 ? 0.5 : -0.5;
            tags.add('volume_breakout');
        }

        // 3. Сильный моментум (продолжение движения)
        if (Math.abs(pChange30m) >= 0.03 && Math.abs(priceReturn) > 0.003) {
            const sameDir = (pChange30m > 0 && priceReturn > 0) || (pChange30m < 0 && priceReturn < 0);
            if (sameDir && volZ > 0.3) {
                score += pChange30m > 0 ? 0.35 : -0.35;
                tags.add('trend_continuation');
            }
        }

        // 4. CVD Consistency Check (мягкий штраф)
        const { cvdDominance30m } = features;
        if (cvdDominance30m !== undefined) {
            if (score > 0.4 && cvdDominance30m < -0.08) {
                score *= 0.7;
                tags.add('cvd_conflict');
            }
            if (score < -0.4 && cvdDominance30m > 0.08) {
                score *= 0.7;
                tags.add('cvd_conflict');
            }
        }

        const reliability = Math.min(0.9, 0.5 + Math.abs(pChange30m) * 4);

        return this.createOutput(
            this.clampScore(score),
            this.clampScore(reliability),
            Array.from(tags)
        );
    }

    reset(): void { }
}
