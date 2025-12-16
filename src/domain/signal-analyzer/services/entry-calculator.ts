import { TradeAction, EntryType, BarData, AggregatedBar, Features } from '../types';
import { DEFAULT_CONFIG } from '../types/config';
import { MarketRegime } from './regime-supervisor';

export interface EntryResult {
    entryType: EntryType;
    entryPrice: number;
    sl: number;
    tp: number[];
    tpPct: number[];
    horizonMin: number;
    
    // === ОБНОВЛЕННЫЕ ПОЛЯ ДЛЯ СИНХРОНИЗАЦИИ ===
    riskPct: number;          // % риска от депозита
    positionSizeUsd: number;  // Итоговый объем позиции в $ (Margin * Leverage)
    quantity: number;         // Количество монет (для ордера)
    
    expectedPnL: number;      // Ожидаемый PnL при TP1 (Netto, с учетом комиссий)
    feesInfo: {               // Метаданные для дебага
        entryFee: number;
        exitFeeSl: number;
        exitFeeTp: number;
    };
    
    isValid: boolean;
    reason?: string;
}

export class EntryCalculator {
    private readonly config = DEFAULT_CONFIG;

    calculate(
        action: TradeAction,
        bars: (BarData | AggregatedBar)[],
        features: Features,
        confidence: number,
        regime: MarketRegime = 'RANGING',
        portfolioBalance: number = this.config.position.defaultPortfolioSize // Можно прокинуть реальный баланс
    ): EntryResult {
        if (action === 'NO_TRADE' || bars.length < 5) {
            return this.emptyResult();
        }

        const currentBar = bars[bars.length - 1];
        const isLong = action === 'LONG';
        const direction = isLong ? 1 : -1;

        // 1. ENTRY PRICE
        let entryPrice = currentBar.c;
        let entryType: EntryType = 'market';
        let entryFeeRate = this.config.fees.taker; // По умолчанию маркет = тейкер

        // Если используем лимитный вход (смещение)
        if (this.config.technical.entryOffsetAtrMult > 0) {
            const offset = features.atr * this.config.technical.entryOffsetAtrMult;
            // Для Long лимитка ниже цены, для Short выше
            entryPrice -= (direction * offset);
            entryType = 'limit';
        }
        
        // 2. STOP LOSS (Structural + ATR)
        const lookback = this.config.technical.slStructuralBars || 2;
        const relevantBars = bars.slice(-lookback);
        const recentHigh = Math.max(...relevantBars.map(b => b.h));
        const recentLow = Math.min(...relevantBars.map(b => b.l));

        let slMultiplier = this.config.technical.slAtrMultMin;
        if (regime === 'VOLATILE') slMultiplier = this.config.technical.slAtrMultMax;

        let slPrice: number;
        if (isLong) {
            const structuralSl = recentLow - (features.atr * slMultiplier);
            const maxSlDist = features.atr * this.config.technical.slAtrMultMax;
            slPrice = Math.max(structuralSl, entryPrice - maxSlDist);
        } else {
            const structuralSl = recentHigh + (features.atr * slMultiplier);
            const maxSlDist = features.atr * this.config.technical.slAtrMultMax;
            slPrice = Math.min(structuralSl, entryPrice + maxSlDist);
        }

        // Защита от слишком близкого стопа (минимум 0.3%)
        const minSlDist = entryPrice * 0.003;
        if (Math.abs(entryPrice - slPrice) < minSlDist) {
            slPrice = entryPrice - (direction * minSlDist);
        }

        // 3. TAKE PROFIT (С сохранением старой логики + Pump)
        const isPumpPullback = (
            features?.pChange30m !== undefined &&
            Math.abs(features.pChange30m) >= 0.08
        );

        // Дистанция риска (без учета плеча)
        const priceDistanceToSl = Math.abs(entryPrice - slPrice); 
        
        let tp: number[];
        
        if (isPumpPullback) {
            // Adaptive R:R
            tp = [
                entryPrice + (direction * priceDistanceToSl * 1.5),
                entryPrice + (direction * priceDistanceToSl * 3.0)
            ];
        } else {
            // Classic Logic
            let tpRatios = this.config.technical.tpRatios; // [1.5, 3.0] default
            if (regime === 'TRENDING') tpRatios = [3.0, 6.0];
            
            tp = tpRatios.map(ratio => entryPrice + (direction * priceDistanceToSl * ratio));
        }
        
        // 4. POSITION SIZING & RISK CALCULATION (СИНХРОНИЗАЦИЯ)
        // =======================================================
        
        // 4.1 Рассчитываем допустимый риск на сделку в долларах
        let riskPct = this.config.position.baseRiskPct;
        riskPct *= confidence; // Корректируем по уверенности
        if (regime === 'VOLATILE') riskPct *= 0.7; // Снижаем в волатильности
        
        const riskAmountUsd = portfolioBalance * (riskPct / 100);

        // 4.2 % движения цены до стопа
        const stopLossPct = priceDistanceToSl / entryPrice;

        // 4.3 Размер позиции (Full Notional Value) = Риск ($) / % до стопа
        let positionSizeUsd = riskAmountUsd / stopLossPct;

        // 4.4 Применяем лимиты
        positionSizeUsd = Math.min(positionSizeUsd, this.config.position.maxPositionSizeUsd);
        
        // Округляем до разумного (Quantity precision не знаем, берем грубо)
        const quantity = positionSizeUsd / entryPrice;
        
        // 5. FEE & NET PNL CALCULATION (REAL BINANCE MATH)
        // =================================================
        
        // Вход (Taker)
        const entryFee = positionSizeUsd * this.config.fees.taker;
        
        // Выход по SL (Market = Taker)
        const exitFeeSl = positionSizeUsd * this.config.fees.taker;
        
        // Выход по TP (Limit = Maker)
        const exitFeeTp = positionSizeUsd * this.config.fees.maker;

        // Расчет "Чистого" (Net) Профита для TP1
        const grossProfitTp1 = (Math.abs(entryPrice - tp[0]) / entryPrice) * positionSizeUsd;
        const netProfitTp1 = grossProfitTp1 - (entryFee + exitFeeTp);

        // GUARD: Fee Check
        if (entryFee + exitFeeTp > grossProfitTp1 * 0.3) {
             return { ...this.emptyResult(), isValid: false, reason: `Fees too high (${(entryFee + exitFeeTp).toFixed(2)}$ vs Profit ${grossProfitTp1.toFixed(2)}$)` };
        }
        
        // GUARD: Minimum Profit ($1)
        if (netProfitTp1 < 1.0) {
             return { ...this.emptyResult(), isValid: false, reason: `Net profit too low (${netProfitTp1.toFixed(2)}$)` };
        }
        
        // GUARD: Stop Loss width
        const slPct = stopLossPct * 100;
        if (slPct > 5.0) {
            return { ...this.emptyResult(), isValid: false, reason: 'StopLoss too wide (>5%)' };
        }

        // 6. FINAL OUTPUT
        const estimatedMinutes = Math.ceil((priceDistanceToSl * 2) / (features.atr || 1));
        const horizonMin = Math.min(Math.max(30, estimatedMinutes), 180);
        const tpPct = tp.map(p => Math.abs((p - entryPrice) / entryPrice) * 100);

        return {
            entryType,
            entryPrice, // Возвращаем базовую цену (без slippage, т.к. slippage это факт исполнения)
            sl: slPrice,
            tp,
            tpPct,
            horizonMin,
            riskPct, // Возвращаем итоговый % риска, который использовался
            
            // Новые поля
            positionSizeUsd,
            quantity,
            expectedPnL: netProfitTp1,
            feesInfo: {
                entryFee,
                exitFeeSl,
                exitFeeTp
            },
            
            isValid: true
        };
    }

    private emptyResult(): EntryResult {
        return {
            entryType: 'market',
            entryPrice: 0,
            sl: 0,
            tp: [],
            tpPct: [],
            horizonMin: 0,
            riskPct: 0,
            positionSizeUsd: 0,
            quantity: 0,
            expectedPnL: 0,
            feesInfo: { entryFee: 0, exitFeeSl: 0, exitFeeTp: 0 },
            isValid: false
        };
    }
}