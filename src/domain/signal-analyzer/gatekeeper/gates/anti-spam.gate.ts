import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export class AntiSpamGate extends BaseGate {
    readonly id = 'anti-spam';
    // Кулдаун 30 минут для одного и того же символа (чтобы не спамить входами)
    private readonly cooldownMs = 30 * 60 * 1000;

    evaluate(ctx: GateContext): GateResult {
        const { lastSignalTs } = ctx;

        if (!lastSignalTs) return this.allow();

        const now = Date.now();
        if (now - lastSignalTs < this.cooldownMs) {
            const minutesLeft = Math.ceil((this.cooldownMs - (now - lastSignalTs)) / 60000);
            return this.reject(`Cooldown active (${minutesLeft}m left)`);
        }

        return this.allow();
    }
}