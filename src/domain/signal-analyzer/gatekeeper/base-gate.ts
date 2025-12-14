import { GateContext, GateResult, SignalGate } from './types';

export abstract class BaseGate implements SignalGate {
    abstract readonly id: string;

    protected reject(reason: string): GateResult {
        return { allowed: false, reason: `[GATE:${this.id}] ${reason}` };
    }

    protected allow(): GateResult {
        return { allowed: true };
    }

    abstract evaluate(ctx: GateContext): GateResult;
}