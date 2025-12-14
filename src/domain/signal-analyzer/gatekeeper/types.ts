import { Features, SignalResult } from '../types';
import { MarketContext } from '../types/context';

export interface GateResult {
    allowed: boolean;
    reason?: string;
}

export interface GateContext {
    signal: SignalResult;
    features: Features;
    marketContext?: MarketContext;
    lastSignalTs?: number; // Время последнего сигнала по этому символу
}

export interface SignalGate {
    readonly id: string;
    evaluate(ctx: GateContext): GateResult;
}