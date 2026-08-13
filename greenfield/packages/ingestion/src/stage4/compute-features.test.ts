import { describe, expect, it } from 'vitest';
import {
  buildAsOfIndex, computeFeaturePanel, latestAsOf, sessionCloseUtc, ttmEpsAsOf,
} from './compute-features.js';
import type { FundamentalAsOfPoint, MarketBarFeatureRow } from '@greenfield/db';

function bar(symbol: string, sessionDate: string, close: number, opts: Partial<MarketBarFeatureRow> = {}): MarketBarFeatureRow {
  return {
    symbol, sessionDate, close, isSuspect: false,
    momentum21d: null, momentum63d: null, adt252d: null, deliveryPct: null, deliveryPctMa20: null,
    ...opts,
  };
}

function fact(symbol: string, availableAt: string, periodEnd: string, value: number): FundamentalAsOfPoint {
  return { symbol, availableAt, periodEnd, value };
}

describe('sessionCloseUtc', () => {
  it('maps a session date to 15:30 IST (10:00 UTC)', () => {
    expect(sessionCloseUtc('2026-06-30')).toBe('2026-06-30T10:00:00.000Z');
  });
});

describe('buildAsOfIndex / latestAsOf', () => {
  it('returns the latest point with availableAt <= cutoff, per symbol', () => {
    const idx = buildAsOfIndex([
      fact('RELIANCE', '2025-01-01T00:00:00Z', '2024-12-31', 10),
      fact('RELIANCE', '2025-06-01T00:00:00Z', '2025-03-31', 20),
      fact('RELIANCE', '2026-01-01T00:00:00Z', '2025-12-31', 30),
    ]);
    expect(latestAsOf(idx.get('RELIANCE'), '2025-01-01T00:00:00Z')?.value).toBe(10);
    expect(latestAsOf(idx.get('RELIANCE'), '2025-12-31T00:00:00Z')?.value).toBe(20);
    expect(latestAsOf(idx.get('RELIANCE'), '2026-06-01T00:00:00Z')?.value).toBe(30);
  });

  it('negative control: never returns a point with availableAt AFTER cutoff (no lookahead)', () => {
    const idx = buildAsOfIndex([fact('X', '2026-06-01T00:00:00Z', '2026-03-31', 99)]);
    expect(latestAsOf(idx.get('X'), '2026-05-31T00:00:00Z')).toBeNull();
  });

  it('returns null for an unknown symbol or empty history', () => {
    const idx = buildAsOfIndex([]);
    expect(latestAsOf(idx.get('NOPE'), '2026-01-01T00:00:00Z')).toBeNull();
  });
});

describe('ttmEpsAsOf', () => {
  it('sums the last 4 distinct quarters known as of cutoff', () => {
    const idx = buildAsOfIndex([
      fact('X', '2025-01-01T00:00:00Z', '2024-12-31', 1),
      fact('X', '2025-04-01T00:00:00Z', '2025-03-31', 2),
      fact('X', '2025-07-01T00:00:00Z', '2025-06-30', 3),
      fact('X', '2025-10-01T00:00:00Z', '2025-09-30', 4),
      fact('X', '2026-01-01T00:00:00Z', '2025-12-31', 5),
    ]);
    // As of just before the 5th quarter's available_at -- only 4 known -> sums Q1..Q4
    expect(ttmEpsAsOf(idx.get('X'), '2025-12-31T00:00:00Z')).toBe(1 + 2 + 3 + 4);
    // As of after the 5th -- rolls to the latest 4 (Q2..Q5)
    expect(ttmEpsAsOf(idx.get('X'), '2026-01-01T00:00:00Z')).toBe(2 + 3 + 4 + 5);
  });

  it('negative control: returns null (not a fabricated partial sum) with fewer than 4 known quarters', () => {
    const idx = buildAsOfIndex([fact('X', '2025-01-01T00:00:00Z', '2024-12-31', 1)]);
    expect(ttmEpsAsOf(idx.get('X'), '2026-01-01T00:00:00Z')).toBeNull();
  });

  it('a restated quarter (two facts, same period_end, different available_at) resolves to the later value', () => {
    const idx = buildAsOfIndex([
      fact('X', '2025-01-01T00:00:00Z', '2024-12-31', 1),
      fact('X', '2025-04-01T00:00:00Z', '2025-03-31', 2),
      fact('X', '2025-07-01T00:00:00Z', '2025-06-30', 3),
      fact('X', '2025-10-01T00:00:00Z', '2025-09-30', 4),
      fact('X', '2025-11-01T00:00:00Z', '2025-09-30', 40), // restatement of the same quarter
    ]);
    expect(ttmEpsAsOf(idx.get('X'), '2025-11-01T00:00:00Z')).toBe(1 + 2 + 3 + 40);
  });
});

describe('computeFeaturePanel', () => {
  it('produces momentum/delivery straight from the market-bar panel and computes coverage as the non-null fraction', () => {
    const panel = [bar('A', '2026-01-05', 100, { momentum21d: 0.1, momentum63d: 0.2, deliveryPct: 50, deliveryPctMa20: 45, adt252d: 2_00_00_000 })];
    const rows = computeFeaturePanel(panel, [], [], [], [], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values.momentum_21d).toBe(0.1);
    expect(rows[0]?.values.delivery_pct).toBe(50);
    // No fundamental/flow/breadth data supplied -> only 4 of 12 metrics non-null.
    expect(rows[0]?.coverage).toBeCloseTo(4 / 12);
  });

  it('facts_cutoff is always <= session close, and only fundamentals known by then are used (negative control: a future fact is invisible)', () => {
    const panel = [bar('A', '2026-01-05', 100, { adt252d: 2_00_00_000 })];
    const pe = [fact('A', '2026-06-01T00:00:00Z', '2026-03-31', 99)]; // available AFTER the session date
    const rows = computeFeaturePanel(panel, pe, [], [], [], [], []);
    expect(rows[0]?.values.pe_pct_rank_252d).toBeNull(); // the only PE point isn't visible yet
    expect(rows[0]?.factsCutoff).toBe(sessionCloseUtc('2026-01-05'));
  });

  it('cross-sectional PE rank only considers liquid (ADT >= floor) peers, per session date', () => {
    const panel = [
      bar('LIQUID_LOW', '2026-01-05', 100, { adt252d: 2_00_00_000 }),
      bar('LIQUID_HIGH', '2026-01-05', 100, { adt252d: 2_00_00_000 }),
      bar('ILLIQUID', '2026-01-05', 100, { adt252d: 1 }), // below the Rs 1cr floor
    ];
    const pe = [
      fact('LIQUID_LOW', '2025-01-01T00:00:00Z', '2024-12-31', 5),
      fact('LIQUID_HIGH', '2025-01-01T00:00:00Z', '2024-12-31', 50),
      fact('ILLIQUID', '2025-01-01T00:00:00Z', '2024-12-31', 1_000_000), // would blow up the ranking if wrongly included
    ];
    const rows = computeFeaturePanel(panel, pe, [], [], [], [], []);
    const byName = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    // Only two liquid peers -> LIQUID_LOW is the minimum (rank 0), LIQUID_HIGH is above it.
    expect(byName.LIQUID_LOW?.values.pe_pct_rank_252d).toBe(0);
    expect(byName.LIQUID_HIGH?.values.pe_pct_rank_252d).toBeGreaterThan(0);
    // The illiquid peer's own extreme PE is still ranked (against the liquid distribution),
    // but does not distort LIQUID_HIGH/LOW's ranks -- proving it was excluded from the peer set.
    expect(byName.LIQUID_HIGH?.values.pe_pct_rank_252d).toBeLessThan(1);
  });

  it('batch (full multi-date panel) and on-demand (panel sliced to one date) produce identical values for that date -- Task 4.2 Verify', () => {
    const fullPanel = [
      bar('A', '2026-01-05', 100, { momentum21d: 0.1, adt252d: 2_00_00_000 }),
      bar('B', '2026-01-05', 200, { momentum21d: 0.2, adt252d: 2_00_00_000 }),
      bar('A', '2026-01-06', 101, { momentum21d: 0.11, adt252d: 2_00_00_000 }),
    ];
    const pe = [
      fact('A', '2025-01-01T00:00:00Z', '2024-12-31', 15),
      fact('B', '2025-01-01T00:00:00Z', '2024-12-31', 25),
    ];
    const batchRows = computeFeaturePanel(fullPanel, pe, [], [], [], [], []);
    const onDemandPanel = fullPanel.filter((r) => r.sessionDate === '2026-01-05');
    const onDemandRows = computeFeaturePanel(onDemandPanel, pe, [], [], [], [], []);

    const batchForDate = batchRows.filter((r) => r.sessionDate === '2026-01-05').sort((a, b) => a.symbol.localeCompare(b.symbol));
    const onDemandForDate = onDemandRows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(onDemandForDate).toEqual(batchForDate);
  });
});
