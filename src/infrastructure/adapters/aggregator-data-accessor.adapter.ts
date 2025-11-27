import { DataAggregatorService } from "../services/data-aggregator.service";
import { MarketDataAccessor, OIPoint, VolumeData, VolumePoint } from "../../domain/interfaces/market-data-accessor.interface";
import { Injectable } from "../../shared/decorators";

@Injectable()
export class AggregatorDataAccessor implements MarketDataAccessor {
  constructor(private readonly aggregator: DataAggregatorService) { }

  public getOISeriesInRange(symbol: string, from: number, to: number): OIPoint[] {
    return this.aggregator.getOISeriesInRange(symbol, from, to);
  }

  public getVolumeSeriesInRange(symbol: string, from: number, to: number): VolumePoint[] {
    return this.aggregator.getVolumeSeriesInRange(symbol, from, to);
  }

  public getCurrentVolume(symbol: string): VolumeData | undefined {
    return this.aggregator.getCurrentVolume(symbol);
  }

  getCurrentOI(symbol: string): number | undefined {
    return this.aggregator.getStateManager().getOI(symbol);
  }

  getCurrentPrice(symbol: string): number | undefined {
    return this.aggregator.getStateManager().getPrice(symbol);
  }

  getOISeries(symbol: string, minutes: number): OIPoint[] {
    const now = Date.now();
    const from = now - minutes * 60_000;

    const buckets = this.aggregator.getBucketRepo().getBucketsInRange(
      symbol,
      from,
      now,
      '1m'
    );

    return buckets
      .map(b => ({
        ts: b.ts,
        value: b.bucket.oiClose,
      }))
      .filter(p => Number.isFinite(p.value) && p.value > 0);
  }

  getPriceSeries(symbol: string, minutes: number): { ts: number; value: number }[] {
    const now = Date.now();
    const from = now - minutes * 60_000;
    const buckets = this.aggregator.getBucketRepo().getBucketsInRange(symbol, from, now, '1m');

    return buckets
      .map(b => ({
        ts: b.ts,
        value: b.bucket.priceClose ?? b.bucket.priceOpen ?? 0,
      }))
      .filter(p => p.value > 0);
  }

  public getVolumeSeries(symbol: string, minutes: number): VolumePoint[] {
    const now = Date.now();
    const from = now - minutes * 60_000;
    return this.aggregator.getVolumeSeriesInRange(symbol, from, now);
  }
}