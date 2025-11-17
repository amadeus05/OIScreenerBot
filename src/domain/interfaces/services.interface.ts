import { Trigger } from '../entities/trigger.entity';

export interface IDataPoint {
  readonly timestamp: number;
  readonly price: number;
}

export interface IMetricChanges {
  // Primary (OI)
  readonly oiChangePercent: number;
  readonly oiStart?: number;
  readonly oiEnd?: number;

  // Volume metrics
  readonly totalVolume?: number;
  readonly deltaVolume?: number;

  // Secondary (price)
  readonly priceChangePercent?: number;
  readonly currentPrice?: number;
  readonly previousPrice?: number;

  readonly timeWindowSeconds: number; // actual time window measured
}

export interface IDataAggregatorService {
  // Backwards compatible: many providers still call updatePrice
  updatePrice(symbol: string, price: number, timestamp: number): void;

  // Implementations may provide more advanced API (e.g., updateMarketData),
  // but trigger engine uses getMetricChanges which must return IMetricChanges.
  getMetricChanges(symbol: string, timeIntervalMinutes: number): IMetricChanges | null;
  getAllKnownSymbols(): string[];
  getHistoryLength(symbol: string): number;
  getCurrentPrice(symbol: string): number;
  setTriggerEngine(engine: ITriggerEngineService): void;
}

export interface IMarketDataGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getActiveProviders?(): string[];
  getProvidersHealth?(): Record<string, any>;
}

export interface ITriggerEngineService {
  start(): void;
  stop(): void;
  onPriceUpdate(symbol: string, price: number): Promise<void>;
}

export interface INotificationService {
  processTrigger(trigger: Trigger, symbol: string, metrics: IMetricChanges): Promise<void>;
}
