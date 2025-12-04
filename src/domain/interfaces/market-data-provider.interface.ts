import { MarketData } from './market-data.interface';

export type MarketType = 'spot' | 'futures';
export type PriceUpdateCallback = (data: MarketData) => void;

export interface IMarketDataProvider {
  readonly providerId: string;
  readonly marketType: MarketType;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  subscribe(symbols: string[]): Promise<void>;
  unsubscribe(symbols: string[]): Promise<void>;
  getAvailableSymbols(): Promise<string[]>;

  onPriceUpdate(callback: PriceUpdateCallback): void;
  getHealthStatus(): ProviderHealthStatus;
}

export interface ProviderHealthStatus {
  providerId: string;
  marketType: MarketType;
  isConnected: boolean;
  lastUpdateTime: number;
  messageCount: number;
  reconnectAttempts: number;
  errorCount: number;
}

export interface ProviderConfig {
  exchange: string;
  marketType: MarketType;
}