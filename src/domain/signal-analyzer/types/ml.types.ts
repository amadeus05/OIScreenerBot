export interface SignalFeatureVector {
    features: {
        orderflowScore: number;
        oiScore: number;
        momentumScore: number;
        volZ: number;
        flowImb: number;
        liqBias: number;
        hour: number;
    };
    outcome: 'WIN' | 'LOSS';
    pnl: number;
}