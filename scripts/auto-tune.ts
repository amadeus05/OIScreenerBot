import 'reflect-metadata';
import { BacktestMetrics, runBacktest } from './backtest-runner';
import { SignalAnalyzerConfig } from '../src/domain/signal-analyzer';

type PartialConfig = Partial<SignalAnalyzerConfig>;

interface TrialResult {
    score: number;
    metrics: BacktestMetrics;
    config: PartialConfig;
}

const TRIALS = Number(process.env.TRIALS ?? 50); // Делаем больше прогонов
const START_TS = process.env.START_TS ? Number(process.env.START_TS) : undefined;
const END_TS = process.env.END_TS ? Number(process.env.END_TS) : undefined;
const MAX_SYMBOLS = process.env.MAX_SYMBOLS ? Number(process.env.MAX_SYMBOLS) : 40;
const INITIAL_BALANCE = 100;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const pick = <T>(arr: T[]): T => arr[randInt(0, arr.length - 1)];

// 1. Веса оптимизируем (это мозг бота)
function sampleWeights(): SignalAnalyzerConfig['weights'] {
    // Даем приоритет Orderflow и Momentum, как в успешных тестах
    const orderflow = rand(0.3, 0.6);
    const meanReversion = rand(0.1, 0.3); // Меньше веса на разворот
    const momentum = rand(0.2, 0.5);
    
    // Liquidations иногда полезны
    const liquidations = Math.random() > 0.5 ? rand(0.05, 0.15) : 0;

    const sum = orderflow + meanReversion + momentum + liquidations;
    return {
        orderflow: Number((orderflow / sum).toFixed(2)),
        meanReversion: Number((meanReversion / sum).toFixed(2)),
        momentum: Number((momentum / sum).toFixed(2)),
        liquidations: Number((liquidations / sum).toFixed(2)),
        levels: 0, // Уровни пока отключаем (упрощение)
        oi: 0,
    };
}

function sampleConfig(): PartialConfig {
    // Генерируем SL (танковый или средний)
    const slMin = rand(1.5, 2.5); 
    const slMax = slMin + rand(0.5, 1.5);

    // Генерируем TP. 
    // Важно: TP1 должен быть достижимым (0.7 - 1.2 R), TP2 для "ракет"
    const tp1Ratio = rand(0.7, 1.2);
    const tp2Ratio = rand(2.0, 4.0);

    return {
        weights: sampleWeights(),
        decision: {
            // Ищем баланс между фильтрацией шума и входами
            threshold: Number(rand(0.35, 0.55).toFixed(2)), 
            noTradeZone: 0.05,
        },
        position: {
            // 🛑 ЗАМОРОЖЕНО: Риск и Плечо фиксированы!
            // Мы ищем лучшую логику, а не кто больше рискнет.
            baseRiskPct: 1.0, 
            maxOpenTrades: 1, // Тестируем в режиме "Снайпер" (1 сделка) для чистоты
            minConfidence: Number(rand(0.50, 0.75).toFixed(2)),
            defaultPortfolioSize: INITIAL_BALANCE,
            maxPositionSizeUsd: INITIAL_BALANCE * 3,
            leverage: 3, 
        },
        technical: {
            // 🛑 ЗАМОРОЖЕНО: Стандартные периоды
            atrPeriod: 14,
            emaFastPeriod: 8,
            emaSlowPeriod: 21,
            
            entryOffsetAtrMult: 0, // Вход по рынку
            
            // ОПТИМИЗИРУЕТСЯ: Стопы и Тейки
            slAtrMultMin: Number(slMin.toFixed(2)),
            slAtrMultMax: Number(slMax.toFixed(2)),
            slStructuralBars: randInt(5, 12),
            
            tpRatios: [
                Number(tp1Ratio.toFixed(2)), 
                Number(tp2Ratio.toFixed(2))
            ],
        },
        // Остальное можно не менять или взять дефолт
        levels: { 
            swingWindow: 5, maxLevels: 10, swingToleranceAtr: 0.3, clusterThresholdAtr: 0.6,
            decayRatePerBar: 0.005, minStrengthToKeep: 0.15, minTouchesForConfirmed: 2,
            touchProximityAtr: 0.4, maxTouchHistory: 20, breakoutConfirmBars: 1, breakoutVolumeRatio: 1.5, priorVolBars: 5 
        }
    };
}

// Умная оценка: Нам нужен стабильный рост, а не "казино"
function scoreMetrics(m: BacktestMetrics): number {
    // 1. Профит Фактор (грубый аналог): Сколько заработали / Макс просадка
    // Добавляем 1 к DD, чтобы не делить на ноль
    const calmarLike = m.netPnl / (Math.abs(m.maxDrawdown) + 1);

    // 2. Штраф за малый винрейт (хотим > 40%)
    let wrScore = 0;
    if (m.winrate < 40) wrScore -= 20;
    if (m.winrate > 50) wrScore += 10;

    // 3. Штраф за малое кол-во сделок (статистическая значимость)
    if (m.trades < 10) return -1000; 

    // Итоговый скор: Прибыль с учетом риска + Бонус за Винрейт
    return (m.netPnl * 2) - (m.maxDrawdown * 4) + wrScore;
}

async function main() {
    console.log(`🚀 Smart Autotune start | trials=${TRIALS}`);

    const leaderboard: TrialResult[] = [];

    for (let i = 0; i < TRIALS; i++) {
        const cfg = sampleConfig();
        const res = await runBacktest({
            configOverride: cfg,
            startTs: START_TS,
            endTs: END_TS,
            maxSymbols: MAX_SYMBOLS,
            initialBalance: INITIAL_BALANCE,
            skipWarmup: false,
            silent: true,
            maxTrades: undefined, // Берем из конфига (там 1)
        });

        const score = scoreMetrics(res.metrics);
        
        // Сохраняем только прибыльные
        if (res.metrics.netPnl > 0) {
            leaderboard.push({ score, metrics: res.metrics, config: cfg });
            leaderboard.sort((a, b) => b.score - a.score);
            if (leaderboard.length > 5) leaderboard.length = 5;
        }

        const bestScore = leaderboard.length > 0 ? leaderboard[0].score.toFixed(2) : 'N/A';
        const bestPnl = leaderboard.length > 0 ? leaderboard[0].metrics.netPnl.toFixed(2) : '0';

        if (i % 5 === 0) { // Логируем каждые 5 прогонов
             console.log(`[${i + 1}/${TRIALS}] Curr: PnL ${res.metrics.netPnl.toFixed(2)}% | Best: PnL ${bestPnl}% (Score ${bestScore})`);
        }
    }

    console.log('\n🏆 WINNING CONFIGURATIONS 🏆');
    leaderboard.forEach((r, idx) => {
        console.log(`\n#${idx + 1} SCORE: ${r.score.toFixed(2)} | PnL: ${r.metrics.netPnl.toFixed(2)}% | WR: ${r.metrics.winrate.toFixed(1)}% | DD: ${r.metrics.maxDrawdown.toFixed(2)}% | Trades: ${r.metrics.trades}`);
        console.log('Key Params:');
        console.log(`  Threshold: ${r.config.decision?.threshold}`);
        console.log(`  Weights: OF=${r.config.weights?.orderflow}, Mom=${r.config.weights?.momentum}, MR=${r.config.weights?.meanReversion}`);
        console.log(`  SL: ${r.config.technical?.slAtrMultMin} - ${r.config.technical?.slAtrMultMax} ATR`);
        console.log(`  TP: ${r.config.technical?.tpRatios?.join(', ')}`);
    });
}

main().catch(err => {
    console.error('Autotune failed', err);
    process.exit(1);
});