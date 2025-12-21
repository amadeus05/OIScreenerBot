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
        const minutes = hourUTC * 60 + minuteUTC;

        // 1. News risk (Placeholder)
        // if (this.isNewsWindow(date)) return TradingStatus.NEWS_RISK;

        // 2. Глубокие выходные/ранний понедельник — наихудшая ликвидность
        if (this.isWeekendDeadZone(dayUTC, minutes)) return TradingStatus.DEAD_ZONE;

        // 3. Пятница вечер (закрытие недели)
        if (this.isFridayClose(dayUTC, minutes)) return TradingStatus.SESSION_TRANSITION;

        // 4. Турбулентность открытия Лондона/Нью-Йорка с учётом DST
        if (this.isLondonOpenWindow(date, minutes)) return TradingStatus.SESSION_TRANSITION;
        if (this.isNewYorkOpenWindow(date, minutes)) return TradingStatus.SESSION_TRANSITION;

        // 5. Перекрытие Лондон–Нью-Йорк даёт всплески волатильности
        if (this.isOverlapWindow(minutes)) return TradingStatus.SESSION_TRANSITION;

        // 6. Глубокая Азия (только вт–чт)
        if (this.isDeepAsiaLowLiquidity(dayUTC, minutes)) return TradingStatus.LOW_LIQUIDITY;

        return TradingStatus.TRADE_OK;
    }

    private explain(status: TradingStatus): string {
        switch (status) {
            case TradingStatus.LOW_LIQUIDITY:
                return 'Low liquidity (Deep Asia Tue–Thu 02:00–06:00 UTC)';
            case TradingStatus.DEAD_ZONE:
                return 'Weekend liquidity gap (Sat + Sun <20:00 UTC, Mon <07:00 UTC)';
            case TradingStatus.SESSION_TRANSITION:
                return 'Unstable volatility (session open/overlap or week close)';
            case TradingStatus.NEWS_RISK:
                return 'High-impact news risk';
            default:
                return '';
        }
    }

    private isWeekendDeadZone(dayUTC: number, minutes: number): boolean {
        // Суббота полностью, воскресенье до 20:00, понедельник до 07:00
        const twentyOneHundred = 20 * 60;
        const sevenHundred = 7 * 60;
        if (dayUTC === 6) return true; // Saturday
        if (dayUTC === 0 && minutes < twentyOneHundred) return true; // Sunday pre-20:00
        if (dayUTC === 1 && minutes < sevenHundred) return true; // Early Monday
        return false;
    }

    private isFridayClose(dayUTC: number, minutes: number): boolean {
        // Пятница после 18:00 UTC — закрытие недели
        const eighteenHundred = 18 * 60;
        return dayUTC === 5 && minutes >= eighteenHundred;
    }

    private isLondonOpenWindow(date: Date, minutes: number): boolean {
        const londonOpenHourUTC = this.isEuropeDst(date) ? 7 : 8; // 08:00 London local
        const openMinutes = londonOpenHourUTC * 60;
        // Окно: 30 мин до и 60 мин после открытия
        return this.inWindow(minutes, openMinutes - 30, openMinutes + 60);
    }

    private isNewYorkOpenWindow(date: Date, minutes: number): boolean {
        // 09:30 NY local => 13:30 UTC (EDT) или 14:30 UTC (EST)
        const isDst = this.isUsDst(date);
        const openMinutes = (isDst ? 13 : 14) * 60 + 30;
        return this.inWindow(minutes, openMinutes - 30, openMinutes + 60);
    }

    private isOverlapWindow(minutes: number): boolean {
        // Перекрытие Лондон–Нью-Йорк: 12:00–15:00 UTC
        return this.inWindow(minutes, 12 * 60, 15 * 60);
    }

    private isDeepAsiaLowLiquidity(dayUTC: number, minutes: number): boolean {
        // Вт–Чт 02:00–06:00 UTC — обычно тонкий стакан
        const twoHundred = 2 * 60;
        const sixHundred = 6 * 60;
        return dayUTC >= 2 && dayUTC <= 4 && this.inWindow(minutes, twoHundred, sixHundred);
    }

    private inWindow(value: number, start: number, end: number): boolean {
        return value >= start && value < end;
    }

    // Приближённая модель DST без зависимости от сторонних библиотек:
    // Европа: последнее воскресенье марта — последнее воскресенье октября
    private isEuropeDst(date: Date): boolean {
        const year = date.getUTCFullYear();
        const start = this.lastSundayOfMonth(year, 2); // March
        const end = this.lastSundayOfMonth(year, 9); // October
        return date >= start && date < end;
    }

    // США: второе воскресенье марта — первое воскресенье ноября
    private isUsDst(date: Date): boolean {
        const year = date.getUTCFullYear();
        const start = this.nthWeekdayOfMonth(year, 2, 0, 2); // March, Sunday, 2nd
        const end = this.nthWeekdayOfMonth(year, 10, 0, 1); // November, Sunday, 1st
        return date >= start && date < end;
    }

    private nthWeekdayOfMonth(year: number, month: number, weekday: number, occurrence: number): Date {
        // month: 0-based, weekday: 0=Sun ... 6=Sat
        const firstDay = new Date(Date.UTC(year, month, 1));
        const offset = (weekday - firstDay.getUTCDay() + 7) % 7;
        const day = 1 + offset + (occurrence - 1) * 7;
        return new Date(Date.UTC(year, month, day));
    }

    private lastSundayOfMonth(year: number, month: number): Date {
        const lastDay = new Date(Date.UTC(year, month + 1, 0));
        const offset = lastDay.getUTCDay();
        const day = lastDay.getUTCDate() - offset;
        return new Date(Date.UTC(year, month, day));
    }
}
