import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

export const MeanReversionScenarios: MarketScenario[] = [
  {
    id: 'pump_pullback_v2',
    name: 'Pump Pullback Exhaustion',

    conditions: [
      P.Momentum.IsKindOfPump,
      (f, ctx) => ctx.isExhausted === true,
      P.Liq.NoShortBias,
      P.Absorption.NoBuyerBias,
    ],

    baseScore: -0.85,
    reliability: 0.88,
    tags: ['mean_reversion', 'pump_pullback', 'exhaustion'],
    useStrengthMultiplier: true,
  },
];
