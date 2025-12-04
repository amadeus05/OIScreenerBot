import { Trigger } from '../entities/trigger.entity';
import { SmartCandle, MarketData } from './market-data.interface';

export interface IAnalysisResult {
  symbol: string;

  // --- Классический анализ (Start vs End) ---
  oiChangePercent: number;
  oiStart: number;
  oiEnd: number;

  // --- Динамический анализ (Rolling Window) ---
  maxRunupPercent: number;
  maxDrawdownPercent: number;
  lowestOI: number;
  highestOI: number;

  // --- Цена ---
  priceChangePercent: number;
  currentPrice: number;
  previousPrice: number;

  // --- Объем и Поток ---
  totalVolume: number;
  previousVolume: number;
  cvdDelta: number;

  // Объект с ликвидациями
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