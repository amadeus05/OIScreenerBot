// ========================================================================
// FILE: src/domain/signal-analyzer/rules/scenarios/regime.scenarios.ts
// ========================================================================

import { Features } from '../../types';
import { ModuleWeights } from '../../types/config';
import { MarketRegime } from '../../services/regime-supervisor';

export interface RegimeScenario {
  id: string;
  regime: MarketRegime;
  priority: number;
  minMatchRatio?: number;
  conditions: ((f: Features, currentPrice: number) => boolean)[];
  weights: ModuleWeights;
}


export const RegimeScenarios: RegimeScenario[] = [];
