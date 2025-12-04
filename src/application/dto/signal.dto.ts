export class SignalDto {
  constructor(
    public readonly signalNumber: number,
    public readonly symbol: string,

    public readonly oiChangePercent: number,
    public readonly oiStart?: number,
    public readonly oiEnd?: number,

    public readonly totalVolume?: number,
    
    // New Metrics
    public readonly cvdDelta?: number,
    public readonly liqLong?: number,
    public readonly liqShort?: number,

    public readonly priceChangePercent?: number,
    public readonly currentPrice?: number,
    public readonly previousPrice?: number,

    public readonly timestamp?: Date,
    public readonly triggerIntervalMinutes?: number,
  ) {}
}