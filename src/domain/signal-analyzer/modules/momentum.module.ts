// src/domain/signal-analyzer/modules/momentum.module.ts

import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { BaseModule } from './base-module';

export class MomentumModule extends BaseModule {
    readonly name = 'momentum' as const;

    // 🔥 PRO: ATR-normalized thresholds (вместо фиксированных %)
    private readonly IMPULSE_THRESH_ATR = 2.0;  // 2 ATR = минимальный импульс для трейда
    private readonly EXTREME_THRESH_ATR = 4.0;  // 4 ATR = экстремальное движение (не лезем)

    analyze(features: Features, bars: (BarData | AggregatedBar)[], context?: any): ModuleOutput {
        let score = 0;
        const tags = new Set<string>();

        const { trueImpulseATR, priceReturn, atr, volZ } = features;

        // ⛔ GUARD: не лезем в климакс (используем ATR-нормализованный порог)
        if (Math.abs(trueImpulseATR) > this.EXTREME_THRESH_ATR && volZ > 2.5) {
            return this.createOutput(0, 0.2, ['extreme_guard']);
        }

        // 1. Pullback в сильном движении (классика)
        // Если цена прошла >= 2 ATR за 30м, это сильный трендовый импульс
        if (Math.abs(trueImpulseATR) >= this.IMPULSE_THRESH_ATR) {
            const impulseDir = trueImpulseATR > 0 ? 1 : -1;
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
        // Используем ATR-порог 1.5 ATR вместо 3%
        if (Math.abs(trueImpulseATR) >= 1.5 && Math.abs(priceReturn) > 0.003) {
            const sameDir = (trueImpulseATR > 0 && priceReturn > 0) || (trueImpulseATR < 0 && priceReturn < 0);
            if (sameDir && volZ > 0.3) {
                score += trueImpulseATR > 0 ? 0.35 : -0.35;
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

        // Reliability теперь тоже на основе ATR
        const reliability = Math.min(0.9, 0.5 + Math.abs(trueImpulseATR) * 0.15);

        return this.createOutput(
            this.clampScore(score),
            this.clampScore(reliability),
            Array.from(tags)
        );
    }

    reset(): void { }
}
