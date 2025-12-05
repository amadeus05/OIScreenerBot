/**
 * Market Regime Filter
 * 
 * Checks if market conditions are favorable for trading:
 * - Volatility (ATR relative to price)
 * - Trend vs Range detection
 * - Session timing (avoid low liquidity periods)
 */

import { BaseFilter } from './base.filter';
import { AnalysisContext, FilterResult, TrendDirection } from '../types';

export class MarketRegimeFilter extends BaseFilter {
    readonly name = 'MarketRegimeFilter';
    readonly defaultWeight = 1.0;

    // Configuration
    private readonly MIN_ATR_PERCENT = 0.3;    // Minimum volatility for trading
    private readonly MAX_ATR_PERCENT = 5.0;    // Maximum volatility (too chaotic)
    private readonly TREND_BONUS = 0.3;        // Bonus score for trending market

    async analyze(context: AnalysisContext): Promise<FilterResult> {
        const tf15m = context.multiTF.tf15m;
        const atrPercent = (tf15m.atr / context.currentPrice) * 100;

        // Check volatility
        if (atrPercent < this.MIN_ATR_PERCENT) {
            return this.fail(
                -0.5,
                0.8,
                `Low volatility (ATR: ${atrPercent.toFixed(2)}%), market too quiet`,
                { atrPercent, minRequired: this.MIN_ATR_PERCENT }
            );
        }

        if (atrPercent > this.MAX_ATR_PERCENT) {
            return this.fail(
                -0.8,
                0.9,
                `Extreme volatility (ATR: ${atrPercent.toFixed(2)}%), too risky`,
                { atrPercent, maxAllowed: this.MAX_ATR_PERCENT }
            );
        }

        // Check trend clarity
        const trend = tf15m.trend;
        const isTrending = trend !== TrendDirection.SIDEWAYS;

        // Check session (optional - UTC hours)
        const hour = new Date(context.timestamp).getUTCHours();
        const isLowLiquiditySession = hour >= 21 || hour < 1; // Late night UTC

        // Calculate score
        let score = 0.5; // Base score for acceptable volatility
        let confidence = 0.7;

        if (isTrending) {
            score += this.TREND_BONUS;
            confidence += 0.1;
        }

        if (isLowLiquiditySession) {
            score -= 0.2;
            confidence -= 0.1;
        }

        // Optimal volatility zone (1-3%) gets bonus
        if (atrPercent >= 1.0 && atrPercent <= 3.0) {
            score += 0.2;
        }

        const trendText = isTrending ? `trending ${trend}` : 'ranging';
        const sessionText = isLowLiquiditySession ? ', low liquidity session' : '';

        return this.pass(
            score,
            confidence,
            `Market OK: ATR ${atrPercent.toFixed(2)}%, ${trendText}${sessionText}`,
            {
                atrPercent,
                trend,
                hour,
                isTrending: isTrending.toString(),
                isLowLiquidity: isLowLiquiditySession.toString(),
            }
        );
    }
}
