import 'reflect-metadata';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { SignalAnalyzerService, BarData } from '../src/domain/signal-analyzer';
import { MeanReversionModule, OIModule } from '../src/domain/signal-analyzer/modules';
import { TradeGatekeeper } from '../src/domain/signal-analyzer/gatekeeper/trade-gatekeeper';
import { TrendAlignmentGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trend-alignment.gate';
import { MeanReversionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate';
import { AntiSpamGate } from '../src/domain/signal-analyzer/gatekeeper/gates/anti-spam.gate';
import { TradingSessionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trading-session.gate';

/**
 * Тип для описания активной сделки в бэктесте.
 */
interface BacktestTrade {
    action: 'LONG' | 'SHORT';
    entry: number;
    tp: number[];
    sl: number;
    ts: number;
    sizeUsd: number; // Размер позиции в USD с учетом плеча
    tags: string[];
}

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================

const SYMBOLS_TO_TEST: string[] = [
    //============6===========
    // 'TRUTHUSDT', 'TNSRUSDT', 'TANSSIUSDT', 'SKYAIUSDT', 'RIVERUSDT', 'QTUMUSDT', 'PTBUSDT',
    // 'PROMPTUSDT', 'POWERUSDT', 'PIEVERSEUSDT', 'MERLUSDT', 'LRCUSDT', 'LIGHTUSDT', 'JELLYJELLYUSDT',
    // 'HANAUSDT', 'FOLKSUSDT', 'FHEUSDT', 'COMPUSDT', 'BRUSDT', 'BEATUSDT', 'BASUSDT'
    //============6===========
    // '42USDT  AINUSDT AIOTUSDT BARDUSDT BDXNUSDT BEATUSDT'
    // 'ETHUSDT', 'BTCUSDT' // Раскомментируйте или добавьте монеты сюда. Если список пуст - берутся ВСЕ монеты из базы.
];

/**
 * Черный список монет (будут пропущены)
 */
const BLACKLIST: string[] = ['GUSDT'];

/**
 * Минимальный средний объем за 24 часа (в USDT)
 * Если средний объем монеты за весь период меньше этого значения, она скипается.
 */
const MIN_VOLUME_24H = 1_000_000; // 10 млн$

/**
 * Начальный баланс кошелька (в USDT)
 */
const INITIAL_BALANCE = 100;

/**
 * Кредитное плечо
 */
const LEVERAGE = 3;

/**
 * Маржа на одну сделку (в USDT).
 * Размер позиции = MARGIN_PER_TRADE * LEVERAGE
 * Например: 100$ маржи * 10 плечо = 1000$ позиция
 */
const MARGIN_PER_TRADE = 10;

/**
 * Комиссия Binance (Taker) фьючерсы: 0.04% (=0.0004)
 * Стандартный уровень VIP 0
 */
const BINANCE_COMMISSION_RATE = 0.0004;

// ==========================================

async function runAdvancedBacktest() {
    // 1. Подключаемся к локальной базе
    await DatabaseModule.initialize();
    const historyRepo = AppDataSource.getRepository(HistoryCandle);

    // 2. Инициализируем Анализатор
    // Аналитические модули (BaseModule[])
    const modules = [
        new MeanReversionModule(),
        // new OIModule()
    ];
    const gates = [
        new TrendAlignmentGate(),
        new MeanReversionGate(),
        new TradingSessionGate(),
        new AntiSpamGate()
    ];

    // 2. Создаем Gatekeeper
    const gatekeeper = new TradeGatekeeper(gates);

    // 3. Создаем Сервис с переданным Gatekeeper
    const analyzer = new SignalAnalyzerService(modules, gatekeeper);

    console.log('🚀 Starting SERIOUS Backtest...');
    console.log(`💰 Balance: $${INITIAL_BALANCE} | 🎰 Leverage: x${LEVERAGE}`);
    console.log(`🚫 Blacklist: ${BLACKLIST.join(', ')}`);
    console.log(`📊 Min Vol 24h: $${(MIN_VOLUME_24H / 1_000_000).toFixed(1)}M`);

    // Статистика
    let totalPnL = 0;
    let wins = 0;
    let losses = 0;
    let currentBalance = INITIAL_BALANCE;
    let totalFeesPaid = 0;

    // Для расчета Max Drawdown
    let maxBalance = INITIAL_BALANCE;
    let maxDrawdown = 0;

    // 2.1 Определяем список монет
    let symbolsToBacktest = SYMBOLS_TO_TEST;

    if (symbolsToBacktest.length === 0) {
        console.log('📋 SYMBOLS_TO_TEST is empty. Fetching ALL symbols from DB...');
        const uniqueSymbols = await historyRepo
            .createQueryBuilder('candle')
            .select('DISTINCT(candle.symbol)', 'symbol')
            .getRawMany();

        symbolsToBacktest = uniqueSymbols.map(s => s.symbol);
        console.log(`✅ Found ${symbolsToBacktest.length} symbols in database.`);
    }

    for (const symbol of symbolsToBacktest) {
        // A. Blacklist Filter
        if (BLACKLIST.includes(symbol)) {
            console.log(`⏭️ Skipping ${symbol} (Blacklisted)`);
            continue;
        }

        // 3. Выгружаем свечи
        const entities = await historyRepo.find({
            where: { symbol },
            order: { ts: 'ASC' }
        });

        if (entities.length < 200) {
            console.log(`⚠️ Not enough data for ${symbol} (<200)`);
            continue;
        }

        // Достаем JSON обратно в BarData
        const bars = entities.map(e => e.data as unknown as BarData);

        // B. Volume Filter (Average 24h Volume)
        // Считаем средний объем (v * c) по всем свечам
        // Это упрощенная оценка, но эффективная
        const avgPrice = bars.reduce((sum, b) => sum + b.c, 0) / bars.length;
        const avgVolCoins = bars.reduce((sum, b) => sum + b.v, 0) / bars.length;
        // Для 15м свечей: объем за 24ч = средний объем за 15м * (24 * 4)
        // Для 1м свечей: объем за 24ч = средний объем за 1м * (24 * 60)
        // Предполагаем, что свечи могут быть разные, но volume обычно за интервал.
        // Чтобы не гадать интервал, просто возьмем сумму объема всей истории / кол-во дней
        const durationH = (bars[bars.length - 1].ts - bars[0].ts) / 3600000;
        const totalVolumeUsd = bars.reduce((sum, b) => sum + (b.v * b.c), 0);
        const avgVolume24h = (totalVolumeUsd / durationH) * 24;

        if (avgVolume24h < MIN_VOLUME_24H) {
            // console.log(`Dataset duration: ${durationH.toFixed(1)}h`);
            // console.log(`Total Vol: $${(totalVolumeUsd / 1_000_000).toFixed(2)}M`);
            // console.log(`Avg Vol 24h: $${(avgVolume24h / 1_000_000).toFixed(2)}M`);
            // console.log(`⏭️ Skipping ${symbol} (Low Volume: $${(avgVolume24h / 1_000_000).toFixed(2)}M < $${(MIN_VOLUME_24H / 1_000_000).toFixed(1)}M)`);
            continue;
        }

        console.log(`\n📊 Analyzing ${symbol} (${bars.length} candles, Vol24h: ~$${(avgVolume24h / 1_000_000).toFixed(1)}M)...`);

        // 4. Симуляция (Loop)
        let activeTrade: BacktestTrade | null = null;
        const warmup = 100; // Прогрев индикаторов

        // Прогреваем
        analyzer.warmUp(symbol, bars.slice(0, warmup));

        for (let i = warmup; i < bars.length; i++) {
            const currentBar = bars[i];

            // Drawdown check (обновляем на каждой свече или сделке? Правильнее на сделке, но пока так)
            if (currentBalance > maxBalance) maxBalance = currentBalance;
            const currentDD = (maxBalance - currentBalance) / maxBalance;
            if (currentDD > maxDrawdown) maxDrawdown = currentDD;

            // Stop if bankrupt
            if (currentBalance <= 0) {
                console.log(`💀 BANKRUPTCY at ${symbol} candle ${i}`);
                break;
            }

            const slice = bars.slice(0, i + 1);

            // А. Проверка выхода из сделки
            if (activeTrade) {
                const res = checkTrade(activeTrade, currentBar);
                if (res !== 'PENDING') {
                    const entry = activeTrade.entry;
                    const exit = res === 'WIN' ? activeTrade.tp[0] : activeTrade.sl;
                    const direction = activeTrade.action === 'LONG' ? 1 : -1;

                    // PnL % движения цены
                    const pnlPricePct = (exit - entry) / entry;

                    // Реальный PnL в долларах = (Направление * %Движения) * РазмерПозиции
                    const rawPnlUsd = direction * pnlPricePct * activeTrade.sizeUsd;

                    // Комиссия (открыли на sizeUsd, закрыли на sizeUsd + PnL)
                    // Упрощение: считаем комиссию от (sizeUsd + sizeUsd) т.к. изменение цены незначительно для комиссии
                    // Точнее: OpenFee = sizeUsd * Rate, CloseFee = (sizeUsd + rawPnlUsd) * Rate
                    // Но, при плече margin * leverage...
                    const openFee = activeTrade.sizeUsd * BINANCE_COMMISSION_RATE;
                    const closeVal = activeTrade.sizeUsd + rawPnlUsd;
                    // Важно: Позиция закрывается полностью. Объем закрытия = Стоимость активов на момент закрытия.
                    // При Лонге: купили на 1000$, цена выросла на 10%, активы стоят 1100$. Продаем 1100$. Комиссия с 1100$.
                    // При Шорте: продали на 1000$, цена упала на 10%, выкупаем обратно дешевле. Номинал контракта...
                    // Для простоты USDT-M фьючерсов: комиссия берется от номинала сделки.
                    const closeFee = Math.abs(closeVal) * BINANCE_COMMISSION_RATE;

                    const totalCommission = openFee + closeFee;
                    const netPnl = rawPnlUsd - totalCommission;

                    currentBalance += netPnl;
                    totalPnL += netPnl;
                    totalFeesPaid += totalCommission;
                    res === 'WIN' ? wins++ : losses++;

                    console.log(`   ${res === 'WIN' ? '✅' : '❌'} ${activeTrade.action} Closed. PnL: $${netPnl.toFixed(2)} (Fee: $${totalCommission.toFixed(2)}) Bal: $${currentBalance.toFixed(2)} Tags: [${activeTrade.tags.join(', ')}]`);
                    activeTrade = null;
                }
                continue;
            }

            // Б. Анализ
            const signal = analyzer.analyze(symbol, slice);

            // В. Вход
            if (signal.action !== 'NO_TRADE') {
                // Проверка доступного баланса
                if (currentBalance < MARGIN_PER_TRADE) {
                    // console.log(`   ⚠️ Not enough balance to trade ($${currentBalance.toFixed(2)})`);
                    continue;
                }

                console.log(`⚡ SIGNAL [${new Date(currentBar.ts).toISOString().slice(11, 16)}]: ${signal.action} @ ${signal.entryPrice} (Conf: ${signal.confidence.toFixed(2)}) Tags: [${signal.reasonTags.join(', ')}]`);

                // Размер позиции = Маржа * Плечо
                const positionSizeUsd = MARGIN_PER_TRADE * LEVERAGE;

                activeTrade = {
                    action: signal.action,
                    entry: signal.entryPrice,
                    tp: signal.tp,
                    sl: signal.sl,
                    ts: currentBar.ts,
                    sizeUsd: positionSizeUsd,
                    tags: signal.reasonTags
                };

                console.log(JSON.stringify(activeTrade));
            }
        }
    }

    console.log('\n=======================================');
    console.log(`🏁 RESULT: ${wins}W / ${losses}L (${(wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 0}% Winrate)`);
    console.log(`💰 Net PnL After Fees: $${(currentBalance - INITIAL_BALANCE).toFixed(2)}`);
    console.log(`💸 Total Binance Fees Paid: $${totalFeesPaid.toFixed(2)}`);
    console.log(`📉 Max Drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);
    console.log(`🏦 FINAL Balance: $${currentBalance.toFixed(2)} (Start: $${INITIAL_BALANCE}, x${(currentBalance / INITIAL_BALANCE).toFixed(2)})`);
    console.log('=======================================');

    await DatabaseModule.close();
}

function checkTrade(trade: BacktestTrade, bar: BarData) {
    if (trade.action === 'LONG') {
        if (bar.l <= trade.sl) return 'LOSS';
        if (bar.h >= trade.tp[0]) return 'WIN'; // Пока тестируем TP1
    } else {
        if (bar.h >= trade.sl) return 'LOSS';
        if (bar.l <= trade.tp[0]) return 'WIN'; // Пока тестируем TP1
    }
    // Time stop (2 часа)
    if (bar.ts - trade.ts > 120 * 60000) return 'LOSS';
    return 'PENDING';
}

runAdvancedBacktest();
