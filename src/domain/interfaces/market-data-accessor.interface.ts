import { LiquidationData } from "modules/decision-system/services/external-data.service";

export interface OIPoint {
  ts: number;      // timestamp в ms
  value: number;   // OI значение
}

export interface VolumePoint {
  ts: number;
  value: number; // totalVolume
  volumeBuy?: number;
  volumeSell?: number;
  totalQuoteVolume?: number;
}

export interface VolumeData {
  totalVolume: number;
  volumeBuy: number;
  volumeSell: number;
  totalQuoteVolume: number;
  timestamp: number;
}

export interface MarketDataAccessor {
  /** Получить последние N минут закрывающих значений OI (1m resolution) */
  getOISeries(symbol: string, minutes: number): OIPoint[];
  
  /** Получить OI данные в указанном временном диапазоне */
  getOISeriesInRange(symbol: string, from: number, to: number): OIPoint[];
  
  /** Текущее значение OI (быстрый доступ) */
  getCurrentOI(symbol: string): number | undefined;

  /** Опционально: получить цены (для комбо-фильтров) */
  getPriceSeries?(symbol: string, minutes: number): { ts: number; value: number }[];
   
  /** Текущее значение цены */
  getCurrentPrice(symbol: string): number | undefined;

  /** Получить объем данные в указанном временном диапазоне */
  getVolumeSeriesInRange(symbol: string, from: number, to: number): VolumePoint[];

  /** Получить последние N минут закрывающих значений объема (1m resolution) */
  getVolumeSeries(symbol: string, minutes: number): VolumePoint[];

  /** Получить текущее значение объема */
  getCurrentVolume(symbol: string): VolumeData | undefined;
}

export interface EnhancedMarketDataAccessor extends MarketDataAccessor {
  /** Получить ликвидации в указанном временном диапазоне */
  getLiquidations(symbol: string, timeframe: '1m' | '5m' | '15m'): Promise<LiquidationData[]>;
}