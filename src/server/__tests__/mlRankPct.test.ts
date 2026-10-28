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

  it('stock detail uses the complete feature grid instead of a newer partial row', async () => {
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM unified_recommendations');
      await tx.run(`INSERT INTO unified_recommendations
        (symbol, computed_at, regime, unified_score, conviction_level, classification)
        VALUES (?, '2026-10-27', 'BULL', 75, 'A_HIGH', 'Buy')`, ['RK_A']);
      await tx.run('UPDATE technical_signals SET fcf_yield_approx = ?, interest_coverage = ? WHERE symbol = ? AND date = ?',
        [3.5, 20, 'RK_A', day(1)]);
    });
    invalidateUrLatestAt();
    const detail: any = await caller.getUnifiedScoreForSymbol({ symbol: 'RK_A' });
    expect.soft(detail).toMatchObject({ feature_as_of: day(1), fcf_yield: 3.5, interest_coverage: 20, win_probability: 0.9 });
    const predictions: any = await caller.getTechnicalPredictions({ symbol: 'RK_A' });
    expect.soft(predictions).toMatchObject({ date: day(1), fcf_yield_approx: 3.5, interest_coverage: 20, win_probability: 0.9 });
  });

  it('getTradeDecisionCockpitData carries mlRankPct beside an unchanged winProbSource', async () => {
    await cacheDel('misc:trade-decision-cockpit');
    const res: any = await caller.getTradeDecisionCockpitData();
    const bySym = new Map(res.data.candidates.map((c: any) => [c.symbol, c]));
    for (const [s, want] of Object.entries(EXPECTED)) expect((bySym.get(s) as any)?.mlRankPct, s).toBe(want);
    expect((bySym.get('RK_A') as any).winProbSource).toBe('raw');
    expect((bySym.get('RK_A') as any).mlProbability).toBe(90);
    expect((bySym.get('RK_E') as any).winProbSource).toBe('heuristic');
    expect((bySym.get('RK_E') as any).mlProbability).toBeNull();
    expect((bySym.get('RK_E') as any).researchScore).toEqual(expect.any(Number));
    expect(res.data.marketOverview.avgWinProbability).toBeNull();
    await cacheDel('misc:trade-decision-cockpit');
  });

  it('getTradeDecisionCockpitData reports news sentiment and smart money as unknown, not as a fabricated 0', async () => {
    // AF-20261026-49: the news read selected a `symbol` column news_sentiment_items has never had
    // (it stores symbols_json), so it failed every call into a bare catch, and smart money was
    // hard-coded. Both reached the user as 0.00 / Rs 0 cr -- a reading, not an absence. They carry
    // a constant weight in the composite either way, so reporting them as null changes no score.
    await cacheDel('misc:trade-decision-cockpit');
    const res: any = await caller.getTradeDecisionCockpitData();
    const a = res.data.candidates.find((c: any) => c.symbol === 'RK_A');
    expect(a.newsSentiment).toBeNull();
    expect(a.smartMoneyCr).toBeNull();
    await cacheDel('misc:trade-decision-cockpit');
  });

  it('withholds invalid long geometry while retaining a valid fallback plan', async () => {
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM unified_signals WHERE symbol IN (?, ?, ?, ?)', ['RK_A', 'RK_B', 'RK_C', 'RK_D']);
      await tx.run('UPDATE technical_signals SET sma50 = ? WHERE symbol = ? AND date = ?', [120, 'RK_A', day(1)]);
      await tx.run('UPDATE technical_signals SET sma50 = ? WHERE symbol = ? AND date = ?', [90, 'RK_B', day(1)]);
      await tx.run(`INSERT INTO unified_signals
        (symbol, signal_source, signal_type, entry_price, stop_loss, target_price, confidence_score, signal_generated_at)
        VALUES (?, 'screener', 'BUY', 100, 105, 110, 90, now()), (?, 'screener', 'BUY', 100, 90, 110, 90, now())`,
      ['RK_C', 'RK_D']);
    });
    await cacheDel('misc:trade-decision-cockpit');
    const res: any = await caller.getTradeDecisionCockpitData();
    const a = res.data.candidates.find((c: any) => c.symbol === 'RK_A');
    const b = res.data.candidates.find((c: any) => c.symbol === 'RK_B');
    const c = res.data.candidates.find((c: any) => c.symbol === 'RK_C');
    const d = res.data.candidates.find((c: any) => c.symbol === 'RK_D');
    expect.soft(a).toMatchObject({ entryPrice: null, stopLoss: null, targetPrice: null });
    expect(b).toMatchObject({ entryPrice: 100, stopLoss: 95, targetPrice: 110 });
    expect.soft(c).toMatchObject({ entryPrice: null, stopLoss: null, targetPrice: null });
    expect(d).toMatchObject({ entryPrice: 100, stopLoss: 90, targetPrice: 110 });
    await cacheDel('misc:trade-decision-cockpit');
  });

  it('does not report a model-threshold ratio as market advance/decline breadth', async () => {
    await cacheDel('misc:trade-decision-cockpit');
    const res: any = await caller.getTradeDecisionCockpitData();
    expect(res.data.marketOverview.advDecRatio).toBeNull();
    expect(res.data.marketOverview.modelThresholdRatio).toBeNull();
    expect(res.data.marketOverview.researchThresholdRatio).toEqual(expect.any(Number));
    await cacheDel('misc:trade-decision-cockpit');
  });

  it('uses the canonical call and abstains from the unvalidated cockpit trade switch', async () => {
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM unified_recommendations');
      await tx.run(`INSERT INTO unified_recommendations
        (symbol, computed_at, regime, unified_score, conviction_level, classification)
        VALUES (?, '2026-10-27', 'BULL', 55, 'D_MARGINAL', 'Hold'),
               (?, '2026-10-27', 'BULL', 75, 'A_HIGH', 'Buy')`, ['RK_A', 'RK_B']);
      await tx.run('UPDATE technical_signals SET calibrated_win_probability = ? WHERE date = ? AND cmp > 0', [0.9, day(1)]);
    });
    invalidateUrLatestAt();
    await cacheDel('misc:trade-decision-cockpit');
    const res: any = await caller.getTradeDecisionCockpitData();
    const bySymbol = new Map(res.data.candidates.map((c: any) => [c.symbol, c]));
    expect.soft((bySymbol.get('RK_A') as any).actionAdvice).toBe('HOLD');
    expect.soft((bySymbol.get('RK_B') as any).actionAdvice).toBe('BUY');
    expect.soft((bySymbol.get('RK_C') as any).actionAdvice).toBe('WATCH');
    expect.soft(res.data.marketOverview.verdict).toBe('NO TRADE');
    expect.soft((bySymbol.get('RK_A') as any).techSignalCount).toBeNull();
    expect.soft((bySymbol.get('RK_A') as any).quantRank).toBeNull();
    expect((bySymbol.get('RK_A') as any).factors).toMatchObject({ technical: null, fundamental: null, momentum: null });
    await cacheDel('misc:trade-decision-cockpit');
  });

  it('counts a real signal list and leaves a malformed list unknown', async () => {
    await dbTransaction(async tx => {
      await tx.run('UPDATE technical_signals SET signals_json = ? WHERE symbol = ? AND date = ?',
        [JSON.stringify([{ type: 'A' }, { type: 'B' }]), 'RK_A', day(1)]);
      await tx.run('UPDATE technical_signals SET signals_json = ? WHERE symbol = ? AND date = ?',
        ['not-json', 'RK_B', day(1)]);
    });
    await cacheDel('misc:trade-decision-cockpit');
    const res: any = await caller.getTradeDecisionCockpitData();
    expect(res.data.candidates.find((c: any) => c.symbol === 'RK_A').techSignalCount).toBe(2);
    expect(res.data.candidates.find((c: any) => c.symbol === 'RK_B').techSignalCount).toBeNull();
    await cacheDel('misc:trade-decision-cockpit');
  });

  it('the per-stock and confluence readers carry it too', async () => {
    expect(((await caller.getTechnicalPredictions({ symbol: 'RK_B' })) as any).mlRankPct).toBe(33.3);
    const rows = await caller.getTechnicalConfluenceSignals({ date: day(1), minUnified: 0, minConfluence: 0 });
    for (const [s, want] of Object.entries(EXPECTED)) expect(rows.find((r: any) => r.symbol === s)?.mlRankPct, s).toBe(want);
  });
});
