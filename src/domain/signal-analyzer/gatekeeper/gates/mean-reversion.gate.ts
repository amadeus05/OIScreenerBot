import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class MeanReversionGate extends BaseGate {
    readonly id = 'mean-reversion-limiter';

    // Минимальное изменение цены (0.2%), чтобы считать это импульсом, который стоит разворачивать.
    private readonly minImpulse = 0.002;

    evaluate(ctx: GateContext): GateResult {
        const { features, signal } = ctx;

        // 1. Проверяем, является ли сигнал "Mean Reversion" (разворотным)
        // В твоем проекте теги лежат в 'reasonTags'.
        // Ищем теги: 'mean_reversion', 'overbought_reversal', 'oversold_reversal' 
        const isReversal = signal.reasonTags.some(t =>
            t.includes('mean_reversion') ||
            t.includes('overbought') ||
            t.includes('oversold')
        );

        if (!isReversal) {
            return this.allow();
        }

        // 2. Проверка импульса (Price Return)
        // Если цена почти не двигалась (< 0.2%), то разворачивать нечего (это просто шум).
        // features.priceReturn рассчитывается в FeatureEngine[cite: 899].
        if (Math.abs(features.priceReturn) < this.minImpulse) {
            return this.reject(`No impulse for mean reversion (${(features.priceReturn * 100).toFixed(2)}%)`);
        }

        // 3. Подтверждение объемом
        // Развороты (особенно V-образные) требуют объема (кульминация/истощение).
        // Если volZ < 0 (объем ниже среднего), это опасно — рынок может просто медленно сползать дальше.
        if (features.volZ < 0) {
            return this.reject(`No volume confirmation (Z: ${features.volZ.toFixed(2)})`);
        }

        return this.allow();
    }
}