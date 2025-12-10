// ========================================================================
// FILE: src/domain/signal-analyzer/modules/levels.module.ts
// ========================================================================

import { Features, ModuleOutput, BarData, AggregatedBar, SwingPoint, PriceLevel, LevelContext } from '../types';
import { DEFAULT_CONFIG, MODULE_CONFIG } from '../types/config';
import { BaseModule } from './base-module';
import { LevelsScenarios } from '../rules/scenarios/levels.scenarios';

export class LevelsModule extends BaseModule {
    readonly name = 'levels' as const;
    private readonly config = DEFAULT_CONFIG.levels;
    private readonly moduleConfig = MODULE_CONFIG.levels;
    
    // Tracked levels (State)
    private swingHighs: SwingPoint[] = [];
    private swingLows: SwingPoint[] = [];
    
    // Track bar count for decay
    private barCount: number = 0;
    private lastProcessedBarTs: number = 0;
    private idCounter: number = 0;

    private generateId(): string {
        return `swing_${Date.now()}_${++this.idCounter}`;
    }

    /**
     * Main Analysis Method (Scenario-Based)
     */
    analyze(features: Features, bars: (BarData | AggregatedBar)[]): ModuleOutput {
        const tags: string[] = [];

        // Need enough data for swing detection
        if (bars.length < this.config.swingWindow * 2 + 1) {
            return this.createOutput(0, 0.3, tags);
        }

        const currentBar = bars[bars.length - 1];
        const currentPrice = currentBar.c;
        const atr = features.atr > 0 ? features.atr : currentPrice * 0.01;

        // 1. STATE MAINTENANCE
        if (currentBar.ts !== this.lastProcessedBarTs) {
            this.barCount++;
            this.lastProcessedBarTs = currentBar.ts;
            this.applyDecay();
        }

        // Detect new swings & Update existing levels
        this.detectSwingsWithTolerance(bars, atr);
        this.checkTouches(currentBar, atr);
        this.pruneWeakLevels();

        // 2. PREPARE CONTEXT FOR SCENARIOS
        const levelContext = this.getLevelContext(currentPrice, atr);
        const breakout = this.detectConfirmedBreakout(bars, atr);
        
        // SFP Detection Logic (Swing Failure Pattern)
        let isSFP = false;
        let sfpType: 'resistance' | 'support' | null = null;
        
        if (levelContext.nearestResistance) {
            // High выше уровня, Close ниже уровня, фитиль заметный
            if (currentBar.h > levelContext.nearestResistance.price && currentBar.c < levelContext.nearestResistance.price) {
                if ((currentBar.h - currentBar.c) > atr * 0.3) {
                    isSFP = true;
                    sfpType = 'resistance';
                }
            }
        }
        if (levelContext.nearestSupport) {
            // Low ниже уровня, Close выше уровня
            if (currentBar.l < levelContext.nearestSupport.price && currentBar.c > levelContext.nearestSupport.price) {
                if ((currentBar.c - currentBar.l) > atr * 0.3) {
                    isSFP = true;
                    sfpType = 'support';
                }
            }
        }

        // Proximity Logic
        let proximity = 'none';
        const priceRange = atr * 2;
        if (levelContext.nearestResistance) {
             const dist = levelContext.nearestResistance.price - currentPrice;
             if (dist > 0 && dist < priceRange) proximity = 'near_resistance';
        }
        if (levelContext.nearestSupport) {
             const dist = currentPrice - levelContext.nearestSupport.price;
             if (dist > 0 && dist < priceRange) proximity = 'near_support';
        }

        // Context object for Predicates
        const context = {
            levelContext,
            breakout,
            isSFP,
            sfpType,
            proximity
        };

        // 3. SCENARIO ENGINE
        let totalScore = 0;
        let maxReliability = 0.4;
        const activeTags = new Set<string>();

        for (const scenario of LevelsScenarios) {
            // Check all conditions
            const isMatch = scenario.conditions.every(c => c(features, context));
            
            if (isMatch) {
                // Special logic: Breakout strength scaling
                let score = scenario.baseScore;
                if (scenario.tags.includes('resistance_breakout') || scenario.tags.includes('support_breakdown')) {
                    score *= breakout.strength;
                }
                
                // Aggregation
                // Если это "бонусный" сценарий (score 0), он просто повышает надежность
                if (scenario.baseScore === 0) {
                   if (maxReliability < 1.0) maxReliability += scenario.reliability;
                } else {
                   totalScore += score;
                   if (scenario.reliability > maxReliability) maxReliability = scenario.reliability;
                }
                
                scenario.tags.forEach(t => activeTags.add(t));
            }
        }

        // FOMO Filter (Logic retained inside module as post-processing)
        if (activeTags.has('resistance_breakout')) {
             const dist = (currentPrice - (levelContext.nearestResistance?.price || currentPrice)) / atr;
             if (dist > 0.5) {
                 activeTags.add('breakout_extended_ignored');
                 totalScore = 0; // Cancel signal
             }
        } else if (activeTags.has('support_breakdown')) {
             const dist = ((levelContext.nearestSupport?.price || currentPrice) - currentPrice) / atr;
             if (dist > 0.5) {
                 activeTags.add('breakout_extended_ignored');
                 totalScore = 0;
             }
        }

        return this.createOutput(
            this.clampScore(totalScore),
            this.clampScore(maxReliability),
            Array.from(activeTags)
        );
    }

    // ========================================================================
    // PRIVATE HELPER METHODS (Logic from original code)
    // ========================================================================

    private detectSwingsWithTolerance(bars: (BarData | AggregatedBar)[], atr: number): void {
        const window = this.config.swingWindow;
        const tolerance = atr * this.config.swingToleranceAtr;

        if (bars.length < window * 2 + 1) return;

        const checkIndex = bars.length - window - 1;
        const checkBar = bars[checkIndex];

        // Check for swing high with tolerance
        let isSwingHigh = true;
        let highScore = 0;

        for (let i = checkIndex - window; i < checkIndex; i++) {
            if (i < 0) continue;
            if (bars[i].h > checkBar.h + tolerance) {
                isSwingHigh = false;
                break;
            }
            highScore += Math.max(0, checkBar.h - bars[i].h);
        }

        for (let i = checkIndex + 1; i <= checkIndex + window && i < bars.length; i++) {
            if (bars[i].h > checkBar.h + tolerance) {
                isSwingHigh = false;
                break;
            }
            highScore += Math.max(0, checkBar.h - bars[i].h);
        }

        // Check for swing low with tolerance
        let isSwingLow = true;
        let lowScore = 0;

        for (let i = checkIndex - window; i < checkIndex; i++) {
            if (i < 0) continue;
            if (bars[i].l < checkBar.l - tolerance) {
                isSwingLow = false;
                break;
            }
            lowScore += Math.max(0, bars[i].l - checkBar.l);
        }

        for (let i = checkIndex + 1; i <= checkIndex + window && i < bars.length; i++) {
            if (bars[i].l < checkBar.l - tolerance) {
                isSwingLow = false;
                break;
            }
            lowScore += Math.max(0, bars[i].l - checkBar.l);
        }

        const now = Date.now();
        const minSwingHeight = atr / 3;
        
        // Calculate SMA(volume, 10) relative to checkIndex
        const volSmaWindow = Math.min(10, checkIndex);
        const startSma = Math.max(0, checkIndex - volSmaWindow);
        const smaSlice = bars.slice(startSma, checkIndex);
        const smaVolume = smaSlice.length > 0
            ? smaSlice.reduce((s, b) => s + b.v, 0) / smaSlice.length
            : checkBar.v;

        // Apply filters to swing high
        if (isSwingHigh) {
            const minNeighborHigh = Math.min(
                ...bars.slice(Math.max(0, checkIndex - window), checkIndex + window + 1).map(b => b.h)
            );
            const swingHeight = checkBar.h - minNeighborHigh;
            if (swingHeight < minSwingHeight) {
                isSwingHigh = false;
            }
            if (checkBar.v < smaVolume * 0.8) {
                isSwingHigh = false;
            }
        }

        if (isSwingHigh) {
            const significance = highScore / (atr * window);
            const volumeScore = this.calculateVolumeSignificance(bars, checkIndex);
            const initialStrength = Math.min(1, 0.3 + significance * 0.3 + volumeScore * 0.4);
            const swingPoint: SwingPoint = {
                id: this.generateId(),
                ts: checkBar.ts,
                price: checkBar.h,
                type: 'high',
                strength: initialStrength,
                touchCount: 1,
                lastTouchTs: checkBar.ts,
                touchPrices: [checkBar.h],
                touchVolumes: [checkBar.v],
                avgBounce: 0,
                maxBounce: 0,
                createdAt: now,
                confirmedAt: 0,
            };
            this.addOrMergeSwingPoint(swingPoint, this.swingHighs, atr);
        }

        // Apply filters to swing low
        if (isSwingLow) {
            const maxNeighborLow = Math.max(
                ...bars.slice(Math.max(0, checkIndex - window), checkIndex + window + 1).map(b => b.l)
            );
            const swingDepth = maxNeighborLow - checkBar.l;
            if (swingDepth < minSwingHeight) {
                isSwingLow = false;
            }
            if (checkBar.v < smaVolume * 0.8) {
                isSwingLow = false;
            }
        }

        if (isSwingLow) {
            const significance = lowScore / (atr * window);
            const volumeScore = this.calculateVolumeSignificance(bars, checkIndex);
            const initialStrength = Math.min(1, 0.3 + significance * 0.3 + volumeScore * 0.4);
            const swingPoint: SwingPoint = {
                id: this.generateId(),
                ts: checkBar.ts,
                price: checkBar.l,
                type: 'low',
                strength: initialStrength,
                touchCount: 1,
                lastTouchTs: checkBar.ts,
                touchPrices: [checkBar.l],
                touchVolumes: [checkBar.v],
                avgBounce: 0,
                maxBounce: 0,
                createdAt: now,
                confirmedAt: 0,
            };
            this.addOrMergeSwingPoint(swingPoint, this.swingLows, atr);
        }
    }

    private calculateVolumeSignificance(bars: (BarData | AggregatedBar)[], index: number): number {
        const bar = bars[index];
        let totalNeighborVol = 0;
        let count = 0;

        for (let i = Math.max(0, index - 5); i <= Math.min(bars.length - 1, index + 5); i++) {
            if (i !== index) {
                totalNeighborVol += bars[i].v;
                count++;
            }
        }

        if (count === 0) return 0.5;
        const avgNeighborVol = totalNeighborVol / count;
        const ratio = bar.v / Math.max(avgNeighborVol, 1);
        return Math.min(1, 0.5 + (ratio - 1) * 0.25);
    }

    private addOrMergeSwingPoint(point: SwingPoint, list: SwingPoint[], atr: number): void {
        const clusterThreshold = atr * this.config.clusterThresholdAtr;
        const existing = list.find(p => Math.abs(p.price - point.price) < clusterThreshold);
        
        if (existing) {
            existing.touchCount++;
            existing.lastTouchTs = point.ts;
            existing.touchPrices.push(point.price);
            existing.touchVolumes.push(point.touchVolumes[0] || 0);

            // Cap history arrays
            const maxHistory = this.config.maxTouchHistory;
            if (existing.touchPrices.length > maxHistory) {
                existing.touchPrices.splice(0, existing.touchPrices.length - maxHistory);
                existing.touchVolumes.splice(0, existing.touchVolumes.length - maxHistory);
            }

            existing.strength = this.calculateMultiFactorStrength(existing);
            
            // Update price to weighted average
            const totalWeight = existing.touchVolumes.reduce((a, b) => a + b, 0);
            if (totalWeight > 0) {
                let weightedPrice = 0;
                for (let i = 0; i < existing.touchPrices.length; i++) {
                    weightedPrice += existing.touchPrices[i] * existing.touchVolumes[i];
                }
                existing.price = weightedPrice / totalWeight;
            }

            if (existing.touchCount >= this.config.minTouchesForConfirmed && existing.confirmedAt === 0) {
                existing.confirmedAt = Date.now();
            }
        } else {
            list.push(point);
            if (list.length > this.config.maxLevels) {
                list.sort((a, b) => {
                    const aScore = a.strength * (1 + a.touchCount * 0.1);
                    const bScore = b.strength * (1 + b.touchCount * 0.1);
                    return bScore - aScore;
                });
                list.pop();
            }
        }
    }

    private calculateMultiFactorStrength(point: SwingPoint): number {
        const touchCount = Math.max(1, point.touchCount);
        const touchFactor = Math.min(1, 0.3 + Math.log2(1 + touchCount) * 0.25);

        const volumes = point.touchVolumes.length > 0 ? point.touchVolumes : [1];
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const maxVolume = Math.max(...volumes, 1);
        const volumeFactor = Math.min(1, (avgVolume / maxVolume) * 0.7 + 0.3);

        const bounceFactor = point.avgBounce > 0 ? Math.min(1, point.avgBounce / 2) : 0.5;

        const strength = touchFactor * 0.5 + volumeFactor * 0.3 + bounceFactor * 0.2;
        return Math.min(1, strength);
    }

    private checkTouches(currentBar: BarData | AggregatedBar, atr: number): void {
        const touchThreshold = atr * this.config.touchProximityAtr;
        const typicalPrice = (currentBar.h + currentBar.l + currentBar.c) / 3;

        for (const level of this.swingHighs) {
            // Use bar range intersection
            if (currentBar.h >= level.price - touchThreshold && currentBar.l <= level.price + touchThreshold) {
                const bounce = Math.abs(level.price - currentBar.c) / atr;
                level.touchCount++;
                level.lastTouchTs = currentBar.ts;
                level.touchPrices.push(typicalPrice);
                level.touchVolumes.push(currentBar.v);

                if (level.touchPrices.length > this.config.maxTouchHistory) {
                    level.touchPrices.splice(0, level.touchPrices.length - this.config.maxTouchHistory);
                    level.touchVolumes.splice(0, level.touchVolumes.length - this.config.maxTouchHistory);
                }

                if (bounce > 0) {
                    const prevTotal = level.avgBounce * (level.touchCount - 1);
                    level.avgBounce = (prevTotal + bounce) / level.touchCount;
                    level.maxBounce = Math.max(level.maxBounce, bounce);
                }

                level.strength = this.calculateMultiFactorStrength(level);
                if (level.touchCount >= this.config.minTouchesForConfirmed && level.confirmedAt === 0) {
                    level.confirmedAt = Date.now();
                }
            }
        }

        for (const level of this.swingLows) {
            if (currentBar.l <= level.price + touchThreshold && currentBar.h >= level.price - touchThreshold) {
                const bounce = Math.abs(currentBar.c - level.price) / atr;
                level.touchCount++;
                level.lastTouchTs = currentBar.ts;
                level.touchPrices.push(typicalPrice);
                level.touchVolumes.push(currentBar.v);

                if (level.touchPrices.length > this.config.maxTouchHistory) {
                    level.touchPrices.splice(0, level.touchPrices.length - this.config.maxTouchHistory);
                    level.touchVolumes.splice(0, level.touchVolumes.length - this.config.maxTouchHistory);
                }

                if (bounce > 0) {
                    const prevTotal = level.avgBounce * (level.touchCount - 1);
                    level.avgBounce = (prevTotal + bounce) / level.touchCount;
                    level.maxBounce = Math.max(level.maxBounce, bounce);
                }

                level.strength = this.calculateMultiFactorStrength(level);
                if (level.touchCount >= this.config.minTouchesForConfirmed && level.confirmedAt === 0) {
                    level.confirmedAt = Date.now();
                }
            }
        }
    }

    private applyDecay(): void {
        const decayAmount = this.config.decayRatePerBar;
        for (const level of this.swingHighs) {
            level.strength = Math.max(0, level.strength - decayAmount);
        }
        for (const level of this.swingLows) {
            level.strength = Math.max(0, level.strength - decayAmount);
        }
    }

    private pruneWeakLevels(): void {
        this.swingHighs = this.swingHighs.filter(l => l.strength >= this.config.minStrengthToKeep);
        this.swingLows = this.swingLows.filter(l => l.strength >= this.config.minStrengthToKeep);
    }

    private detectConfirmedBreakout(
        bars: (BarData | AggregatedBar)[],
        atr: number
    ): { type: 'none' | 'resistance_breakout' | 'support_breakdown'; strength: number; volumeConfirmed: boolean } {
        const confirmBars = this.config.breakoutConfirmBars;
        if (bars.length < confirmBars + 1) {
            return { type: 'none', strength: 0, volumeConfirmed: false };
        }

        const recentBars = bars.slice(-confirmBars);
        const currentPrice = recentBars[recentBars.length - 1].c;

        // Check resistance breakout
        for (const resistance of this.swingHighs) {
            const closesAbove = recentBars.filter(bar => bar.c > resistance.price).length;
            const hasBodyMove = recentBars.some(bar => (bar.c - bar.o) > atr * 0.1 && bar.c > resistance.price);
            
            if (closesAbove >= Math.ceil(confirmBars * 0.6) && hasBodyMove) {
                const avgVol = recentBars.reduce((sum, bar) => sum + bar.v, 0) / confirmBars;
                const priorWindowStart = Math.max(0, bars.length - confirmBars - this.config.priorVolBars);
                const priorWindowEnd = Math.max(0, bars.length - confirmBars);
                const priorSlice = bars.slice(priorWindowStart, priorWindowEnd);
                const priorCount = priorSlice.length || 1;
                const priorVol = priorSlice.reduce((sum, bar) => sum + bar.v, 0) / priorCount;
                const volumeConfirmed = priorVol > 0 && avgVol > priorVol * this.config.breakoutVolumeRatio;

                const breakoutMagnitude = (currentPrice - resistance.price) / atr;
                const strength = Math.min(1, 0.5 + breakoutMagnitude * 0.3 + resistance.strength * 0.2);

                // Role Reversal: broken resistance becomes support
                const newSupport: SwingPoint = {
                    ...resistance,
                    id: this.generateId(),
                    type: 'low',
                    strength: resistance.strength * 0.6, // Weaker as mirror level
                    confirmedAt: 0, // Needs re-confirmation
                };
                this.swingLows.push(newSupport);

                // Remove from resistances
                this.swingHighs = this.swingHighs.filter(l => l.id !== resistance.id);
                return { type: 'resistance_breakout', strength, volumeConfirmed };
            }
        }

        // Check support breakdown
        for (const support of this.swingLows) {
            const closesBelow = recentBars.filter(bar => bar.c < support.price).length;
            const hasBodyMove = recentBars.some(bar => (bar.o - bar.c) > atr * 0.1 && bar.c < support.price);
            
            if (closesBelow >= Math.ceil(confirmBars * 0.6) && hasBodyMove) {
                const avgVol = recentBars.reduce((sum, bar) => sum + bar.v, 0) / confirmBars;
                const priorWindowStart = Math.max(0, bars.length - confirmBars - this.config.priorVolBars);
                const priorWindowEnd = Math.max(0, bars.length - confirmBars);
                const priorSlice = bars.slice(priorWindowStart, priorWindowEnd);
                const priorCount = priorSlice.length || 1;
                const priorVol = priorSlice.reduce((sum, bar) => sum + bar.v, 0) / priorCount;
                const volumeConfirmed = priorVol > 0 && avgVol > priorVol * this.config.breakoutVolumeRatio;

                const breakdownMagnitude = (support.price - currentPrice) / atr;
                const strength = Math.min(1, 0.5 + breakdownMagnitude * 0.3 + support.strength * 0.2);

                // Role Reversal: broken support becomes resistance
                const newResistance: SwingPoint = {
                    ...support,
                    id: this.generateId(),
                    type: 'high',
                    strength: support.strength * 0.6,
                    confirmedAt: 0,
                };
                this.swingHighs.push(newResistance);

                // Remove from supports
                this.swingLows = this.swingLows.filter(l => l.id !== support.id);
                return { type: 'support_breakdown', strength, volumeConfirmed };
            }
        }

        return { type: 'none', strength: 0, volumeConfirmed: false };
    }

    private getLevelContext(currentPrice: number, atr: number): LevelContext {
        const resistancesSorted = [...this.swingHighs]
            .filter(l => l.price > currentPrice)
            .sort((a, b) => a.price - b.price);
        
        const supportsSorted = [...this.swingLows]
            .filter(l => l.price < currentPrice)
            .sort((a, b) => b.price - a.price);
            
        const nearestResistance = resistancesSorted[0] || null;
        const nextResistance = resistancesSorted[1] || null;
        const nearestSupport = supportsSorted[0] || null;
        const nextSupport = supportsSorted[1] || null;

        const distToResistance = nearestResistance ? nearestResistance.price - currentPrice : Infinity;
        const distToSupport = nearestSupport ? currentPrice - nearestSupport.price : Infinity;
        
        const minDist = Math.min(distToResistance, distToSupport);
        const distanceToNearestPct = minDist / currentPrice * 100;

        let roomToMove = Infinity;
        if (nearestResistance && distToResistance < distToSupport) {
            roomToMove = distToResistance / atr;
        } else if (nearestSupport) {
            roomToMove = distToSupport / atr;
        }

        let inConsolidation = false;
        if (nearestResistance && nearestSupport) {
            const range = nearestResistance.price - nearestSupport.price;
            inConsolidation = range / atr < 3;
        }

        const now = Date.now();
        const freshThreshold = 30 * 60000;

        return {
            nearestSupport: nearestSupport ? this.swingToLevel(nearestSupport, 'support', now, freshThreshold) : null,
            nearestResistance: nearestResistance ? this.swingToLevel(nearestResistance, 'resistance', now, freshThreshold) : null,
            nextSupport: nextSupport ? this.swingToLevel(nextSupport, 'support', now, freshThreshold) : null,
            nextResistance: nextResistance ? this.swingToLevel(nextResistance, 'resistance', now, freshThreshold) : null,
            inConsolidation,
            distanceToNearestPct,
            roomToMove,
        };
    }

    private swingToLevel(
        swing: SwingPoint,
        type: 'support' | 'resistance',
        now: number,
        freshThreshold: number
    ): PriceLevel {
        return {
            price: swing.price,
            type,
            strength: swing.strength,
            timesTestedCount: swing.touchCount,
            lastTestedTs: swing.lastTouchTs,
            isConfirmed: swing.confirmedAt > 0,
            isFresh: now - swing.createdAt < freshThreshold,
        };
    }

    private clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, value));
    }

    getLevels(): { supports: SwingPoint[]; resistances: SwingPoint[] } {
        return {
            supports: [...this.swingLows],
            resistances: [...this.swingHighs],
        };
    }

    getContext(currentPrice: number, atr: number): LevelContext | null {
        if (this.swingHighs.length === 0 && this.swingLows.length === 0) {
            return null;
        }
        return this.getLevelContext(currentPrice, atr);
    }

    reset(): void {
        this.swingHighs = [];
        this.swingLows = [];
        this.barCount = 0;
        this.lastProcessedBarTs = 0;
    }
}