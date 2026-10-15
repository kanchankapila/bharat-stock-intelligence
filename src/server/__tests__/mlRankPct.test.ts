import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
const { cacheDel } = await import('../cacheService');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');
const { invalidateUrLatestAt } = await import('../routers/commandCenter.router');
const caller = createCallerFactory(appRouter)({} as any);

// AF-20261008-45: win_probability is a rank, not a probability. mlRankPct is its percentile
// among the latest COMPLETE day's scored technical_signals rows (100 = highest).
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function seed() {
  await dbExec('DELETE FROM technical_signals');
  const complete: [string, number | null][] = [['RK_A', 0.9], ['RK_B', 0.5], ['RK_C', 0.5], ['RK_D', 0.1], ['RK_E', null]];
  for (const [s, wp] of complete) {
    await dbRun(`INSERT INTO technical_signals (symbol, date, win_probability, cmp, signal_score) VALUES (?, ?, ?, 100, 5)`, [s, day(1), wp]);
  }
  for (let i = 0; i < 8; i++) {
    await dbRun(`INSERT INTO technical_signals (symbol, date) VALUES (?, ?)`, [`RK_FILL${i}`, day(1)]);
  }
  // a newer PARTIAL day: must not move the ranks
  await dbRun(`INSERT INTO technical_signals (symbol, date, win_probability, cmp) VALUES ('RK_A', ?, 0.01, 100)`, [day(0)]);
  await dbRun(`INSERT INTO technical_signals (symbol, date, win_probability, cmp) VALUES ('RK_Z', ?, 0.99, 100)`, [day(0)]);
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
    await dbExec('DELETE FROM unified_recommendations');
    invalidateUrLatestAt();
    for (const s of Object.keys(EXPECTED)) {
      await dbRun(`INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level, classification)
        VALUES (?, '2026-08-03T00:00:00.000Z', 'BULL', 90, 'S_ELITE', 'Buy')`, [s]);
    }
    const { picks } = await caller.getBuyRecommendations({ conviction: 'ALL' });
    for (const [s, want] of Object.entries(EXPECTED)) {
      expect((picks.find((p: any) => p.symbol === s) as any).mlRankPct, s).toBe(want);
    }
    expect((picks.find((p: any) => p.symbol === 'RK_A') as any).win_probability).toBeCloseTo(0.9);
    expect(((await caller.getUnifiedScoreForSymbol({ symbol: 'RK_C' })) as any).mlRankPct).toBe(33.3);
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
