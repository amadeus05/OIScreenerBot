import { Features, ModuleOutput, BarData, AggregatedBar } from '../types';
import { MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { sigmoid, clamp } from '../utils/rolling-stats'; // Предполагаем наличие

export class OrderflowModule extends BaseModule {
    readonly name = 'orderflow' as const;

    private readonly config = MODULE_CONFIG.orderflow;

    // История dCVD для расчета волатильности потока
    private dCVDHistory: number[] = [];
    private readonly historySize = 50;

    // Защита от дублирования данных внутри бара
    private lastProcessedTime = 0;

    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];
        const currentBar = bars[bars.length - 1];

        // 1. VALIDATION
        if (!currentBar || typeof features.flowImb !== 'number' || typeof features.dCVD !== 'number') {
            return this.createOutput(0, 0, ['no_data']);
        }

        // 2. STATE MANAGEMENT
        if (currentBar.ts > this.lastProcessedTime) {
            if (this.lastProcessedTime !== 0) {
                this.dCVDHistory.push(features.dCVD);
                if (this.dCVDHistory.length > this.historySize) {
                    this.dCVDHistory.shift();
                }
            }
            this.lastProcessedTime = currentBar.ts;
        }

        // 3. CALCULATION

        // A. Flow Imbalance
        const flowNorm = clamp(features.flowImb, -1, 1);

        // B. dCVD Normalization (StdDev)
        const rawStd = this.calculateStd(this.dCVDHistory);

        // FIX: Noise Floor - не делим на микроскопические значения
        // Если buyVol около 0, берем 1000 единиц как минимум (чтобы не делить на 0)
        const minStd = Math.max(features.buyVol * 0.05, 1000);
        const effectiveStd = Math.max(rawStd, minStd);

        const dCVDNorm = features.dCVD / effectiveStd;

        // Sigmoid mapping -> range [-1, 1]
        const dCVDComponent = clamp((sigmoid(dCVDNorm) * 2) - 1, -1, 1);

        // C. Volume Component
        // FIX (Improved Logic): Объем имеет вес только если есть направленный поток
        const volSign = Math.abs(flowNorm) > 0.1 ? Math.sign(flowNorm) : 0;
        const volComponent = clamp(features.volZ, -2, 2) * volSign;

        // 4. SCORING
        const rawScore =
            this.config.flowWeight * flowNorm +
            this.config.dcvdWeight * dCVDComponent +
            this.config.volZWeight * volComponent; // FIX #4: Убрали лишнее ослабление (* 0.5)

        const score = Math.tanh(this.config.tanhScale * rawScore);

        // 5. RELIABILITY & TAGGING
        let reliability = 0.6; // Базовая уверенность
        const priceRet = features.priceReturn;

        // Basic classification
        if (score > 0.5) tags.push('strong_buying_pressure');
        else if (score < -0.5) tags.push('strong_selling_pressure');

        // --- DIVERGENCE LOGIC (FIX #1) ---

        // Сценарий 1: CVD растет (покупают), но цена падает/стоит.
        // Это значит, что кто-то лимитами сжирает все покупки (Wall).
        // Если Score > 0 (алгоритм хочет купить), мы должны ударить его по рукам (снизить reliability).
        if (priceRet <= 0 && features.dCVD > 0 && score > 0.1) {
            tags.push('hidden_supply_wall'); // Warning tag
            reliability -= 0.25; // Снижаем уверенность в лонге!
        }

        // Сценарий 2: CVD падает (продают), но цена растет/стоит.
        // Лимитный покупатель держит уровень.
        // Если Score < 0 (алгоритм хочет продать), снижаем уверенность.
        else if (priceRet >= 0 && features.dCVD < 0 && score < -0.1) {
            tags.push('hidden_demand_wall'); // Warning tag
            reliability -= 0.25; // Снижаем уверенность в шорте!
        }

        // --- CONVERGENCE (Подтверждение) ---
        // Если цена и CVD идут в одну сторону и движение значимое
        else if (Math.sign(priceRet) === Math.sign(features.dCVD) &&
            Math.abs(priceRet) > 0.001 &&
            Math.abs(features.dCVD) > effectiveStd * 0.5) {
            tags.push('flow_price_aligned');
            reliability += 0.15;
        }

        // Volume Check
        if (features.volZ > 2.0) {
            tags.push('high_volume_significance');
            reliability += 0.1;
        } else if (features.volZ < -0.5) {
            tags.push('low_volume_noise');
            reliability -= 0.1;
        }

        // FIX #3: Clamp reliability [0, 1]
        reliability = clamp(reliability, 0.1, 1.0);

        return this.createOutput(score, reliability, tags);
    }

    private calculateStd(values: number[]): number {
        if (values.length < 2) return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const sumSqDiff = values.reduce((sum, val) => sum + (val - mean) ** 2, 0);
        return Math.sqrt(sumSqDiff / (values.length - 1)); // Sample StdDev
    }

    reset(): void {
        this.dCVDHistory = [];
        this.lastProcessedTime = 0;
    }
}