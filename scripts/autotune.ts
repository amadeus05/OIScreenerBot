import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest, BacktestResult } from './backtest-runner';
import { DEFAULT_CONFIG, ModuleWeights, SignalAnalyzerConfig } from '../src/domain/signal-analyzer/types/config';

interface CandidateConfig {
    weights: ModuleWeights;
    decision: {
        threshold: number;
        noTradeZone: number;
    };
    position: {
        baseRiskPct: number;
        leverage: number;
    };
}

interface ScoredRun {
    id: string;
    cfg: CandidateConfig;
    result: BacktestResult;
    score: number;
}

const OUT_DIR = path.resolve(process.cwd(), 'backtest-results');

function randomInRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function sampleWeights(): ModuleWeights {
    // Orderflow / momentum / meanReversion / oi get most of the mass, others small.
    const raw = {
        orderflow: randomInRange(0.2, 0.55),
        momentum: randomInRange(0.15, 0.45),
        meanReversion: randomInRange(0.1, 0.45),
        oi: randomInRange(0.05, 0.35),
        liquidations: randomInRange(0, 0.1),
        levels: randomInRange(0, 0.1),
    };
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

function sampleCandidate(): CandidateConfig {
    return {
        weights: sampleWeights(),
        decision: {
            threshold: randomInRange(0.25, 0.6),
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
        decision: { ...DEFAULT_CONFIG.decision, ...override.decision },
        position: { ...DEFAULT_CONFIG.position, ...override.position },
        lookbacks: { ...DEFAULT_CONFIG.lookbacks },
        levels: { ...DEFAULT_CONFIG.levels },
        safety: { ...DEFAULT_CONFIG.safety },
        technical: { ...DEFAULT_CONFIG.technical },
        fees: { ...DEFAULT_CONFIG.fees },
    };
}

function scoreMetrics(res: BacktestResult): number {
    const m = res.metrics;
    if (m.trades === 0) return -1;
    const winrateScore = m.winrate / 100; // 0..1
    const ddPenalty = m.maxDrawdown > 0 ? Math.min(m.maxDrawdown / 100, 2) : 0;
    const expectancyScore = Math.tanh(m.expectancy / 5); // dampen extremes
    const tradeBonus = Math.min(m.trades, 200) / 200 * 0.2;
    return winrateScore * 0.6 + expectancyScore * 0.3 + tradeBonus - ddPenalty * 0.2;
}

async function main() {
    const iterations = Number(process.env.ITERATIONS || 8);
    const maxSymbols = Number(process.env.MAX_SYMBOLS || 12);

    const runs: ScoredRun[] = [];

    for (let i = 0; i < iterations; i++) {
        const cfg = sampleCandidate();
        const configOverride = buildConfig(cfg);
        const id = `run_${i + 1}`;

        console.log(`\n🔁 Iteration ${i + 1}/${iterations}`);
        console.log(`   threshold=${cfg.decision.threshold.toFixed(2)}, noTradeZone=${cfg.decision.noTradeZone.toFixed(2)}, risk=${cfg.position.baseRiskPct.toFixed(2)}%, lev=${cfg.position.leverage}x`);

        const result = await runBacktest({
            configOverride,
            maxSymbols,
            initialBalance: 100,
            silent: true,
            maxTrades: 400,
        });

        const score = scoreMetrics(result);
        runs.push({ id, cfg, result, score });

        const m = result.metrics;
        console.log(`   trades=${m.trades} winrate=${m.winrate.toFixed(2)}% pnl=${m.netPnl.toFixed(2)} dd=${m.maxDrawdown.toFixed(2)} score=${score.toFixed(3)}`);
    }

    runs.sort((a, b) => b.score - a.score);
    const best = runs[0];

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, `autotune-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
        best: {
            id: best.id,
            score: best.score,
            metrics: best.result.metrics,
            cfg: best.cfg,
        },
        top3: runs.slice(0, 3).map(r => ({
            id: r.id,
            score: r.score,
            metrics: r.result.metrics,
            cfg: r.cfg,
        })),
    }, null, 2));

    console.log('\n🥇 Лучший конфиг:', best.id, 'score=', best.score.toFixed(3));
    console.log('   trades=', best.result.metrics.trades, 'winrate=', best.result.metrics.winrate.toFixed(2), 'pnl=', best.result.metrics.netPnl.toFixed(2));
    console.log('   saved to', outPath);
}

main().catch(err => {
    console.error('Autotune failed', err);
    process.exit(1);
});

