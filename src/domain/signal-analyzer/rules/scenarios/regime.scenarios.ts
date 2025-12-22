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

export const RegimeScenarios: RegimeScenario[] = [
  {
    id: 'trend_up',
    regime: 'TRENDING',
    priority: 80,
    minMatchRatio: 0.6,
    conditions: [
      (f, price) => price > f.trendEma,
      (f) => f.emaFast > f.emaSlow,
      // 🔥 БЫЛО 0.01 (1%), СТАЛО 0.005 (0.5%) — ловим начало движения
      (f) => f.pChange30m > 0.005,       
      (f) => f.volZ > -0.3
    ],
    weights: {
      momentum: 0.80,      // БЫЛО 0.70. Увеличиваем! В тренде главное — инерция.
      orderflow: 0.20,
      meanReversion: 0.00, // Отключаем полностью в тренде. Не надо ловить откаты, надо ехать.
      oi: 0.0, liquidations: 0.0, levels: 0.0,
    },
  },
  {
    id: 'trend_down',
    regime: 'TRENDING',
    priority: 80,
    minMatchRatio: 0.6,
    conditions: [
      (f, price) => price < f.trendEma,
      (f) => f.emaFast < f.emaSlow,
      // 🔥 БЫЛО -0.01, СТАЛО -0.005
      (f) => f.pChange30m < -0.005,
      (f) => f.volZ > -0.3
    ],
    weights: {
      momentum: 0.80,      // БЫЛО 0.70. Увеличиваем! В тренде главное — инерция.
      orderflow: 0.20,
      meanReversion: 0.00, // Отключаем полностью в тренде. Не надо ловить откаты, надо ехать.
      oi: 0.0, liquidations: 0.0, levels: 0.0,
    },
  },
  {
    id: 'volatile',
    regime: 'VOLATILE',
    priority: 90,
    minMatchRatio: 0.5,
    conditions: [
      // Чуть снизили порог волатильности для входа
      (f) => Math.abs(f.volZ) > 1.5 || Math.abs(f.pChange30m) > 0.03, 
      (f) => Math.abs(f.priceReturn) > 0.002,
    ],
    weights: {
      orderflow: 0.40,
      momentum: 0.40, // Баланс
      meanReversion: 0.20,
      oi: 0.0, liquidations: 0.0, levels: 0.0,
    },
  },
  {
    id: 'extreme',
    regime: 'EXTREME',
    priority: 100,
    minMatchRatio: 0.7,
    conditions: [
      (f) => Math.abs(f.pChange30m) > 0.08,
      (f) => Math.abs(f.volZ) > 3.0,
    ],
    weights: {
      // В экстремумах только разворот!
      meanReversion: 0.90, 
      orderflow: 0.10,
      momentum: 0.00, // Не лезем в уходящий поезд
      oi: 0.0, liquidations: 0.0, levels: 0.0,
    },
  },
];