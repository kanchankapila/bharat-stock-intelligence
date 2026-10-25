import { beforeEach, describe, expect, it } from 'vitest';

if (!process.env.VITEST_PG_SCHEMA) throw new Error('mlRankPct fixtures require a private VITEST_PG_SCHEMA');
const { dbTransaction } = await import('../dbAsync');
const { cacheDel } = await import('../cacheService');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');
const { invalidateUrLatestAt } = await import('../routers/commandCenter.router');
const caller = createCallerFactory(appRouter)({} as any);

// AF-20261008-45: win_probability is a rank, not a probability. mlRankPct is its percentile
// among the latest COMPLETE day's scored technical_signals rows (100 = highest).
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function seed() {
  const complete: [string, number | null][] = [['RK_A', 0.9], ['RK_B', 0.5], ['RK_C', 0.5], ['RK_D', 0.1], ['RK_E', null]];
  const completeDay = day(1), partialDay = day(0);
  const fillers = Array.from({ length: 8 }, (_, i) => [`RK_FILL${i}`, completeDay]);
  // a newer PARTIAL day: must not move the ranks
  const partial: [string, number][] = [['RK_A', 0.01], ['RK_Z', 0.99]];
  const values = [
    ...complete.map(() => '(?, ?, ?, 100, 5)'),
    ...fillers.map(() => '(?, ?, DEFAULT, DEFAULT, DEFAULT)'),
    ...partial.map(() => '(?, ?, ?, 100, DEFAULT)'),
  ];
  const params = [...complete.flatMap(([s, wp]) => [s, completeDay, wp]), ...fillers.flat(), ...partial.flatMap(([s, wp]) => [s, partialDay, wp])];
  await dbTransaction(async tx => {
    await tx.run('DELETE FROM technical_signals');
    await tx.run(`INSERT INTO technical_signals (symbol, date, win_probability, cmp, signal_score) VALUES ${values.join(', ')}`, params);
  });
}

const EXPECTED: Record<string, number | null> = { RK_A: 100, RK_B: 33.3, RK_C: 33.3, RK_D: 0, RK_E: null };

describe('mlRankPct', () => {
  beforeEach(seed);

  it('ranks within the latest complete day only: order, ties, NULL', async () => {
    const { mlRankPctFor } = await import('../technicalSignalsDate');
    for (const [s, want] of Object.entries(EXPECTED)) expect(await mlRankPctFor(s), s).toBe(want);
    expect(await mlRankPctFor('RK_Z')).toBeNull();
  });

  it('getBuyRecommendations carries mlRankPct and keeps win_probability unchanged', async () => {
    const symbols = Object.keys(EXPECTED);
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM unified_recommendations');
      await tx.run(`INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level, classification)
        VALUES ${symbols.map(() => "(?, '2026-08-03T00:00:00.000Z', 'BULL', 90, 'S_ELITE', 'Buy')").join(', ')}`, symbols);
    });
    invalidateUrLatestAt();
    const { picks } = await caller.getBuyRecommendations({ conviction: 'ALL' });
    for (const [s, want] of Object.entries(EXPECTED)) {
      expect((picks.find((p: any) => p.symbol === s) as any).mlRankPct, s).toBe(want);
    }
    expect((picks.find((p: any) => p.symbol === 'RK_A') as any).win_probability).toBeCloseTo(0.9);
    const detail = await caller.getUnifiedScoreForSymbol({ symbol: 'RK_C' }) as any;
    expect(detail.mlRankPct).toBe(33.3);
    expect(detail).toHaveProperty('generated_at'); // session label is not the production timestamp
  });

  it('getTradeDecisionCockpitData carries mlRankPct beside an unchanged winProbSource', async () => {
    await cacheDel('misc:trade-decision-cockpit');
    const res: any = await caller.getTradeDecisionCockpitData();
    const bySym = new Map(res.data.candidates.map((c: any) => [c.symbol, c]));
    for (const [s, want] of Object.entries(EXPECTED)) expect((bySym.get(s) as any)?.mlRankPct, s).toBe(want);
    expect((bySym.get('RK_A') as any).winProbSource).toBe('raw');
    expect((bySym.get('RK_A') as any).mlProbability).toBe(90);
    await cacheDel('misc:trade-decision-cockpit');
  });

  it('the per-stock and confluence readers carry it too', async () => {
    expect(((await caller.getTechnicalPredictions({ symbol: 'RK_B' })) as any).mlRankPct).toBe(33.3);
    const rows = await caller.getTechnicalConfluenceSignals({ date: day(1), minUnified: 0, minConfluence: 0 });
    for (const [s, want] of Object.entries(EXPECTED)) expect(rows.find((r: any) => r.symbol === s)?.mlRankPct, s).toBe(want);
  });
});
