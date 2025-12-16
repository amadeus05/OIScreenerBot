import 'reflect-metadata';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';
import { SignalAnalyzerService, BarData, TradeAction } from '../src/domain/signal-analyzer';
import { MeanReversionModule } from '../src/domain/signal-analyzer/modules';
import { TradeGatekeeper } from '../src/domain/signal-analyzer/gatekeeper/trade-gatekeeper';
import { TrendAlignmentGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trend-alignment.gate';
import { MeanReversionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/mean-reversion.gate';
import { AntiSpamGate } from '../src/domain/signal-analyzer/gatekeeper/gates/anti-spam.gate';
import { TradingSessionGate } from '../src/domain/signal-analyzer/gatekeeper/gates/trading-session.gate';
// 👇 ИМПОРТИРУЕМ КОНФИГ, ЧТОБЫ БЫЛО КАК В БОТЕ
import { DEFAULT_CONFIG } from '../src/domain/signal-analyzer/types/config';

/**
 * Тип для описания активной сделки в бэктесте.
 */
interface BacktestTrade {
    symbol: string;
    action: TradeAction;
    entryPrice: number;
    quantity: number;        // Кол-во монет
    positionSizeUsd: number; // Номинальный объем ($)
    tp: number[];
    sl: number;
    ts: number;              // Время входа
    entryFeePaid: number;    // Комиссия, уплаченная при входе
    tags: string[];
}

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================

// БЕРЕМ НАСТРОЙКИ ИЗ КОНФИГА БОТА
const FEES = DEFAULT_CONFIG.fees; // Maker: 0.02%, Taker: 0.05%
const POSITION_CFG = DEFAULT_CONFIG.position; 

const INITIAL_BALANCE = 100; 
const MIN_VOLUME_24H = 1_000_000;

const SYMBOLS_TO_TEST: string[] = [
    //============6===========
    // 'TRUTHUSDT', 'TNSRUSDT', 'TANSSIUSDT', 'SKYAIUSDT', 'RIVERUSDT', 'QTUMUSDT', 'PTBUSDT',
    // 'PROMPTUSDT', 'POWERUSDT', 'PIEVERSEUSDT', 'MERLUSDT', 'LRCUSDT', 'LIGHTUSDT', 'JELLYJELLYUSDT',
    // 'HANAUSDT', 'FOLKSUSDT', 'FHEUSDT', 'COMPUSDT', 'BRUSDT', 'BEATUSDT', 'BASUSDT',
    //============6===========
    // 'ACEUSDT', 'AIOTUSDT', 'AIOUSDT', 'BASUSDT', 'BDXNUSDT', 'BEATUSDT', 'COAIUSDT', 'EDENUSDT',
    // 'FHEUSDT', 'FOLKSUSDT', 'JELLYJELLYUSDT', 'LIGHTUSDT', 'NXPCUSDT', 'ORCAUSDT', 'PORTALUSDT', 'POWERUSDT',
    // 'PTBUSDT', 'RIVERUSDT', 'SKYAIUSDT', 'SWARMSUSDT', 'TAKEUSDT', 'TRUTHUSDT'
    //============3===========
    '42USDT', 'AINUSDT', 'AIOTUSDT', 'BARDUSDT', 'BDXNUSDT', 'BEATUSDT', 'IRYSUSDT',
    'JCTUSDT', 'JELLYJELLYUSDT', 'PIEVERSEUSDT', 'RDNTUSDT', 'SHELLUSDT', 'TRUTHUSDT', 'UAIUSDT',
    'USUALUSDT', 'YALAUSDT'
    //============3===========

    // 'ETHUSDT', 'BTCUSDT' // Раскомментируйте или добавьте монеты сюда. Если список пуст - берутся ВСЕ монеты из базы.
];

const BLACKLIST: string[] = ['GUSDT'];

// ==========================================

async function runAdvancedBacktest() {
    // 1. Подключаемся к базе
    await DatabaseModule.initialize();
    const historyRepo = AppDataSource.getRepository(HistoryCandle);

    // 2. Инициализируем Анализатор
    const modules = [new MeanReversionModule()];
    const gates = [
        new TrendAlignmentGate(),
        new MeanReversionGate(),
        new TradingSessionGate(),
        new AntiSpamGate()
    ];

    const gatekeeper = new TradeGatekeeper(gates);
    const analyzer = new SignalAnalyzerService(modules, gatekeeper);

    console.log('🚀 Starting SYNCHRONIZED Backtest...');
    console.log(`💰 Initial Balance: $${INITIAL_BALANCE}`);
    console.log(`🎰 Leverage Limit: x${POSITION_CFG.leverage}`);
    console.log(`🛡️ Base Risk per Trade: ${POSITION_CFG.baseRiskPct}%`);
    console.log(`💸 Fees: Maker ${FEES.maker*100}%, Taker ${FEES.taker*100}%`);

    // Статистика
    let totalPnL = 0;
    let wins = 0;
    let losses = 0;
    let currentBalance = INITIAL_BALANCE;
    let totalFeesPaid = 0;
    let totalTrades = 0;

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
    }

    for (const symbol of symbolsToBacktest) {
        if (BLACKLIST.includes(symbol)) continue;

        // 3. Выгружаем данные
        const rawResults = await historyRepo
            .createQueryBuilder('h')
            .select('h.data')
            .where('h.symbol = :symbol', { symbol })
            .orderBy('h.ts', 'ASC')
            .getMany();
        
        const bars = rawResults.map(r => r.data as unknown as BarData);

        if (bars.length < 200) continue;

        // Фильтр объема
        const durationH = (bars[bars.length - 1].ts - bars[0].ts) / 3600000;
        const totalVolumeUsd = bars.reduce((sum, b) => sum + (b.v * b.c), 0);
        const avgVolume24h = (totalVolumeUsd / durationH) * 24;

        if (avgVolume24h < MIN_VOLUME_24H) continue;

        console.log(`\n📊 Analyzing ${symbol} (${bars.length} candles)...`);

        // 4. Симуляция
        let activeTrade: BacktestTrade | null = null;
        const warmup = 150;

        // Прогреваем
        analyzer.warmUp(symbol, bars.slice(0, warmup));

        for (let i = warmup; i < bars.length; i++) {
            const currentBar = bars[i];

            // Drawdown check
            if (currentBalance > maxBalance) maxBalance = currentBalance;
            const currentDD = (maxBalance - currentBalance) / maxBalance;
            if (currentDD > maxDrawdown) maxDrawdown = currentDD;
            
            // Bankruptcy
            if (currentBalance <= 10) break;

            // Срез данных для анализа
            const slice = bars.slice(0, i + 1);

            // === A. УПРАВЛЕНИЕ АКТИВНОЙ СДЕЛКОЙ ===
            if (activeTrade) {
                const trade = activeTrade;
                let closePrice: number | null = null;
                let isWin = false;
                let isMaker = false; // TP - Maker (limit), SL - Taker (market)
                let reason = '';

                const isLong = trade.action === 'LONG';

                // 1. Проверяем SL (Самое важное - проверяем первым)
                const hitSL = isLong ? currentBar.l <= trade.sl : currentBar.h >= trade.sl;
                
                // 2. Проверяем TP (теперь учитываем и TP1, и TP2)
                const hitTP1 = isLong ? currentBar.h >= trade.tp[0] : currentBar.l <= trade.tp[0];
                const hitTP2 = trade.tp.length > 1 && (isLong ? currentBar.h >= trade.tp[1] : currentBar.l <= trade.tp[1]);

                // 3. Time Stop (Horizon)
                const durationMins = (currentBar.ts - trade.ts) / 60000;
                const isExpired = durationMins > 180; 

                if (hitSL) {
                    closePrice = trade.sl; 
                    isWin = false;
                    isMaker = false;
                    reason = 'SL';
                } else if (hitTP2) {
                    closePrice = trade.tp[1];
                    isWin = true;
                    isMaker = true;
                    reason = 'TP2';
                } else if (hitTP1) {
                    closePrice = trade.tp[0];
                    isWin = true;
                    isMaker = true;
                    reason = 'TP1';
                } else if (isExpired) {
                    closePrice = currentBar.c;
                    isWin = isLong ? closePrice > trade.entryPrice : closePrice < trade.entryPrice;
                    isMaker = false;
                    reason = 'EXPIRED';
                }

                if (closePrice) {
                    // === РАСЧЕТ PNL (Точь-в-точь как в боте) ===
                    const direction = isLong ? 1 : -1;
                    const rawPnl = (closePrice - trade.entryPrice) * trade.quantity * direction;
                    
                    // Комиссия на выход
                    const exitVal = closePrice * trade.quantity;
                    const exitFeeRate = isMaker ? FEES.maker : FEES.taker;
                    const exitFee = exitVal * exitFeeRate;

                    const netPnl = rawPnl - exitFee;

                    // Обновляем баланс
                    currentBalance += netPnl;
                    totalPnL += netPnl;
                    totalFeesPaid += exitFee;
                    totalTrades++;

                    if (netPnl > 0) wins++; else losses++;

                    console.log(`   ${netPnl > 0 ? '✅' : '❌'} ${trade.action} Closed [${reason}]. PnL: $${netPnl.toFixed(2)} (Fee: $${(trade.entryFeePaid + exitFee).toFixed(2)}) Bal: $${currentBalance.toFixed(2)}`);
                    activeTrade = null;
                }
                continue; // Не входим в новую сделку на той же свече
            }

            // === B. АНАЛИЗ И ВХОД ===
            const signal = analyzer.analyze(symbol, slice);

            if (signal.action !== 'NO_TRADE') {
                // === ЛОГИКА ENTRY CALCULATOR (Синхронизация) ===
                
                // 1. Расчет риска в долларах
                const riskAmountUsd = currentBalance * (signal.riskPct / 100);
                
                // 2. Дистанция до стопа в %
                const distToSl = Math.abs(signal.entryPrice - signal.sl);
                const slPct = distToSl / signal.entryPrice;

                // 3. Расчет размера позиции
                let positionSizeUsd = riskAmountUsd / slPct;

                // 4. Применение лимитов (как в конфиге)
                positionSizeUsd = Math.min(positionSizeUsd, POSITION_CFG.maxPositionSizeUsd);
                positionSizeUsd = Math.min(positionSizeUsd, currentBalance * POSITION_CFG.leverage);

                // Фильтр слишком мелких позиций
                if (positionSizeUsd < 10) continue;

                const quantity = positionSizeUsd / signal.entryPrice;

                // === СИМУЛЯЦИЯ ИСПОЛЬНЕНИЯ ВХОДА (ИСПРАВЛЕНО) ===
                let entryFilled = false;
                let realEntryPrice = signal.entryPrice;
                let isMakerEntry = false;

                if (signal.entryType === 'market') {
                    // Market order: исполняется сразу по цене закрытия текущей свечи
                    realEntryPrice = currentBar.c;
                    entryFilled = true;
                    isMakerEntry = false; // Taker fee
                } else {
                    // Limit order: исполняется, если текущая свеча пересекла уровень лимитки
                    const hit = signal.action === 'LONG' 
                        ? currentBar.l <= signal.entryPrice  // Для лонга цена опустилась до лимита
                        : currentBar.h >= signal.entryPrice; // Для шорта цена поднялась до лимита

                    if (hit) {
                        realEntryPrice = signal.entryPrice; // Исполняем точно по лимиту
                        entryFilled = true;
                        isMakerEntry = true; // Maker fee
                    }
                }

                if (!entryFilled) {
                    // Лимитка не сработала на этой свече — пропускаем вход
                    continue;
                }

                // Считаем комиссию на вход
                const entryVal = realEntryPrice * quantity;
                const entryFeeRate = isMakerEntry ? FEES.maker : FEES.taker;
                const entryFee = entryVal * entryFeeRate;

                // Списываем комиссию сразу
                currentBalance -= entryFee;
                totalFeesPaid += entryFee;

                const ts = new Date(currentBar.ts);
                const formatted = `${ts.getDate().toString().padStart(2, '0')} ${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}`;

                console.log(`⚡ SIGNAL [${formatted}]: ${signal.action} @ ${realEntryPrice.toFixed(4)} (Size: $${positionSizeUsd.toFixed(0)})`);

                activeTrade = {
                    symbol,
                    action: signal.action,
                    entryPrice: realEntryPrice,
                    quantity,
                    positionSizeUsd,
                    tp: signal.tp,
                    sl: signal.sl,
                    ts: currentBar.ts,
                    entryFeePaid: entryFee,
                    tags: signal.reasonTags
                };
            }
        }
    }

    console.log('\n=======================================');
    console.log(`🏁 RESULT: ${wins}W / ${losses}L (${totalTrades} Trades)`);
    console.log(`📊 Winrate: ${(totalTrades > 0 ? (wins / totalTrades * 100) : 0).toFixed(2)}%`);
    console.log(`💰 Net PnL: $${(currentBalance - INITIAL_BALANCE).toFixed(2)}`);
    console.log(`💸 Fees Paid: $${totalFeesPaid.toFixed(2)}`);
    console.log(`📉 Max Drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);
    console.log(`🏦 FINAL Balance: $${currentBalance.toFixed(2)} (Start: $${INITIAL_BALANCE}, x${(currentBalance / INITIAL_BALANCE).toFixed(2)})`);
    console.log('=======================================');

    await DatabaseModule.close();
}

runAdvancedBacktest();