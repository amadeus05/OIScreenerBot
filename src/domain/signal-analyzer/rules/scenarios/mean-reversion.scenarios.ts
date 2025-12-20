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
  {
    id: 'dump_rebound_v2',
    name: 'Dump Rebound Exhaustion',

    conditions: [
      P.Momentum.IsKindOfDump,          // сильное падение за 30m
      (f, ctx) => ctx.isExhausted === true,
      P.Liq.NoLongBias,                 // нет агрессивных лонговых ликвидаций
      P.Absorption.NoSellerBias,        // нет поглощения продавцов
    ],

    baseScore: 0.85,  // LONG!
    reliability: 0.88,
    tags: ['mean_reversion', 'dump_rebound', 'exhaustion'],
    useStrengthMultiplier: true,
  },
];
