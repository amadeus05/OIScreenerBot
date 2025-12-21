import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest, BacktestResult, BacktestMetrics } from './backtest-runner';
import { DEFAULT_CONFIG, ModuleWeights, SignalAnalyzerConfig, MarketRegimeKey } from '../src/domain/signal-analyzer/types/config';
import { DatabaseModule, AppDataSource } from '../src/infrastructure/database/database.module';
import { HistoryCandle } from '../src/domain/entities/history-candle.entity';

interface CandidateConfig {
    weights: ModuleWeights;
    regimeWeights: Partial<Record<MarketRegimeKey, ModuleWeights>>;
    decision: { threshold: number; noTradeZone: number; };
    position: { baseRiskPct: number; leverage: number; };
}

interface FoldEval {
    fold: number;
    metrics: BacktestMetrics;
    score: number;
}

interface ScoredRun {
    id: string;
    cfg: CandidateConfig;
    score: number;
    penalty: number;
    aggregated: BacktestMetrics;
    folds: FoldEval[];
}

const OUT_DIR = path.resolve(process.cwd(), 'backtest-results');
const INITIAL_BALANCE = Number(process.env.INIT_BALANCE || 100);
const REDUCTION = Number(process.env.REDUCTION || 3);

const BUDGETS = [
    { name: 'fast', maxSymbols: Number(process.env.B1_SYMBOLS || 6), maxTrades: Number(process.env.B1_TRADES || 120), folds: Number(process.env.B1_FOLDS || 2) },
    { name: 'mid', maxSymbols: Number(process.env.B2_SYMBOLS || 12), maxTrades: Number(process.env.B2_TRADES || 250), folds: Number(process.env.B2_FOLDS || 3) },
    { name: 'full', maxSymbols: Number(process.env.B3_SYMBOLS || 18), maxTrades: Number(process.env.B3_TRADES || 400), folds: Number(process.env.B3_FOLDS || 4) },
];

interface UniverseInfo {
    symbols: string[];
    minTs: number;
    maxTs: number;
}

function randomInRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function sampleArray<T>(arr: T[], n: number): T[] {
    if (n >= arr.length) return [...arr];
    const copy = [...arr];
    const out: T[] = [];
    while (out.length < n && copy.length) {
        const idx = Math.floor(Math.random() * copy.length);
        out.push(copy[idx]);
        copy.splice(idx, 1);
    }
    return out;
}

function sampleWeights(): ModuleWeights {
    const raw = {
        orderflow: randomInRange(0.2, 0.55),
        momentum: randomInRange(0.15, 0.45),
        meanReversion: randomInRange(0.1, 0.45),
        oi: randomInRange(0.05, 0.35),
        liquidations: randomInRange(0, 0.1),
        levels: randomInRange(0, 0.1),
    } as Record<string, number>;
    const sum = Object.values(raw).reduce((s, v) => s + v, 0);
    const norm = (v: number) => v / sum;
    return {
        orderflow: norm(raw.orderflow),
        momentum: norm(raw.momentum),
        meanReversion: norm(raw.meanReversion),
        oi: norm(raw.oi),
        liquidations: norm(raw.liquidations),
        levels: norm(raw.levels),
    };
}

function sampleRegimeWeights(): Partial<Record<MarketRegimeKey, ModuleWeights>> {
    return {
        TRENDING: sampleWeights(),
        RANGING: sampleWeights(),
        VOLATILE: sampleWeights(),
        EXTREME: sampleWeights(),
    };
}

function sampleCandidate(): CandidateConfig {
    return {
        weights: sampleWeights(),
        regimeWeights: sampleRegimeWeights(),
        decision: {
            threshold: randomInRange(0.25, 0.65),
            noTradeZone: randomInRange(0.0, 0.08),
        },
        position: {
            baseRiskPct: randomInRange(0.3, 1.8),
            leverage: Math.round(randomInRange(1, 5)),
        },
    };
}

function buildConfig(override: CandidateConfig): SignalAnalyzerConfig {
    return {
        ...DEFAULT_CONFIG,
        weights: override.weights,
        regimeWeights: override.regimeWeights,
        decision: { ...DEFAULT_CONFIG.decision, ...override.decision },
        position: { ...DEFAULT_CONFIG.position, ...override.position },
        lookbacks: { ...DEFAULT_CONFIG.lookbacks },
        levels: { ...DEFAULT_CONFIG.levels },
        safety: { ...DEFAULT_CONFIG.safety },
        technical: { ...DEFAULT_CONFIG.technical },
        fees: { ...DEFAULT_CONFIG.fees },
    };
}

function scoreBase(m: BacktestMetrics): number {
    if (m.trades === 0) return -1;
    const winrateScore = m.winrate / 100;
    const ddPenalty = m.maxDrawdown > 0 ? Math.min(m.maxDrawdown / 100, 2) : 0;
    const expectancyScore = Math.tanh(m.expectancy / 5);
    const tradeBonus = Math.min(m.trades, 200) / 200 * 0.2;
    return winrateScore * 0.6 + expectancyScore * 0.3 + tradeBonus - ddPenalty * 0.2;
}

function aggregateMetrics(folds: BacktestMetrics[]): BacktestMetrics {
    const n = Math.max(folds.length, 1);
    const sum = (key: keyof BacktestMetrics) => folds.reduce((s, f) => s + (f[key] as number), 0);
    const mean = (key: keyof BacktestMetrics) => sum(key) / n;
    return {
        trades: sum('trades'),
        wins: sum('wins'),
        losses: sum('losses'),
        winrate: mean('winrate'),
        finalBalance: mean('finalBalance'),
        netPnl: mean('netPnl'),
        maxDrawdown: mean('maxDrawdown'),
        expectancy: mean('expectancy'),
        avgR: undefined,
        pnlByRegime: {},
    };
}

function std(values: number[]): number {
    if (!values.length) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
}

function buildTimeFolds(k: number, minTs: number, maxTs: number): { start: number; end: number; }[] {
    if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || maxTs <= minTs) return [];
    const span = maxTs - minTs;
    const step = span / k;
    const folds = [] as { start: number; end: number; }[];
    for (let i = 0; i < k; i++) {
        const start = Math.floor(minTs + step * i);
        const end = Math.floor(i === k - 1 ? maxTs : minTs + step * (i + 1));
        folds.push({ start, end });
    }
    return folds;
}

async function getUniverse(): Promise<UniverseInfo> {
    await DatabaseModule.initialize();
    const repo = AppDataSource.getRepository(HistoryCandle);

    const rawSymbols = await repo.createQueryBuilder('c').select('DISTINCT(c.symbol)', 'symbol').getRawMany();
    const symbols = rawSymbols.map((r: any) => r.symbol as string);

    const bounds = await repo.createQueryBuilder('h')
        .select('MIN(h.ts)', 'minTs')
        .addSelect('MAX(h.ts)', 'maxTs')
        .getRawOne();

    await DatabaseModule.close();

    return {
        symbols,
        minTs: Number(bounds?.minTs || 0),
        maxTs: Number(bounds?.maxTs || 0),
    };
}

async function evaluateCandidate(
    id: string,
    cfg: CandidateConfig,
    budget: { name: string; maxSymbols: number; maxTrades: number; folds: number; },
    folds: { start: number; end: number; }[],
    universe: UniverseInfo
): Promise<ScoredRun> {
    const usedFolds = folds.slice(0, budget.folds);
    const results: FoldEval[] = [];
    const configOverride = buildConfig(cfg);

    for (let i = 0; i < usedFolds.length; i++) {
        const fold = usedFolds[i];
        const symbols = sampleArray(universe.symbols, Math.min(budget.maxSymbols, universe.symbols.length));
        const res: BacktestResult = await runBacktest({
            configOverride,
            symbols,
            maxSymbols: symbols.length,
            startTs: fold.start,
            endTs: fold.end,
            maxTrades: budget.maxTrades,
            initialBalance: INITIAL_BALANCE,
            silent: true,
        });
        const score = scoreBase(res.metrics);
        results.push({ fold: i, metrics: res.metrics, score });
    }

    const aggregated = aggregateMetrics(results.map(r => r.metrics));
    const baseScore = scoreBase(aggregated);

    const winStd = std(results.map(r => r.metrics.winrate));
    const pnlStd = std(results.map(r => r.metrics.netPnl));
    const instabilityPenalty = (winStd / 100) * 0.4 + Math.min(Math.abs(pnlStd) / Math.max(INITIAL_BALANCE, 1), 2) * 0.3;
    const score = baseScore - instabilityPenalty;

    return {
        id,
        cfg,
        score,
        penalty: instabilityPenalty,
        aggregated,
        folds: results,
    };
}

async function runAsha(initialPopulation: number): Promise<ScoredRun[]> {
    const universe = await getUniverse();
    const maxFolds = Math.max(...BUDGETS.map(b => b.folds));
    const folds = buildTimeFolds(maxFolds, universe.minTs, universe.maxTs);

    let population = Array.from({ length: initialPopulation }, (_, i) => ({ id: `c${i + 1}`, cfg: sampleCandidate() }));
    let survivors: ScoredRun[] = [];

    for (let r = 0; r < BUDGETS.length; r++) {
        const budget = BUDGETS[r];
        console.log(`\n[Rung ${r + 1}/${BUDGETS.length}] ${budget.name} | symbols=${budget.maxSymbols}, trades=${budget.maxTrades}, folds=${budget.folds}`);

        const rungResults: ScoredRun[] = [];
        for (const cand of population) {
            const res = await evaluateCandidate(cand.id, cand.cfg, budget, folds, universe);
            rungResults.push(res);
            console.log(`   ${cand.id} score=${res.score.toFixed(3)} base=${scoreBase(res.aggregated).toFixed(3)} penalty=${res.penalty.toFixed(3)} trades=${res.aggregated.trades} winrate=${res.aggregated.winrate.toFixed(2)} dd=${res.aggregated.maxDrawdown.toFixed(2)}`);
        }

        rungResults.sort((a, b) => b.score - a.score);

        if (r < BUDGETS.length - 1) {
            const keep = Math.max(1, Math.ceil(rungResults.length / REDUCTION));
            population = rungResults.slice(0, keep).map(r => ({ id: r.id, cfg: r.cfg }));
            survivors = rungResults.slice(0, keep);
        } else {
            survivors = rungResults;
        }
    }

    return survivors;
}

async function main() {
    const initialPopulation = Number(process.env.ITERATIONS || 12);

    const finalRung = await runAsha(initialPopulation);
    finalRung.sort((a, b) => b.score - a.score);

    const best = finalRung[0];
    const top3 = finalRung.slice(0, 3);

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, `autotune-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ best, top3 }, null, 2));

    console.log('\n🥇 Лучший конфиг:', best.id, 'score=', best.score.toFixed(3));
    console.log('   trades=', best.aggregated.trades, 'winrate=', best.aggregated.winrate.toFixed(2), 'pnl=', best.aggregated.netPnl.toFixed(2), 'penalty=', best.penalty.toFixed(3));
    console.log('   saved to', outPath);
}

main().catch(err => {
    console.error('Autotune failed', err);
    process.exit(1);
});
