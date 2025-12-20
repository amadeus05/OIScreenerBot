import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class AntiSpamGate extends BaseGate {
    readonly id = 'anti-spam';
    // Кулдаун 30 минут для одного и того же символа (чтобы не спамить входами)
    private readonly cooldownMs = 30 * 60 * 1000;

    evaluate(ctx: GateContext): GateResult {
        const { lastSignalTs, currentTs } = ctx;

        // Если нет рыночного времени текущей свечи — пропускаем (fail-open)
        if (!currentTs) return this.allow();
        if (!lastSignalTs) return this.allow();

        const elapsed = currentTs - lastSignalTs;
        if (elapsed < this.cooldownMs) {
            const minutesLeft = Math.ceil((this.cooldownMs - elapsed) / 60000);
            return this.reject(`Cooldown active (${minutesLeft}m left)`);
        }

        return this.allow();
    }
}