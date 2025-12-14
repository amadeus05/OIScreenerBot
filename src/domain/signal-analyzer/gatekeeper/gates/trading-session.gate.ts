import { BaseGate } from '../base-gate';
import { GateContext, GateResult } from '../types';

export enum TradingStatus {
    TRADE_OK = 'TRADE_OK',                 // Можно торговать
    LOW_LIQUIDITY = 'LOW_LIQUIDITY',       // Мало объёма, плохой скальпинг
    SESSION_TRANSITION = 'SESSION_TRANSITION', // Смена сессии, хаос
    DEAD_ZONE = 'DEAD_ZONE',               // Флэт между сессиями
    NEWS_RISK = 'NEWS_RISK',               // Макро риск
}

export class TradingSessionGate extends BaseGate {
    readonly id = 'trading-session';

    evaluate(ctx: GateContext): GateResult {
        // Parse time from signal
        const ts = new Date(ctx.signal.ts).getTime();
        const status = this.getStatus(ts);

        if (status !== TradingStatus.TRADE_OK) {
            return this.reject(`Market Status: ${status} (${this.explain(status)})`);
        }

        return this.allow();
    }

    private getStatus(ts: number): TradingStatus {
        const date = new Date(ts);
        const hourUTC = date.getUTCHours();
        const minuteUTC = date.getUTCMinutes();
        const dayUTC = date.getUTCDay();

        // 1. News risk (Placeholder)
        // if (this.isNewsWindow(date)) return TradingStatus.NEWS_RISK;

        // 2. Воскресенье вечер + Понедельник утро (худшее время)
        if (
            (dayUTC === 0 && hourUTC >= 20) ||
            (dayUTC === 1 && hourUTC < 8)
        ) {
            return TradingStatus.DEAD_ZONE;
        }

        // 3. Пятница вечер (закрытие недели)
        if (dayUTC === 5 && hourUTC >= 18) {
            return TradingStatus.SESSION_TRANSITION;
        }

        // 4. Глубокая Азия (только вт-чт)
        if (hourUTC >= 2 && hourUTC < 6 && dayUTC >= 2 && dayUTC <= 4) {
            return TradingStatus.LOW_LIQUIDITY;
        }

        // 5. Переходы сессий (открытие Лондона/Нью-Йорка)
        if (
            (hourUTC === 7 && minuteUTC < 15) ||      // Лондон открытие
            (hourUTC === 13 && minuteUTC >= 30 && minuteUTC < 45) // Нью-Йорк открытие
        ) {
            return TradingStatus.SESSION_TRANSITION;
        }

        return TradingStatus.TRADE_OK;
    }

    private explain(status: TradingStatus): string {
        switch (status) {
            case TradingStatus.LOW_LIQUIDITY:
                return 'Low liquidity (Deep Asia Tue–Thu)';
            case TradingStatus.DEAD_ZONE:
                return 'Weekend liquidity gap (Sun 20:00+ – Mon <08:00)';
            case TradingStatus.SESSION_TRANSITION:
                return 'Unstable volatility (session open or week close)';
            case TradingStatus.NEWS_RISK:
                return 'High-impact news risk';
            default:
                return '';
        }
    }
}
