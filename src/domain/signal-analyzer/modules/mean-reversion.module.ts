import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { BaseModule } from './base-module';
import { MeanReversionScenarios } from '../rules/scenarios/mean-reversion.scenarios';

export class MeanReversionModule extends BaseModule {
  readonly name = 'meanReversion' as const;

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

    const exhaustionContext = {
      currentPrice: currentBar.c,
      marketContext,
      isExhausted:
        features.volZ > 2.5 ||
        (features.pChange30m >= 0.08 && features.flowImb < 0.15) ||
        (features.pChange30m >= 0.08 && features.dCVD < 0),
    };

    for (const scenario of MeanReversionScenarios) {
      const isMatch = scenario.conditions.every((condition: any) =>
        condition(features, exhaustionContext),
      );

      if (!isMatch) continue;

      let score = scenario.baseScore;

      if (scenario.useStrengthMultiplier && exhaustionContext.isExhausted) {
        const pChange30m = features.pChange30m;
        if (pChange30m && Math.abs(pChange30m) > 0.08) {
          const excess = Math.abs(pChange30m) - 0.08;
          const multiplier = 1 + Math.min(excess * 6, 0.4);
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
