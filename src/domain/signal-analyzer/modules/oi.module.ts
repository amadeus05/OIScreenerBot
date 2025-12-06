import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';

export class OIModule extends BaseModule {
    readonly name = 'oi' as const;

    private readonly config = MODULE_CONFIG.oi;

    // История для расчета медианы изменений OI
    private absDOIHistory: number[] = [];
    private readonly historySize = 200; // Увеличенное окно для стабильности

    // Защита от дублирования данных внутри свечи
    private lastProcessedTime = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];
        const currentBar = bars[bars.length - 1];

        // --- 0. VALIDATION ---
        // Защита от отсутствия данных
        if (!currentBar || features.dOI === undefined || features.priceReturn === undefined || features.flowImb === undefined) {
            return this.createOutput(0, 0, ['no_data']);
        }

        // --- 1. STATE MANAGEMENT ---
        if (currentBar.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.absDOIHistory.push(Math.abs(features.dOI));
                if (this.absDOIHistory.length > this.historySize) {
                    this.absDOIHistory.shift();
                }
            }
            this.lastProcessedTime = currentBar.ts;
        }

        // --- 2. WARM-UP & NORMALIZATION ---
        // Если истории совсем мало, мы не можем доверять сигналам
        if (this.absDOIHistory.length < 20) {
            return this.createOutput(0, 0, ['warming_up']);
        }

        const dOI = features.dOI;
        const priceRet = features.priceReturn;
        const flowImb = features.flowImb; // Delta / CVD
        const currentOI = currentBar.oi || 1; // Защита от деления на 0

        // Динамический fallback: 0.1% от текущего OI, если медиана вдруг 0
        const fallbackMedian = currentOI * 0.001;
        const medianAbsDOI = this.calculateMedian(this.absDOIHistory) || fallbackMedian;

        // Сила изменения OI (Cap at 2.5x to prevent insane scores on anomaly)
        const strength = Math.min(2.5, Math.abs(dOI) / medianAbsDOI);

        // Фильтр шума (Review Point 2)
        if (strength < 0.25) {
            return this.createOutput(0, 0, ['oi_neutral']);
        }

        let score = 0;
        let reliability = 0.5;

        // Пороги для Flow/Delta
        const STRONG_FLOW = 0.5; // Значительная дельта
        const WEAK_FLOW = 0.1;

        // --- 3. QUADRANT ANALYSIS ---

        // === A. OI РАСТЕТ (Вход денег) ===
        if (dOI > 0) {
            tags.push('oi_up');

            if (priceRet > 0) {
                // 1. Long Build-up (Trend Following)
                score = 0.6 * strength;
                tags.push('long_buildup');

                if (flowImb < -WEAK_FLOW) {
                    // Delta confirms buying
                    score += 0.2;
                    reliability += 0.2;
                    tags.push('delta_confirmed');
                } else if (flowImb > WEAK_FLOW) {
                    // FIX: Nuanced Absorption - Price rises, OI rises, but selling by market
                    if (strength > 1.8) {
                        // Strong absorption -> just reduce bullish signal, don't flip
                        score = Math.max(0, score - 0.3);
                        reliability *= 0.6;
                        tags.push('absorption_resistance');
                    } else if (flowImb > STRONG_FLOW) {
                        // Extreme absorption -> possible reversal, go bearish
                        score = -0.3;
                        reliability = 0.4;
                        tags.push('bearish_absorption');
                    }
                }
            }
            else if (priceRet < 0) {
                // 2. Short Build-up (Bearish Trend)
                score = -0.6 * strength;
                tags.push('short_buildup');

                if (flowImb < -WEAK_FLOW) {
                    score -= 0.2;
                    reliability += 0.2;
                    tags.push('delta_confirmed'); // Продажи по рынку подтверждают падение
                } else if (flowImb > WEAK_FLOW) {
                    // ABSORPTION DETECTED (Review Point 2 FIX)
                    // Цена падает, шорты открываются, но кто-то выкупает все рыночные ордера!
                    // Это предвестник разворота вверх или отскока.
                    score = 0.2; // Разворачиваем скор в плюс (или ближе к 0)
                    reliability = 0.4; // Рискованно
                    tags.push('bullish_absorption');
                }
            }
        }

        // === B. OI ПАДАЕТ (Выход денег) ===
        else if (dOI < 0) {
            tags.push('oi_down');

            // Детектор резкости движения (Review Point 3 FIX)
            const isFastMove = Math.abs(priceRet) > (features.atr / currentBar.c);

            if (priceRet > 0) {
                // 3. Short Covering
                score = 0.3 * strength;
                tags.push('short_covering');

                if (strength > 1.5 && isFastMove && flowImb > STRONG_FLOW) {
                    // Panic Short Squeeze
                    score = 0.8; // Очень сильно вверх краткосрочно
                    reliability = 0.8;
                    tags.push('panic_short_squeeze');
                } else if (flowImb < -WEAK_FLOW) {
                    // Рост цены, выход шортов, но продажи по рынку?
                    // Лимитный продавец использует закрытие шортов чтобы набрать шорт
                    score = 0.1;
                    tags.push('passive_selling_into_squeeze');
                }
            }
            else if (priceRet < 0) {
                // 4. Long Liquidation
                score = -0.3 * strength;
                tags.push('long_unwind');

                if (strength > 1.5 && isFastMove && flowImb < -STRONG_FLOW) {
                    // Panic Long Cascade
                    score = -0.8; // Крах
                    reliability = 0.8;
                    tags.push('panic_long_cascade');
                } else if (flowImb > WEAK_FLOW) {
                    // Падение, выход лонгов, но покупки по рынку?
                    // "Подставляют ведра" под ликвидации
                    score = -0.1;
                    tags.push('passive_buying_into_dump');
                }
            }
        }

        return this.createOutput(score, reliability, tags);
    }

    private calculateMedian(values: number[]): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // Reset state for backtesting (Review Point 8 FIX)
    public reset(): void {
        this.absDOIHistory = [];
        this.lastProcessedTime = 0;
    }
}