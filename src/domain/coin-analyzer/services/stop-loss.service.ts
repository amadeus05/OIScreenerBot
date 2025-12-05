/**
 * Stop Loss Calculator Service
 * 
 * Calculates stop loss based on ATR and market structure.
 */

import { Injectable } from '../../../shared/decorators';
import { IStopLossCalculator } from '../interfaces';
import { AnalysisContext, StopLossResult, TradeDirection } from '../types';

@Injectable()
export class StopLossCalculator implements IStopLossCalculator {

    /**
     * ATR multiplier for stop loss distance.
     * 2x ATR is a common setting for volatility-based stops.
     */
    private readonly ATR_MULTIPLIER = 2.0;

    /**
     * Maximum stop loss percentage to cap risk.
     */
    private readonly MAX_STOP_PERCENT = 5.0;

    /**
     * Minimum stop loss percentage to avoid getting stopped out by noise.
     */
    private readonly MIN_STOP_PERCENT = 0.5;

    calculate(
        context: AnalysisContext,
        direction: TradeDirection,
        entryPrice: number
    ): StopLossResult {
        // Get ATR from 15m timeframe (most relevant for swing/intraday)
        const tf15m = context.multiTF.tf15m;
        const atr = tf15m.atr;

        // Calculate ATR-based stop distance
        let stopDistance = atr * this.ATR_MULTIPLIER;
        let stopPercent = (stopDistance / entryPrice) * 100;

        // Clamp stop percentage
        stopPercent = Math.max(this.MIN_STOP_PERCENT, Math.min(this.MAX_STOP_PERCENT, stopPercent));
        stopDistance = entryPrice * (stopPercent / 100);

        // Calculate stop price based on direction
        let stopPrice: number;
        let reason: string;

        if (direction === TradeDirection.LONG) {
            stopPrice = entryPrice - stopDistance;

            // Check if there's a support level that could serve as stop
            const nearestSupport = this.findNearestBelow(entryPrice, tf15m.supportLevels);
            if (nearestSupport && nearestSupport > stopPrice) {
                // Use support level minus small buffer
                const supportStop = nearestSupport * 0.998;
                const supportPercent = ((entryPrice - supportStop) / entryPrice) * 100;

                if (supportPercent <= this.MAX_STOP_PERCENT) {
                    stopPrice = supportStop;
                    stopPercent = supportPercent;
                    reason = `Below support at ${nearestSupport.toFixed(2)} (${stopPercent.toFixed(1)}%)`;

                    return {
                        price: stopPrice,
                        distancePercent: stopPercent,
                        method: 'SWING',
                        reason,
                    };
                }
            }

            reason = `${this.ATR_MULTIPLIER}x ATR below entry (${stopPercent.toFixed(1)}%)`;
        } else {
            // SHORT
            stopPrice = entryPrice + stopDistance;

            // Check if there's a resistance level that could serve as stop
            const nearestResistance = this.findNearestAbove(entryPrice, tf15m.resistanceLevels);
            if (nearestResistance && nearestResistance < stopPrice) {
                // Use resistance level plus small buffer
                const resistanceStop = nearestResistance * 1.002;
                const resistancePercent = ((resistanceStop - entryPrice) / entryPrice) * 100;

                if (resistancePercent <= this.MAX_STOP_PERCENT) {
                    stopPrice = resistanceStop;
                    stopPercent = resistancePercent;
                    reason = `Above resistance at ${nearestResistance.toFixed(2)} (${stopPercent.toFixed(1)}%)`;

                    return {
                        price: stopPrice,
                        distancePercent: stopPercent,
                        method: 'SWING',
                        reason,
                    };
                }
            }

            reason = `${this.ATR_MULTIPLIER}x ATR above entry (${stopPercent.toFixed(1)}%)`;
        }

        return {
            price: stopPrice,
            distancePercent: stopPercent,
            method: 'ATR',
            reason,
        };
    }

    /**
     * Find the nearest level below the price.
     */
    private findNearestBelow(price: number, levels: number[]): number | null {
        const belowLevels = levels.filter(l => l < price);
        if (belowLevels.length === 0) return null;
        return Math.max(...belowLevels);
    }

    /**
     * Find the nearest level above the price.
     */
    private findNearestAbove(price: number, levels: number[]): number | null {
        const aboveLevels = levels.filter(l => l > price);
        if (aboveLevels.length === 0) return null;
        return Math.min(...aboveLevels);
    }
}
