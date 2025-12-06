import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { RollingStats } from '../utils/rolling-stats';

const EPS = 1e-10;

export class MomentumModule extends BaseModule {
    readonly name = 'momentum' as const;

    private readonly config = MODULE_CONFIG.momentum;

    // === STATE MANAGEMENT ===
    // Храним время последнего обработанного бара
    private lastProcessedTime = 0;

    // Значение emaDiff, зафиксированное на момент закрытия ПРЕДЫДУЩЕГО бара
    private lastClosedEmaDiff = 0;

    // Значение emaDiff на ТЕКУЩЕМ тике (будет сохранено как lastClosed при смене бара)
    private currentTickEmaDiff = 0;

    // Adaptive volatility tracking
    private recentVolatility = new RollingStats(100);

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];
        const currentBar = bars[bars.length - 1];
        const currentPrice = currentBar.c;

        // ====================================================================
        // 1. УПРАВЛЕНИЕ СОСТОЯНИЕМ (New Bar Detection)
        // ====================================================================
        if (currentBar.ts > this.lastProcessedTime) {
            // Начался новый бар.
            // Значение, которое было на последнем тике прошлого бара, становится историческим.
            if (this.lastProcessedTime !== 0) {
                this.lastClosedEmaDiff = this.currentTickEmaDiff;
            }
            this.lastProcessedTime = currentBar.ts;
        }

        // ====================================================================
        // 2. Adaptive Dead Market Filter
        // ====================================================================
        const volatilityPct = (features.atr / currentPrice) * 100;

        // Track recent volatility for adaptive threshold
        this.recentVolatility.push(volatilityPct);
        const medianVol = this.recentVolatility.median();

        // Adaptive threshold: 30% of median volatility, but min 0.01% (absolute stillness)
        const adaptiveThreshold = Math.max(medianVol * 0.3, 0.01);

        if (volatilityPct < adaptiveThreshold) {
            tags.push('dead_market');
            return this.createOutput(0, 0.1, tags);
        }

        // Low volatility warning if below 50% of median
        if (volatilityPct < medianVol * 0.5) {
            tags.push('low_volatility_warning');
        }

        // ====================================================================
        // 3. Расчет Моментума
        // ====================================================================
        const emaDiff = features.emaFast - features.emaSlow;

        // Сохраняем текущее значение для будущего использования
        this.currentTickEmaDiff = emaDiff;

        // Нормализация
        const m = emaDiff / Math.max(features.emaSlow, EPS);
        const rawScore = this.scaledTanh(m, this.config.scaleFactor);
        const isBullish = rawScore > 0;

        // ====================================================================
        // 4. Анализ Динамики (Stateful Approach)
        // ====================================================================
        // Сравниваем текущий спред со спредом закрытия прошлого бара.
        // Это самый надежный способ определить, растет спред или падает.

        let isAccelerating = false;

        // Проверяем, есть ли у нас история (не первый запуск)
        if (Math.abs(this.lastClosedEmaDiff) > EPS) {
            isAccelerating = Math.abs(emaDiff) > Math.abs(this.lastClosedEmaDiff);
        } else {
            // Если истории нет, пробуем грубую оценку внутри текущего бара 
            // или считаем false, чтобы не рисковать
            isAccelerating = false;
        }

        // Формируем теги
        if (Math.abs(rawScore) > 0.2) {
            if (isBullish) {
                tags.push('bullish_structure');
                if (rawScore > 0.6) tags.push('strong_uptrend');
            } else {
                tags.push('bearish_structure');
                if (rawScore < -0.6) tags.push('strong_downtrend');
            }

            if (isAccelerating) {
                tags.push('momentum_accelerating');
            } else {
                tags.push('momentum_decaying');
            }
        } else {
            tags.push('ranging_market');
        }

        // ====================================================================
        // 5. Расчет надежности (Reliability)
        // ====================================================================
        let reliability = 0.5;

        // Штраф за низкую волатильность (даже если прошли фильтр dead_market)
        if (volatilityPct < 0.5) reliability -= 0.2;

        // A. Volume logic
        if (features.volZ > 0.5) reliability += 0.15;
        if (features.volZ > 2.0) {
            reliability += 0.15;
            tags.push('high_volume_support');
        }
        if (features.volZ < -0.5) {
            reliability -= 0.2;
            tags.push('low_volume_divergence');
        }

        // B. Acceleration Bonus
        if (isAccelerating) reliability += 0.1;
        else reliability -= 0.15;

        // C. Price Action Check (Anti-Lag)
        const momentumDirectionMatchesPrice = (rawScore > 0 && currentPrice > features.emaSlow) ||
            (rawScore < 0 && currentPrice < features.emaSlow);

        // FIX: Штрафуем только если Моментум УВЕРЕННО говорит в одну сторону
        // Если rawScore слабый (< 0.3), нет смысла штрафовать за расхождение
        if (Math.abs(rawScore) > 0.3 && !momentumDirectionMatchesPrice) {
            tags.push('price_counter_trend');
            reliability -= 0.2; // Было 0.3, снизили чтобы не убивать сигнал
        }

        // D. Parabolic Setup
        if (isAccelerating && features.volZ > 1.5 && volatilityPct > 0.3) { // Поднял порог волатильности для параболы
            tags.push('parabolic_phase_start');
            if (momentumDirectionMatchesPrice) {
                reliability = Math.min(reliability + 0.2, 1.0);
            }
        }

        if (Math.abs(rawScore) < 0.25) {
            reliability = 0.2;
        }

        return this.createOutput(rawScore, reliability, tags);
    }

    reset(): void {
        this.lastProcessedTime = 0;
        this.lastClosedEmaDiff = 0;
        this.currentTickEmaDiff = 0;
    }
}