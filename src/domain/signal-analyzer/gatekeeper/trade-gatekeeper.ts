import { GateContext, GateResult, SignalGate } from './types';
import { Inject, Injectable } from '../../../shared/decorators';

@Injectable()
export class TradeGatekeeper {
    private gates: SignalGate[];

    constructor(
        @Inject('IGates') gates: SignalGate[]
    ) {
        this.gates = gates;
    }

    evaluate(ctx: GateContext): GateResult {
        for (const gate of this.gates) {
            const result = gate.evaluate(ctx);
            if (!result.allowed) {
                return result; // Fail fast (возвращаем первую причину отказа)
            }
        }
        return { allowed: true };
    }
}