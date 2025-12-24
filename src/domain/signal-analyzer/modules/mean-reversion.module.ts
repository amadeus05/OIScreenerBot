import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { BaseModule } from './base-module';
import { MeanReversionScenarios } from '../rules/scenarios/mean-reversion.scenarios';

export class MeanReversionModule extends BaseModule {
  readonly name = 'meanReversion' as const;

  // 🔥 PRO: ATR-normalized thresholds
  private readonly MIN_IMPULSE_ATR = 3.0;  // 3 ATR = минимальный импульс для mean reversion
  private readonly STRONG_IMPULSE_ATR = 5.0; // 5 ATR = сильный импульс (множитель силы)

  analyze(
    features: Features,
    bars: (BarData | AggregatedBar)[],
    marketContext?: any,
  ): ModuleOutput {

    const currentBar = bars[bars.length - 1];
    if (!currentBar) return this.createOutput(0, 0, ['no_data']);

    let bestScore = 0;
    let maxReliability = 0;
    const activeTags = new Set<string>();

    // 🔥 Используем trueImpulseATR вместо pChange30m
    const dominantImpulseATR = features.trueImpulseATR;

    const exhaustionContext = {
      currentPrice: currentBar.c,
      marketContext,
      // 🔥 Теперь exhaustion определяется через ATR
      // 3 ATR = сильный памп/дамп, достаточно для разворота
      isExhausted:
        features.volZ > 2.5 ||
        // PUMP exhaustion (for SHORT)
        (dominantImpulseATR >= this.MIN_IMPULSE_ATR && features.flowImb < 0.15) ||
        (dominantImpulseATR >= this.MIN_IMPULSE_ATR && features.dCVD < 0) ||
        // DUMP exhaustion (for LONG) - symmetric logic
        (dominantImpulseATR <= -this.MIN_IMPULSE_ATR && features.flowImb > -0.15) ||
        (dominantImpulseATR <= -this.MIN_IMPULSE_ATR && features.dCVD > 0),
    };

    for (const scenario of MeanReversionScenarios) {
      const isMatch = scenario.conditions.every((condition: any) =>
        condition(features, exhaustionContext),
      );

      if (!isMatch) continue;

      let score = scenario.baseScore;

      // 🔥 Множитель силы теперь на основе ATR
      if (scenario.useStrengthMultiplier && exhaustionContext.isExhausted) {
        if (Math.abs(dominantImpulseATR) > this.STRONG_IMPULSE_ATR) {
          const excess = Math.abs(dominantImpulseATR) - this.STRONG_IMPULSE_ATR;
          const multiplier = 1 + Math.min(excess * 0.08, 0.4); // 0.08 per ATR
          score *= multiplier;
        }
      }

      if (Math.abs(score) > Math.abs(bestScore)) {
        bestScore = score;
        maxReliability = scenario.reliability;
      }

      scenario.tags.forEach((t: string) => activeTags.add(t));
    }

    return this.createOutput(
      this.clampScore(bestScore),
      this.clampScore(maxReliability),
      Array.from(activeTags),
    );
  }

  reset(): void { }
}

