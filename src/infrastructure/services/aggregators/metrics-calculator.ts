import { SortedBucketMap } from "./aggregator.types";
import { IMetricChanges } from "../../../domain/interfaces/services.interface";

export class MetricsCalculator {
    private fallbacksUsed = 0;
    private readonly FALLBACK_SHIFT_MULTIPLIER = Number(process.env.FALLBACK_SHIFT_MULTIPLIER) || 2;

    public getStats() {
        return { fallbacksUsed: this.fallbacksUsed };
    }

    public calculateWindow(
        map: SortedBucketMap,
        minutes: number,
        bucketSize: number,
        currentPrice: number | undefined,
        currentOI: number | undefined
    ): IMetricChanges | null {
        const now = Date.now();
        const durationMs = minutes * 60_000;
        const windowStart = now - durationMs;
        const windowEnd = now;

        // Получаем OI и volume за окно
        const movement = this.findOIAndVolumeWithinWindow(map, windowStart, windowEnd, bucketSize);

        let oiChangePercent = 0;
        let oiStart = 0;
        let oiEnd = 0;
        let totalVolume = 0;
        let totalQuoteVolume = 0;
        let deltaVolume = 0;
        let deltaQuoteVolume = 0;

        // Volume берем из movement (если есть)
        if (movement) {
            totalVolume = movement.totalVolume;
            deltaVolume = movement.deltaVolume;
            totalQuoteVolume = movement.totalQuoteVolume;
            deltaQuoteVolume = movement.deltaQuoteVolume;
        }

        // Для OI: сначала проверяем основной метод
        if (movement && movement.hasOI) {
            oiChangePercent = movement.oiChangePercent;
            oiStart = movement.oiStart;
            oiEnd = movement.oiEnd;
        } else {
            // try fallback interpolation для OI
            if (map.getSortedKeys().length > 0) {
                const fallback = this.fallbackInterpolationForOI(map, windowStart, windowEnd, bucketSize, durationMs, minutes);
                if (fallback) {
                    oiChangePercent = fallback.oiChangePercent;
                    oiStart = fallback.oiStart;
                    oiEnd = fallback.oiEnd;
                }
            }
        }

        let priceChangePercent = 0;
        let priceStart = 0;
        let priceEnd = currentPrice ?? 0;

        // Price%: compute from boundary prices (interpolate if needed)
        const startPrice = this.getPriceAtBoundary(map, windowStart);
        const endPrice = this.getPriceAtBoundary(map, windowEnd) ?? (currentPrice ?? undefined);

        if (startPrice !== null && endPrice !== undefined && startPrice > 0) {
            priceStart = startPrice;
            priceEnd = endPrice!;
            priceChangePercent = Number((((priceEnd - priceStart) / priceStart) * 100).toFixed(6));
        } else if (currentPrice && movement && movement.priceFallbackStart !== undefined) {
            priceStart = movement.priceFallbackStart ?? currentPrice;
            priceEnd = currentPrice;
            if (priceStart > 0) {
                priceChangePercent = Number((((priceEnd - priceStart) / priceStart) * 100).toFixed(6));
            }
        }

        // Compose result
        let volumeBaseline = 0;
        let volumeBaselineQuote = 0;
        let volumeRatio: number | null = null;
        let volumeRatioQuote: number | null = null;

        const previousWindowStart = windowStart - durationMs;
        if (previousWindowStart >= 0) {
            const prevMovement = this.findOIAndVolumeWithinWindow(map, previousWindowStart, windowStart, bucketSize);
            if (prevMovement) {
                volumeBaseline = prevMovement.totalVolume;
                volumeBaselineQuote = prevMovement.totalQuoteVolume;
                if (volumeBaseline > 0 && totalVolume > 0) {
                    volumeRatio = Number((totalVolume / volumeBaseline).toFixed(3));
                }
                if (volumeBaselineQuote > 0 && totalQuoteVolume > 0) {
                    volumeRatioQuote = Number((totalQuoteVolume / volumeBaselineQuote).toFixed(3));
                }
            }
        }

        return {
            oiChangePercent: Number(oiChangePercent.toFixed(6)),
            oiStart,
            oiEnd,
            totalVolume,
            deltaVolume,
            totalQuoteVolume,
            deltaQuoteVolume,
            volumeBaseline,
            volumeBaselineQuote,
            volumeRatio,
            volumeRatioQuote,
            priceChangePercent: Number(priceChangePercent),
            timeWindowSeconds: Math.max(1, Math.floor(durationMs / 1000)),
        };
    }

    private findOIAndVolumeWithinWindow(
        map: SortedBucketMap,
        windowStart: number,
        windowEnd: number,
        bucketSize: number,
    ) {
        const keys = map.getSortedKeys();
        if (keys.length === 0) return null;

        let totalVolume = 0;
        let totalBuy = 0;
        let totalSell = 0;
        let totalQuoteVolume = 0;
        let totalQuoteBuy = 0;
        let totalQuoteSell = 0;
        let priceFallbackStart: number | undefined;
        let seenAny = false;

        for (let i = 0; i < keys.length; i++) {
            const bucketTime = keys[i];
            const bucketStart = bucketTime;
            const bucketEnd = bucketStart + bucketSize;

            if (bucketEnd <= windowStart) continue;
            if (bucketStart >= windowEnd) break;

            const b = map.get(bucketTime)!;
            if (b.count === 0) continue;

            const overlapStart = Math.max(windowStart, bucketStart);
            const overlapEnd = Math.min(windowEnd, bucketEnd);
            const overlapMs = Math.max(0, overlapEnd - overlapStart);
            if (overlapMs <= 0) continue;

            const ratio = bucketSize > 0 ? Math.min(1, overlapMs / bucketSize) : 1;
            seenAny = true;

            totalVolume += (b.totalVolume ?? 0) * ratio;
            totalBuy += (b.volumeBuy ?? 0) * ratio;
            totalSell += (b.volumeSell ?? 0) * ratio;
            totalQuoteVolume += (b.totalQuoteVolume ?? 0) * ratio;
            totalQuoteBuy += (b.volumeBuyQuote ?? 0) * ratio;
            totalQuoteSell += (b.volumeSellQuote ?? 0) * ratio;

            if (priceFallbackStart === undefined && b.priceOpen !== null) {
                priceFallbackStart = b.priceOpen!;
            }
        }

        if (!seenAny) return null;

        const oiStart = this.getOIAtBoundary(map, windowStart);
        const oiEnd = this.getOIAtBoundary(map, windowEnd);

        let hasOI = false;
        let oiChangePercent = 0;

        if (oiStart !== null && oiEnd !== null && Number.isFinite(oiStart) && Number.isFinite(oiEnd) && oiStart > 0) {
            hasOI = true;
            oiChangePercent = Number((((oiEnd - oiStart) / oiStart) * 100).toFixed(6));
        }

        return {
            hasOI,
            oiChangePercent,
            oiStart: oiStart ?? 0,
            oiEnd: oiEnd ?? 0,
            totalVolume,
            totalQuoteVolume,
            deltaVolume: totalBuy - totalSell,
            deltaQuoteVolume: totalQuoteBuy - totalQuoteSell,
            priceFallbackStart,
        };
    }

    private fallbackInterpolationForOI(
        map: SortedBucketMap,
        startBucket: number,
        endBucket: number,
        bucketSize: number,
        durationMs: number,
        minutes: number,
    ) {
        this.fallbacksUsed++;
        const keys = map.getSortedKeys();
        if (keys.length === 0) return null;

        const maxShift = Math.min(
            this.FALLBACK_SHIFT_MULTIPLIER * bucketSize,
            durationMs * 0.05
        );

        const beforeStart = keys.filter(k => k <= startBucket);
        const afterStart = keys.filter(k => k > startBucket);

        let startKey: number | null = null;
        if (beforeStart.length > 0) {
            startKey = beforeStart[beforeStart.length - 1];
            const shiftBack = startBucket - startKey;
            if (shiftBack > maxShift) {
                startKey = null;
            }
        }

        if (startKey === null && afterStart.length > 0) {
            const candidate = afterStart[0];
            const shift = candidate - startBucket;
            if (shift <= maxShift) {
                startKey = candidate;
            } else {
                return null;
            }
        }

        const beforeEnd = keys.filter(k => k <= endBucket);
        let endKey: number | null = null;

        if (beforeEnd.length > 0) {
            endKey = beforeEnd[beforeEnd.length - 1];
            const shiftBack = endBucket - endKey;
            if (shiftBack > maxShift) {
                endKey = null;
            }
        }

        if (endKey === null) {
            const candidate = keys[keys.length - 1];
            const shift = endBucket - candidate;
            if (shift <= maxShift) {
                endKey = candidate;
            } else {
                return null;
            }
        }

        if (startKey === null || endKey === null || startKey > endKey) {
            return null;
        }

        const s = map.get(startKey)!;
        const e = map.get(endKey)!;

        const startOI = (this.getOIAtBoundary(map, startBucket) ?? s.oiOpen);
        const endOI = (this.getOIAtBoundary(map, endBucket) ?? e.oiClose);

        if (!Number.isFinite(startOI) || !Number.isFinite(endOI) || startOI <= 0) {
            return null;
        }

        const oiChangePercent = Number((((endOI - startOI) / startOI) * 100).toFixed(6));

        return {
            oiChangePercent,
            oiStart: startOI,
            oiEnd: endOI,
        };
    }

    private getPriceAtBoundary(map: SortedBucketMap, boundary: number): number | null {
        const keys = map.getSortedKeys();
        if (keys.length === 0) return null;

        let left = 0;
        let right = keys.length - 1;
        let idx = -1;
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (keys[mid] <= boundary) {
                idx = mid;
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        const leftKey = idx >= 0 ? keys[idx] : null;
        const rightKey = (idx + 1) < keys.length ? keys[idx + 1] : null;

        if (leftKey !== null && leftKey === rightKey) {
            const b = map.get(leftKey)!;
            if (b.firstTs <= boundary && boundary <= b.lastTs && b.priceOpen !== null && b.priceClose !== null) {
                return this.interpolate(b.firstTs, b.priceOpen!, b.lastTs, b.priceClose!, boundary);
            }
            if (boundary < b.firstTs) return b.priceOpen;
            return b.priceClose;
        }

        const leftBucket = leftKey !== null ? map.get(leftKey) : undefined;
        const rightBucket = rightKey !== null ? map.get(rightKey) : undefined;

        if (leftBucket && leftBucket.firstTs <= boundary && boundary <= leftBucket.lastTs && leftBucket.priceOpen !== null && leftBucket.priceClose !== null) {
            return this.interpolate(leftBucket.firstTs, leftBucket.priceOpen!, leftBucket.lastTs, leftBucket.priceClose!, boundary);
        }

        if (rightBucket && rightBucket.firstTs <= boundary && boundary <= rightBucket.lastTs && rightBucket.priceOpen !== null && rightBucket.priceClose !== null) {
            return this.interpolate(rightBucket.firstTs, rightBucket.priceOpen!, rightBucket.lastTs, rightBucket.priceClose!, boundary);
        }

        if (leftBucket && rightBucket) {
            const prevTime = leftBucket.lastTs;
            const prevPrice = leftBucket.priceClose ?? leftBucket.priceOpen ?? null;
            const nextTime = rightBucket.firstTs;
            const nextPrice = rightBucket.priceOpen ?? rightBucket.priceClose ?? null;

            if (prevPrice === null || nextPrice === null) {
                return prevPrice ?? nextPrice;
            }

            if (prevTime <= boundary && boundary <= nextTime && nextTime > prevTime) {
                return this.interpolate(prevTime, prevPrice, nextTime, nextPrice, boundary);
            }

            const leftDelta = Math.abs(boundary - prevTime);
            const rightDelta = Math.abs(nextTime - boundary);
            return leftDelta <= rightDelta ? prevPrice : nextPrice;
        }

        if (leftBucket) return leftBucket.priceClose ?? leftBucket.priceOpen ?? null;
        if (rightBucket) return rightBucket.priceOpen ?? rightBucket.priceClose ?? null;

        return null;
    }

    private getOIAtBoundary(map: SortedBucketMap, boundary: number): number | null {
        const keys = map.getSortedKeys();
        if (keys.length === 0) return null;

        let left = 0;
        let right = keys.length - 1;
        let idx = -1;
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (keys[mid] <= boundary) {
                idx = mid;
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        const leftKey = idx >= 0 ? keys[idx] : null;
        const rightKey = (idx + 1) < keys.length ? keys[idx + 1] : null;

        if (leftKey !== null && leftKey === rightKey) {
            const b = map.get(leftKey)!;
            if (!Number.isFinite(b.oiOpen) || !Number.isFinite(b.oiClose)) return null;

            if (b.firstTs <= boundary && boundary <= b.lastTs) {
                return this.interpolate(b.firstTs, b.oiOpen, b.lastTs, b.oiClose, boundary);
            }
            if (boundary < b.firstTs) return b.oiOpen;
            return b.oiClose;
        }

        const leftBucket = leftKey !== null ? map.get(leftKey) : undefined;
        const rightBucket = rightKey !== null ? map.get(rightKey) : undefined;

        if (leftBucket && Number.isFinite(leftBucket.oiOpen) && Number.isFinite(leftBucket.oiClose)) {
            if (leftBucket.firstTs <= boundary && boundary <= leftBucket.lastTs) {
                return this.interpolate(leftBucket.firstTs, leftBucket.oiOpen, leftBucket.lastTs, leftBucket.oiClose, boundary);
            }
        }

        if (rightBucket && Number.isFinite(rightBucket.oiOpen) && Number.isFinite(rightBucket.oiClose)) {
            if (rightBucket.firstTs <= boundary && boundary <= rightBucket.lastTs) {
                return this.interpolate(rightBucket.firstTs, rightBucket.oiOpen, rightBucket.lastTs, rightBucket.oiClose, boundary);
            }
        }

        if (leftBucket && rightBucket) {
            const prevTime = leftBucket.lastTs;
            const prevOI = leftBucket.oiClose;
            const nextTime = rightBucket.firstTs;
            const nextOI = rightBucket.oiOpen;

            if (!Number.isFinite(prevOI) || !Number.isFinite(nextOI)) {
                if (Number.isFinite(prevOI)) return prevOI;
                if (Number.isFinite(nextOI)) return nextOI;
                return null;
            }

            if (prevTime <= boundary && boundary <= nextTime && nextTime > prevTime) {
                return this.interpolate(prevTime, prevOI, nextTime, nextOI, boundary);
            }

            const leftDelta = Math.abs(boundary - prevTime);
            const rightDelta = Math.abs(nextTime - boundary);
            return leftDelta <= rightDelta ? prevOI : nextOI;
        }

        if (leftBucket && Number.isFinite(leftBucket.oiClose)) return leftBucket.oiClose;
        if (rightBucket && Number.isFinite(rightBucket.oiOpen)) return rightBucket.oiOpen;

        return null;
    }

    private interpolate(t0: number, p0: number, t1: number, p1: number, t: number): number {
        if (t1 === t0) return p0;
        const ratio = (t - t0) / (t1 - t0);
        return p0 + (p1 - p0) * ratio;
    }

    public getCoverageThreshold(minutes: number): number {
        if (minutes <= 1) return 90;
        if (minutes <= 2) return 80;
        if (minutes <= 5) return 75;
        if (minutes <= 15) return 78;
        if (minutes <= 30) return 80;
        return 82;
    }

    public findNearestBucketAtOrBefore(map: SortedBucketMap, boundary: number): number | null {
        const keys = map.getSortedKeys();
        if (keys.length === 0) return null;

        let left = 0;
        let right = keys.length - 1;
        let result: number | null = null;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const key = keys[mid];

            if (key <= boundary) {
                result = key;
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return result;
    }
}