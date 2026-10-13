import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

type Bar = { date: string; close: number; volume: number };
type WorkerResult = {
  computed: Array<Record<string, number | string | null>>;
};

function runWorker(eligible: Array<[string, Bar[]]>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../quantScoringWorker.ts', import.meta.url), {
      workerData: {
        eligible,
        screenerMap: {},
        fundMap: {},
        techMap: {},
        riskFreeAnnual: 0.065,
      },
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
});
