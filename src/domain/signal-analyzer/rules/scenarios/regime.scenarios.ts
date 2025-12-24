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
    minMatchRatio: 1.0, // Требуем все условия
    conditions: [
      (f, price) => price > f.trendEma,
      (f) => f.emaFast > f.emaSlow,
      (f) => f.trueImpulseATR > 0.5, // Импульс есть
      (f) => f.volZ > -0.3
    ],
    weights: {
      momentum: 0.80,       // ТОЛЬКО по тренду
      orderflow: 0.20,      // Подтверждение
      
      // ⛔ ГЛАВНОЕ: УБИВАЕМ КОНТР-ТРЕНД
      // Даже если MeanReversion кричит "Шорти!", мы его не слышим.
      meanReversion: 0.00,  
      
      oi: 0.0, liquidations: 0.0, levels: 0.0,
    },
  },
  {
    id: 'trend_down',
    regime: 'TRENDING',
    priority: 80,
    minMatchRatio: 1.0,
    conditions: [
      (f, price) => price < f.trendEma,
      (f) => f.emaFast < f.emaSlow,
      // 🔥 PRO: ATR-порог для даунтренда
      (f) => f.trueImpulseATR < -0.5,
      (f) => f.volZ > -0.3
    ],
    weights: {
      momentum: 0.80,
      orderflow: 0.20,
      meanReversion: 0.00,
      oi: 0.0, liquidations: 0.0, levels: 0.0,
    },
  },
  {
    id: 'volatile',
    regime: 'VOLATILE',
    priority: 90,
    minMatchRatio: 0.5,
    conditions: [
      // 🔥 PRO: 1.5 ATR = волатильный режим
      (f) => Math.abs(f.volZ) > 1.5 || Math.abs(f.trueImpulseATR) > 1.5,
      (f) => Math.abs(f.priceReturn) > 0.002,
    ],
    weights: {
      orderflow: 0.40,
      momentum: 0.40,
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
      // 🔥 PRO: 5 ATR = экстремальное движение (переход к mean reversion)
      (f) => Math.abs(f.trueImpulseATR) > 5.0,
      (f) => Math.abs(f.volZ) > 3.0,
    ],
    weights: {
      meanReversion: 0.90,
      orderflow: 0.10,
      momentum: 0.00,
      oi: 0.0, liquidations: 0.0, levels: 0.0,
    },
  },
];
