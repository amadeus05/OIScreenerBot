import 'reflect-metadata';
import { BacktestMetrics, runBacktest } from './backtest-runner';
import { SignalAnalyzerConfig } from '../src/domain/signal-analyzer';

type PartialConfig = Partial<SignalAnalyzerConfig>;

interface TrialResult {
    score: number;
    metrics: BacktestMetrics;
    config: PartialConfig;
}

const TRIALS = Number(process.env.TRIALS ?? 20);
const START_TS = process.env.START_TS ? Number(process.env.START_TS) : undefined;
const END_TS = process.env.END_TS ? Number(process.env.END_TS) : undefined;
const MAX_SYMBOLS = process.env.MAX_SYMBOLS ? Number(process.env.MAX_SYMBOLS) : 25;
const INITIAL_BALANCE = process.env.INIT_BALANCE ? Number(process.env.INIT_BALANCE) : 100;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const pick = <T>(arr: T[]): T => arr[randInt(0, arr.length - 1)];

function sampleWeights(): SignalAnalyzerConfig['weights'] {
    const orderflow = rand(0.3, 0.6);
    const meanReversion = rand(0.15, 0.4);
    const momentum = rand(0.15, 0.35);
    const sum = orderflow + meanReversion + momentum;
    return {
        orderflow: Number((orderflow / sum).toFixed(4)),
        meanReversion: Number((meanReversion / sum).toFixed(4)),
        momentum: Number((momentum / sum).toFixed(4)),
        liquidations: 0,
        levels: 0,
        oi: 0,
    };
}

function sampleConfig(): PartialConfig {
    const emaFast = randInt(5, 12);
    const emaSlow = randInt(Math.max(emaFast + 6, 18), 34);
    const slMin = rand(1.4, 2.4);
    const slMax = Math.max(slMin + 0.5, rand(slMin + 0.4, 4.0));

    return {
        weights: sampleWeights(),
        decision: {
            threshold: Number(rand(0.3, 0.65).toFixed(3)),
            noTradeZone: Number(rand(0.0, 0.12).toFixed(3)),
        },
        position: {
            baseRiskPct: Number(rand(0.25, 1.5).toFixed(3)),
            maxOpenTrades: randInt(1, 4),
            minConfidence: Number(rand(0.55, 0.8).toFixed(3)),
            defaultPortfolioSize: 100, // базовая сумма для расчета если баланс не передан
            maxPositionSizeUsd: randInt(100, 600),
            leverage: Number(rand(2, 6).toFixed(2)),
        },
        levels: {
            swingWindow: randInt(3, 9),
            maxLevels: randInt(6, 14),
            swingToleranceAtr: Number(rand(0.2, 0.5).toFixed(3)),
            clusterThresholdAtr: Number(rand(0.4, 0.9).toFixed(3)),
            decayRatePerBar: Number(rand(0.003, 0.015).toFixed(4)),
            minStrengthToKeep: Number(rand(0.1, 0.2).toFixed(3)),
            minTouchesForConfirmed: randInt(1, 3),
            touchProximityAtr: Number(rand(0.25, 0.55).toFixed(3)),
            maxTouchHistory: randInt(10, 24),
            breakoutConfirmBars: randInt(1, 3),
            breakoutVolumeRatio: Number(rand(1.2, 2.5).toFixed(3)),
            priorVolBars: randInt(3, 8),
        },
        technical: {
            atrPeriod: randInt(10, 20),
            emaFastPeriod: emaFast,
            emaSlowPeriod: emaSlow,
            entryOffsetAtrMult: Number(rand(0, 0.3).toFixed(3)),
            slAtrMultMin: Number(slMin.toFixed(3)),
            slAtrMultMax: Number(slMax.toFixed(3)),
            slStructuralBars: randInt(5, 14),
            tpRatios: pick([
                [1.3, 2.2],
                [1.5, 3.0],
                [2.0, 3.5],
            ]),
        },
    };
}

function scoreMetrics(m: BacktestMetrics): number {
    const pnl = m.netPnl;
    const ddPenalty = 0.7 * Math.max(m.maxDrawdown, 0);
    const wrPenalty = m.trades >= 5 && m.winrate < 40 ? (40 - m.winrate) * 0.2 : 0;
    const tradePenalty = m.trades < 3 ? 5 : 0;
    return pnl - ddPenalty - wrPenalty - tradePenalty;
}

async function main() {
    console.log(`🚀 Autotune start | trials=${TRIALS} | maxSymbols=${MAX_SYMBOLS} | start=${START_TS ?? 'none'} | end=${END_TS ?? 'none'}`);

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
            maxTrades: undefined,
        });

        const score = scoreMetrics(res.metrics);
        leaderboard.push({ score, metrics: res.metrics, config: cfg });
        leaderboard.sort((a, b) => b.score - a.score);
        if (leaderboard.length > 5) leaderboard.length = 5;

        const best = leaderboard[0];
        console.log(
            `[${i + 1}/${TRIALS}] score=${score.toFixed(2)} pnl=${res.metrics.netPnl.toFixed(2)} wr=${res.metrics.winrate.toFixed(1)}% dd=${res.metrics.maxDrawdown.toFixed(2)} trades=${res.metrics.trades} | best=${best.score.toFixed(2)}`
        );
    }

    console.log('🥇 Top configs:');
    leaderboard.forEach((r, idx) => {
        console.log(`\n#${idx + 1} score=${r.score.toFixed(2)} pnl=${r.metrics.netPnl.toFixed(2)} wr=${r.metrics.winrate.toFixed(1)}% dd=${r.metrics.maxDrawdown.toFixed(2)} trades=${r.metrics.trades}`);
        console.dir(r.config, { depth: null });
    });
}

main().catch(err => {
    console.error('Autotune failed', err);
    process.exit(1);
});

