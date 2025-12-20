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

/**
 * Базовый набор сценариев режима рынка.
 * Если ни один не сработает, RegimeSupervisor вернёт fallback RANGING.
 */
export const RegimeScenarios: RegimeScenario[] = [
  {
    id: 'trend_up',
    regime: 'TRENDING',
    priority: 80,
    minMatchRatio: 0.6,
    conditions: [
      (f, price) => price > f.trendEma,                  // Цена выше EMA200
      (f) => f.emaFast > f.emaSlow,                     // Локальный ап-тренд
      (f) => f.pChange30m > 0.01,                       // Рост за 30м > 1%
      (f) => f.volZ > -0.3                              // Нет явного дефицита объёма
    ],
    weights: {
      orderflow: 0.40,
      momentum: 0.45,
      meanReversion: 0.15,
      oi: 0.0,
      liquidations: 0.0,
      levels: 0.0,
    },
  },
  {
    id: 'trend_down',
    regime: 'TRENDING',
    priority: 80,
    minMatchRatio: 0.6,
    conditions: [
      (f, price) => price < f.trendEma,                  // Цена ниже EMA200
      (f) => f.emaFast < f.emaSlow,                     // Локальный даун-тренд
      (f) => f.pChange30m < -0.01,                      // Падение за 30м > 1%
      (f) => f.volZ > -0.3
    ],
    weights: {
      orderflow: 0.40,
      momentum: 0.45,
      meanReversion: 0.15,
      oi: 0.0,
      liquidations: 0.0,
      levels: 0.0,
    },
  },
  {
    id: 'volatile',
    regime: 'VOLATILE',
    priority: 90,
    minMatchRatio: 0.5,
    conditions: [
      (f) => Math.abs(f.volZ) > 2.0 || Math.abs(f.pChange30m) > 0.04, // Сильная волатильность/движение
      (f) => Math.abs(f.priceReturn) > 0.002,                         // Есть импульс внутри бара
    ],
    weights: {
      orderflow: 0.50,
      momentum: 0.35,
      meanReversion: 0.15,
      oi: 0.0,
      liquidations: 0.0,
      levels: 0.0,
    },
  },
  {
    id: 'extreme',
    regime: 'EXTREME',
    priority: 100,
    minMatchRatio: 0.7,
    conditions: [
      (f) => Math.abs(f.pChange30m) > 0.08,  // >8% за 30м
      (f) => Math.abs(f.volZ) > 3.0,         // Кульминационный объём
    ],
    weights: {
      orderflow: 0.55,
      momentum: 0.30,
      meanReversion: 0.15,
      oi: 0.0,
      liquidations: 0.0,
      levels: 0.0,
    },
  },
];
