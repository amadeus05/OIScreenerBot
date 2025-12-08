import { Features, ModuleName } from '../types';
import { ModuleWeights, DEFAULT_CONFIG } from '../types/config';

export type MarketRegime = 'RANGING' | 'TRENDING' | 'VOLATILE';

export interface RegimeAnalysis {
    regime: MarketRegime;
    confidence: number; // Насколько мы уверены в этом режиме (0-1)
    adjustedWeights: ModuleWeights;
    reason: string;
}
/**
 *  Почему это сработает?
    Авто-балансировка: Когда на рынке начнется "мясорубка" (как бывает при новостях), 
    features.liquidationSignal или volZ  зашкалят. 
    Супервайзер мгновенно переключится в VOLATILE и выкрутит вес модуля Liquidations на 50%. 
    Бот перестанет смотреть на EMA и начнет ловить "дно" сквиза.
    Защита от "пилы": В скучном боковике, где emaFast и emaSlow слиплись, 
    режим станет RANGING. Вес Momentum упадет до 0.05. 
    Это спасает от кучи убыточных сделок, когда бот пытается купить "начало тренда", которого нет.
    Использование имеющихся данных: Мы использовали features.atr, features.emaFast, 
    features.volZ — все это уже считается в твоем коде . Никаких накладных расходов на производительность.
 */
export class RegimeSupervisor {
    private readonly baseWeights: ModuleWeights;
    
    // Пороги для определения режимов
    // Можно вынести в конфиг, но для старта оставим здесь
    private readonly TREND_EMA_DIFF_THRESHOLD = 0.002; // 0.2% разницы между EMA Fast и Slow
    private readonly VOLATILITY_Z_THRESHOLD = 2.5;     // VolZ > 2.5 считается всплеском
    private readonly ATR_PERCENT_THRESHOLD = 0.005;    // Если ATR > 0.5% от цены - волатильность высокая

    constructor(baseWeights: ModuleWeights = DEFAULT_CONFIG.weights) {
        this.baseWeights = baseWeights;
    }

    /**
     * Определяет текущий режим рынка и возвращает адаптированные веса
     */
    public analyze(features: Features, currentPrice: number): RegimeAnalysis {
        // 1. Рассчитываем метрики режима
        const emaDiffPct = Math.abs(features.emaFast - features.emaSlow) / currentPrice;
        const atrPct = features.atr / currentPrice;
        const isHighVolume = features.volZ > this.VOLATILITY_Z_THRESHOLD;
        const isLiquidationEvent = features.liquidationSignal;

        // 2. Определение режима (Приоритет: Volatile -> Trending -> Ranging)
        
        // A. VOLATILE (Приоритет №1: Аномалии, ликвидации, паника)
        if (isLiquidationEvent || isHighVolume || atrPct > this.ATR_PERCENT_THRESHOLD * 1.5) {
            return {
                regime: 'VOLATILE',
                confidence: 0.9,
                reason: isLiquidationEvent ? 'Active Liquidation Cascade' : 'Extreme Volume/Volatility',
                adjustedWeights: this.getVolatileWeights()
            };
        }

        // B. TRENDING (Приоритет №2: Расхождение средних)
        // Если EMA разошлись и цена выше/ниже обеих
        const isTrendStructure = (features.emaFast > features.emaSlow && currentPrice > features.emaFast) ||
                                 (features.emaFast < features.emaSlow && currentPrice < features.emaFast);

        if (emaDiffPct > this.TREND_EMA_DIFF_THRESHOLD && isTrendStructure) {
            return {
                regime: 'TRENDING',
                confidence: 0.8,
                reason: `Strong Trend Structure (EMA Diff: ${(emaDiffPct * 100).toFixed(2)}%)`,
                adjustedWeights: this.getTrendingWeights()
            };
        }

        // C. RANGING (Default: Средние переплетены, волатильность в норме)
        return {
            regime: 'RANGING',
            confidence: 0.7,
            reason: 'Low Volatility / EMA Convergence',
            adjustedWeights: this.getRangingWeights()
        };
    }

    /**
     * Веса для БОКОВИКА
     * Логика: Уровни и Orderflow решают все. Импульс бесполезен (пилит).
     */
    private getRangingWeights(): ModuleWeights {
        return {
            ...this.baseWeights,
            levels: 0.35,      // ↑ Повышаем (SFP работают идеально во флэте)
            orderflow: 0.40,   // ↑ Повышаем (Внутри боковика видно набор позиций)
            momentum: 0.05,    // ↓ Убиваем (Моментум во флэте дает ложные сигналы)
            oi: 0.10,
            liquidations: 0.10 // Ликвидаций во флэте мало
        };
    }

    /**
     * Веса для ТРЕНДА
     * Логика: Momentum и OI (поддержка тренда) важны. Уровни часто пробиваются.
     */
    private getTrendingWeights(): ModuleWeights {
        return {
            ...this.baseWeights,
            levels: 0.15,      // ↓ Снижаем (Уровни часто прошиваются)
            orderflow: 0.30,
            momentum: 0.30,    // ↑ Повышаем (Тренд наш друг)
            oi: 0.15,          // ↑ OI подтверждает силу тренда
            liquidations: 0.10
        };
    }

    /**
     * Веса для ВОЛАТИЛЬНОСТИ / СКВИЗОВ
     * Логика: Только ликвидации и экстремальный Orderflow. ТА не работает.
     */
    private getVolatileWeights(): ModuleWeights {
        return {
            ...this.baseWeights,
            levels: 0.10,      // ТА ломается на панике
            orderflow: 0.30,   // Важно видеть поглощение паники
            momentum: 0.00,    // ↓ Полностью отключаем (опаздывает)
            oi: 0.10,
            liquidations: 0.50 // ↑↑ МАКСИМУМ: Торгуем только сквизы и каскады
        };
    }
}