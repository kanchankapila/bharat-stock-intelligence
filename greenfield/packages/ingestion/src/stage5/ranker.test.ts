// Task 5.1.1 Verify. Pure-logic tests, no DB -- ranker.ts takes no I/O
// dependency so every rule can be pinned directly.
import { expect, test } from 'vitest';
import {
  buildRankerSpec, classifyByPercentile, NULL_RANKER_FACTOR, percentileRank, RANKER_VARIANT_NULL,
  RANKER_VARIANT_WEIGHTED, rankSession, selectSurvivingFactors, type NetTStatRow, type RankerSpec,
} from './ranker.js';

// --- selectSurvivingFactors ---

test('selectSurvivingFactors: zero rows clear the bar -> empty (this panel\'s actual Task 5.0 result)', () => {
  const rows: NetTStatRow[] = [
    { factor: 'delivery_pct', rebalanceDays: 5, netTStat: 0.03 },
    { factor: 'delivery_pct', rebalanceDays: 21, netTStat: -0.06 },
    { factor: 'pb_pct_rank_252d', rebalanceDays: 21, netTStat: -2.7 },
    { factor: 'momentum_63d', rebalanceDays: 21, netTStat: null },
  ];
  expect(selectSurvivingFactors(rows, 3.08)).toEqual([]);
});

test('selectSurvivingFactors: a factor clearing the bar at only one horizon survives with that horizon\'s stats', () => {
  const rows: NetTStatRow[] = [
    { factor: 'div_yield_ttm', rebalanceDays: 5, netTStat: 1.2 },
    { factor: 'div_yield_ttm', rebalanceDays: 21, netTStat: 3.9 },
  ];
  const survivors = selectSurvivingFactors(rows, 3.08);
  expect(survivors).toHaveLength(1);
  expect(survivors[0]).toMatchObject({ factor: 'div_yield_ttm', rebalanceDays: 21, netTStat: 3.9, weight: 3.9, direction: 1 });
});

test('selectSurvivingFactors: a significantly NEGATIVE t-stat survives with direction -1, not excluded for its sign', () => {
  const rows: NetTStatRow[] = [{ factor: 'fii_net_21d', rebalanceDays: 21, netTStat: -4.5 }];
  const survivors = selectSurvivingFactors(rows, 3.08);
  expect(survivors[0]).toMatchObject({ direction: -1, weight: 4.5 });
});

test('selectSurvivingFactors: clears at BOTH horizons -> keeps the stronger |t|, does not double-count the factor', () => {
  const rows: NetTStatRow[] = [
    { factor: 'momentum_63d', rebalanceDays: 5, netTStat: 3.2 },
    { factor: 'momentum_63d', rebalanceDays: 21, netTStat: 5.1 },
  ];
  const survivors = selectSurvivingFactors(rows, 3.08);
  expect(survivors).toHaveLength(1);
  expect(survivors[0]).toMatchObject({ rebalanceDays: 21, netTStat: 5.1, weight: 5.1 });
});

test('selectSurvivingFactors: NaN/non-finite t-stat is treated as not-cleared, not as beating any threshold', () => {
  const rows: NetTStatRow[] = [{ factor: 'eps_ttm', rebalanceDays: 21, netTStat: NaN }];
  expect(selectSurvivingFactors(rows, 3.08)).toEqual([]);
});

// --- buildRankerSpec ---

test('buildRankerSpec: zero survivors -> deterministic null ranker on momentum_63d, explicitly unvalidated', () => {
  const spec = buildRankerSpec([]);
  expect(spec.variant).toBe(RANKER_VARIANT_NULL);
  expect(spec.unvalidated).toBe(true);
  expect(spec.factors).toHaveLength(1);
  expect(spec.factors[0]!.factor).toBe(NULL_RANKER_FACTOR);
  expect(spec.rationale).toMatch(/NO demonstrated edge/);
});

test('buildRankerSpec: with survivors -> weighted variant, NOT flagged unvalidated', () => {
  const spec = buildRankerSpec([{ factor: 'div_yield_ttm', rebalanceDays: 21, netTStat: 3.9, weight: 3.9, direction: 1 }]);
  expect(spec.variant).toBe(RANKER_VARIANT_WEIGHTED);
  expect(spec.unvalidated).toBe(false);
  expect(spec.version).toContain('div_yield_ttm');
});

// --- percentileRank ---

test('percentileRank: strictly increasing values span [0,1] evenly', () => {
  expect(percentileRank([1, 2, 3, 4, 5])).toEqual([0, 0.25, 0.5, 0.75, 1]);
});

test('percentileRank: null and NaN are excluded from the ranking, not coerced into a rank -- the float(x or 0) bug class', () => {
  const out = percentileRank([10, null, 20, NaN, 30]);
  expect(out[1]).toBeNull();
  expect(out[3]).toBeNull();
  expect(out[0]).toBe(0); // 10 is the lowest of the 3 finite values
  expect(out[2]).toBe(0.5);
  expect(out[4]).toBe(1);
});

test('percentileRank: tied values share the midpoint rank, not an arbitrary tiebreak', () => {
  // three values, the middle two tied: ranks 0,1,1,3 over 3 gaps -> tie gets (1+2)/2/3
  const out = percentileRank([1, 5, 5, 9]);
  expect(out[0]).toBe(0);
  expect(out[1]).toBeCloseTo((1 + 2) / 2 / 3, 10);
  expect(out[2]).toBeCloseTo((1 + 2) / 2 / 3, 10);
  expect(out[3]).toBe(1);
});

test('percentileRank: a single finite value sits at the midpoint (no spread to divide by zero over)', () => {
  expect(percentileRank([null, 42, null])).toEqual([null, 0.5, null]);
});

test('percentileRank: all-null/all-NaN input returns all null, never a fabricated 0.5 for every symbol', () => {
  expect(percentileRank([null, NaN, null])).toEqual([null, null, null]);
});

// --- classifyByPercentile ---

test('classifyByPercentile: boundary values land in the documented buckets', () => {
  expect(classifyByPercentile(1.0)).toBe('rank_top_decile');
  expect(classifyByPercentile(0.9)).toBe('rank_top_decile');
  expect(classifyByPercentile(0.89)).toBe('rank_upper');
  expect(classifyByPercentile(0.5)).toBe('rank_middle');
  expect(classifyByPercentile(0.11)).toBe('rank_lower');
  // Symmetric with the top boundary (>=0.9 is top): <=0.1 falls to bottom.
  expect(classifyByPercentile(0.1)).toBe('rank_bottom_decile');
  expect(classifyByPercentile(0.05)).toBe('rank_bottom_decile');
  expect(classifyByPercentile(0.0)).toBe('rank_bottom_decile');
});

// --- rankSession ---

const nullSpec: RankerSpec = buildRankerSpec([]);
const weightedSpec: RankerSpec = buildRankerSpec([
  { factor: 'div_yield_ttm', rebalanceDays: 21, netTStat: 3.9, weight: 3.9, direction: 1 },
  { factor: 'fii_net_21d', rebalanceDays: 21, netTStat: -4.5, weight: 4.5, direction: -1 },
]);

test('rankSession: a symbol with NO usable factor value is dropped, never scored as if it were 0', () => {
  const rows = [
    { symbol: 'AAA', values: { momentum_63d: 0.1 }, factsCutoff: '2026-08-01T10:00:00Z' },
    { symbol: 'BBB', values: { momentum_63d: null }, factsCutoff: '2026-08-01T10:00:00Z' },
  ];
  const ranked = rankSession(nullSpec, rows);
  expect(ranked.map((r) => r.symbol)).toEqual(['AAA']);
});

test('rankSession: higher raw factor value ranks higher for a positive-direction factor', () => {
  const rows = [
    { symbol: 'LOW', values: { momentum_63d: 1 }, factsCutoff: '2026-08-01T10:00:00Z' },
    { symbol: 'MID', values: { momentum_63d: 5 }, factsCutoff: '2026-08-01T10:00:00Z' },
    { symbol: 'HIGH', values: { momentum_63d: 9 }, factsCutoff: '2026-08-01T10:00:00Z' },
  ];
  const ranked = rankSession(nullSpec, rows);
  expect(ranked.map((r) => r.symbol)).toEqual(['HIGH', 'MID', 'LOW']);
  expect(ranked[0]!.rank).toBe(1);
});

test('rankSession: a significantly NEGATIVE factor is oriented so LOWER raw value ranks higher', () => {
  const rows = [
    { symbol: 'HIGH_FII', values: { fii_net_21d: 9, div_yield_ttm: null }, factsCutoff: '2026-08-01T10:00:00Z' },
    { symbol: 'LOW_FII', values: { fii_net_21d: 1, div_yield_ttm: null }, factsCutoff: '2026-08-01T10:00:00Z' },
  ];
  const ranked = rankSession(weightedSpec, rows);
  // fii_net_21d survived with direction -1: lower fii_net_21d should score HIGHER.
  expect(ranked.map((r) => r.symbol)).toEqual(['LOW_FII', 'HIGH_FII']);
});

test('rankSession: a symbol missing ONE of several factors is scored on what it has, not penalised toward the bottom for the gap', () => {
  const rows = [
    // Only has div_yield_ttm, but at the top of that factor's distribution.
    { symbol: 'PARTIAL', values: { div_yield_ttm: 100, fii_net_21d: null }, factsCutoff: '2026-08-01T10:00:00Z' },
    // Has both, but low on both.
    { symbol: 'FULL_LOW', values: { div_yield_ttm: 1, fii_net_21d: 100 }, factsCutoff: '2026-08-01T10:00:00Z' },
  ];
  const ranked = rankSession(weightedSpec, rows);
  const partial = ranked.find((r) => r.symbol === 'PARTIAL')!;
  expect(partial.engineCoverage).toBe(1);
  // Renormalised by weight actually used: scoring 100th-percentile on its one
  // factor should not be dragged toward 0 by the factor it doesn't have.
  expect(partial.score).toBeGreaterThan(0.9);
});

test('rankSession: identical input produces an identical ranking on re-run (deterministic, symbol tiebreak on exact score ties)', () => {
  const rows = [
    { symbol: 'ZEBRA', values: { momentum_63d: 5 }, factsCutoff: '2026-08-01T10:00:00Z' },
    { symbol: 'ALPHA', values: { momentum_63d: 5 }, factsCutoff: '2026-08-01T10:00:00Z' },
  ];
  const first = rankSession(nullSpec, rows);
  const second = rankSession(nullSpec, rows);
  expect(first).toEqual(second);
  expect(first.map((r) => r.symbol)).toEqual(['ALPHA', 'ZEBRA']); // tie broken alphabetically
});

test('rankSession: null-ranker output is never assigned a conviction level; weighted output is', () => {
  const rows = [
    { symbol: 'A', values: { momentum_63d: 1 }, factsCutoff: '2026-08-01T10:00:00Z' },
    { symbol: 'B', values: { div_yield_ttm: 50, fii_net_21d: null }, factsCutoff: '2026-08-01T10:00:00Z' },
  ];
  expect(rankSession(nullSpec, rows).every((r) => r.conviction === null)).toBe(true);
  expect(rankSession(weightedSpec, rows).every((r) => r.conviction !== null)).toBe(true);
});

test('rankSession: breakdown carries the unvalidated flag through unchanged from the spec', () => {
  const rows = [{ symbol: 'A', values: { momentum_63d: 1 }, factsCutoff: '2026-08-01T10:00:00Z' }];
  const ranked = rankSession(nullSpec, rows);
  expect(ranked[0]!.breakdown).toMatchObject({ unvalidated: true, rankerVariant: RANKER_VARIANT_NULL });
});
