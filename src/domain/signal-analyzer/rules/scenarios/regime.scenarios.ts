// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/regime.scenarios.ts
// ========================================================================

import { Features } from '../../types';
import { ModuleWeights } from '../../types/config';
import { Predicates as P } from '../predicates';
import { MarketRegime } from '../../services/regime-supervisor';

export interface RegimeScenario {
  id: string;
  regime: MarketRegime;
  priority: number;
  minMatchRatio?: number;
  conditions: ((f: Features, currentPrice: number) => boolean)[];
  weights: ModuleWeights;
}

const VOLATILE_WEIGHTS: ModuleWeights = {
  orderflow: 0.3,
  liquidations: 0.5,
  levels: 0.1,
  momentum: 0.0,
  oi: 0.1,
};

export const RegimeScenarios: RegimeScenario[] = [];
