import { Trigger } from '../entities/trigger.entity';
import { SmartCandle, MarketData } from './market-data.interface';

/**
 * Результат работы TechnicalAnalysisService.
 */
export interface IAnalysisResult {
  symbol: string;
  
  // Анализ OI
  oiChangePercent: number;
  oiStart: number;
  oiEnd: number;

  // Анализ цены
  priceChangePercent: number;
  currentPrice: number;
  previousPrice: number;

  // Анализ объемов и потока
  totalVolume: number;
  cvdDelta: number; 
  
  liquidations: {
    long: number;
    short: number;
  };

  timeWindowSeconds: number;
}

export interface IMarketDataRepository {
  updateMarketData(data: MarketData): void;
  getHistory(symbol: string, limit: number): SmartCandle[];
  getLastCandle(symbol: string): SmartCandle | undefined;
  getCurrentPrice(symbol: string): number;
  getAllKnownSymbols(): string[];
  isWarm(symbol: string): boolean;
  setTriggerEngine(engine: ITriggerEngineService): void;
}

export interface ITechnicalAnalysisService {
  calculateChanges(candles: SmartCandle[], timeIntervalMinutes: number): IAnalysisResult | null;
}

export interface IMarketDataGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  registerProvider(provider: any): void;
}

export interface ITriggerEngineService {
  start(): void;
  stop(): void;
  onPriceUpdate(symbol: string, price: number): Promise<void>;
}

export interface INotificationService {
  processTrigger(trigger: Trigger, result: IAnalysisResult): Promise<void>;
}