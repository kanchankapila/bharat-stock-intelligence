import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

type Bar = { date: string; close: number; volume: number };
type WorkerResult = {
  computed: Array<Record<string, number | string | null>>;
  valuationPct: number[];
};

function runWorker(
  eligible: Array<[string, Bar[]]>,
  fundMap: Record<string, Record<string, number | null>> = {},
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../quantScoringWorker.ts', import.meta.url), {
      workerData: {
        eligible,
        screenerMap: {},
        fundMap,
        techMap: {},
        riskFreeAnnual: 0.065,
      },
      // Mirror quantScoringService.runQuantWorker exactly: the fresh worker thread does not
      // inherit the parent's tsx ESM loader hook, so the worker's .ts sources (and its
      // './riskFreeRate.ts' import) fail to load without re-registering it here.
      execArgv: [...process.execArgv, '--import', 'tsx/esm'],
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`quant scoring worker exited ${code}`));
    });
  });
}

function barsFromReturns(returns: number[]): Bar[] {
  const closes = [100];
  for (const r of returns) closes.push(closes.at(-1)! * (1 + r));
  return closes.map((close, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    close,
    volume: 1_000,
  }));
}

/**40 steadily-drifting bars — clears annualizedMetrics' 30-bar floor so risk fields are
 *  computed (not null) and every symbol in a fixture shares an identical price path. */
function steadyBars(n = 40): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    close: 100 + i,
    volume: 1_000,
  }));
}

describe('quant scoring worker math', () => {
  it('uses sample variance for annualized volatility', async () => {
    const returns = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 0.02 : -0.004));
    const result = await runWorker([['VOL', barsFromReturns(returns)]]);
    const row = result.computed[0];
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const sampleVariance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0)
      / (returns.length - 1);
    const populationVariance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0)
      / returns.length;

    expect(row.annualized_vol).toBeCloseTo(Math.sqrt(sampleVariance) * Math.sqrt(252) * 100, 10);
    expect(row.annualized_vol).not.toBeCloseTo(Math.sqrt(populationVariance) * Math.sqrt(252) * 100, 10);
  });

  it('measures an N-session return from t-N and leaves short 12m history null', async () => {
    const full = Array.from({ length: 253 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      close: 100 + i,
      volume: 1_000,
    }));
    const short = full.slice(1); // 252 bars cannot define a 252-session return.
    const result = await runWorker([['FULL', full], ['SHORT', short]]);
    const fullRow = result.computed.find(row => row.symbol === 'FULL')!;
    const shortRow = result.computed.find(row => row.symbol === 'SHORT')!;

    expect(fullRow.return_1w).toBeCloseTo(((352 - 347) / 347) * 100, 12);
    expect(fullRow.return_12m).toBeCloseTo(((352 - 100) / 100) * 100, 12);
    expect(shortRow.return_12m).toBeNull();
  });

  it('ranks a present-but-invalid P/E worst and a missing P/E neutral', async () => {
    // AF-20261011-12: three symbols sharing an identical price path, differing only in P/E.
    // The value blend is 0.25*peRank + (0.35 ROE + 0.20 D/E + 0.20 revGr), all three
    // co-factors missing for every name -> neutral 50 each, so the blend is exactly
    // 0.25*peRank + 37.5: LOSS 37.5, NOPE 50, GOOD 62.5 -> second-pass ranks 0 / 50 / 100.
    const bars = steadyBars();
    const result = await runWorker(
      [['LOSS', bars], ['NOPE', bars], ['GOOD', bars]],
      {
        LOSS: { trailing_pe: -5 },
        NOPE: { trailing_pe: null },
        GOOD: { trailing_pe: 15 },
      },
    );
    const at = (sym: string) => result.computed.findIndex(row => row.symbol === sym);

    expect(result.valuationPct[at('LOSS')]).toBe(0);    // present but undefined -> worst
    expect(result.valuationPct[at('NOPE')]).toBe(50);   // absent data -> neutral, not -0
    expect(result.valuationPct[at('GOOD')]).toBe(100);  // the only valid reading -> best
  });

  it('treats a zero P/E as known-bad, not a falsy miss', async () => {
    // The pre-fix gate `v && v > 0 && v < 200` dropped v = 0 via falsiness -> null -> rank 50,
    // i.e. a defined-but-worthless reading ranked identically to no reading at all.
    const bars = steadyBars();
    const result = await runWorker(
      [['ZERO', bars], ['GOOD2', bars]],
      {
        ZERO: { trailing_pe: 0 },
        GOOD2: { trailing_pe: 20 },
      },
    );
    const at = (sym: string) => result.computed.findIndex(row => row.symbol === sym);

    expect(result.valuationPct[at('ZERO')]).toBe(0);
    expect(result.valuationPct[at('GOOD2')]).toBe(100);
  });
});
