// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/oi.scenarios.ts
// ========================================================================

import { MarketScenario } from '../types';
import { Predicates as P } from '../predicates';

// Набор базовых сценариев по открытым интересам.
// Сфокусированы на согласованности цены, потока и OI, с мягкими фильтрами
// ликвидаций/поглощения. Все сценарии предполагают, что Volume не нулевой
// (volZ > 0.3) и используют strength-множитель модуля.
export const OiScenarios: MarketScenario[] = [
  // {
  //   id: 'oi_long_inflow_agreement',
  //   name: 'Long: OI Inflow + Buying Flow',
  //   conditions: [
  //     P.OI.IsRising,
  //     (f) => f.oiFlow > 0.35,
  //     P.Price.IsUp,
  //     P.Flow.IsBuying,
  //     (f) => f.volZ > 0.3,
  //     P.Absorption.NoSellerBias,
  //     P.Liq.NoShortBias,
  //   ],
  //   baseScore: 0.65,
  //   reliability: 0.65,
  //   tags: ['oi_long', 'inflow_agreement', 'flow_buying'],
  //   useStrengthMultiplier: true,
  // },
  // {
  //   id: 'oi_short_inflow_agreement',
  //   name: 'Short: OI Inflow + Selling Flow',
  //   conditions: [
  //     P.OI.IsRising,
  //     (f) => f.oiFlow < -0.35,
  //     P.Price.IsDown,
  //     P.Flow.IsSelling,
  //     (f) => f.volZ > 0.3,
  //     P.Absorption.NoBuyerBias,
  //     P.Liq.NoLongBias,
  //   ],
  //   baseScore: -0.65,
  //   reliability: 0.65,
  //   tags: ['oi_short', 'inflow_agreement', 'flow_selling'],
  //   useStrengthMultiplier: true,
  // },
  // {
  //   id: 'oi_short_capitulation',
  //   name: 'Short: Capitulation With Rising OI',
  //   conditions: [
  //     P.OI.IsRising,
  //     P.Price.IsDown,
  //     P.Flow.IsStrongSelling,
  //     (f) => f.volZ > 0.6,
  //     (f) => f.oiFlow < -0.2,
  //     P.Absorption.NoBuyerBias,
  //   ],
  //   baseScore: -0.75,
  //   reliability: 0.68,
  //   tags: ['oi_short', 'capitulation', 'strong_selling'],
  //   useStrengthMultiplier: true,
  // },
  // {
  //   id: 'oi_short_squeeze_long',
  //   name: 'Long: Short Squeeze (OI Falling + Price Up)',
  //   conditions: [
  //     P.OI.IsFalling,
  //     P.Price.IsUp,
  //     P.Flow.IsStrongBuying,
  //     (f) => f.oiFlow > 0 || Math.abs(f.oiFlow) < 0.15, // нейтральный/слегка положительный поток
  //     (f) => f.volZ > 0.4,
  //     P.Absorption.NoSellerBias,
  //     P.Liq.NoShortBias,
  //   ],
  //   baseScore: 0.45,
  //   reliability: 0.55,
  //   tags: ['oi_long', 'short_squeeze', 'oi_decline'],
  //   useStrengthMultiplier: true,
  // },
];
