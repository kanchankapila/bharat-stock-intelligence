import { describe, expect, it, vi } from 'vitest';

/**
 * AF-20261026-71: the fundamental overlay scored MISSING data as BAD data, and `null < 0.5` is true
 * in JS, so a missing debt_to_equity earned the +2 "low debt" bonus (335 live names vs 108 with a real
 * low D/E). Points now come from present fields only, rescaled to 0-12; no present field -> null,
 * which unified_ranker imputes at the median. Measured neutral before shipping (measurement.md).
 */

vi.mock('../dbAsync', () => ({ dbGet: vi.fn(), dbAll: vi.fn(async () => []), dbTransaction: vi.fn() }));
vi.mock('../dbBulk', () => ({ rowGroups: () => '', bulkUpsert: vi.fn() }));
vi.mock('../pythonRunner', () => ({ runPython: vi.fn() }));

import { scoreStock } from '../confluenceEngine';

const data = { symbol: 'ABC', screenerIds: [], screenerNames: [], screenerClasses: [] };
// SIDEWAYS (the default when no regime is set in this process) weights fund 1.1, capped at 12.
const w = (pts: number) => Math.min(12, Math.round(pts * 1.1 * 100) / 100);
const fund = (f: any) => scoreStock(data, null, null, f, null).fundScore;

describe('confluence fundamental overlay with missing fields', () => {
  it('a missing debt_to_equity earns no low-debt bonus', () => {
    expect(fund({ piotroski_f_score: 3, return_on_equity: null, debt_to_equity: null, revenue_growth: 0 })).toBe(0);
  });

  it('scores present fields only, rescaled to 0-12', () => {
    // piotroski 8 -> 4 of 4 possible; nothing else present -> 12.
    expect(fund({ piotroski_f_score: 8, return_on_equity: null, debt_to_equity: null, revenue_growth: null }))
      .toBeCloseTo(w(12), 5);
  });

  it('no fundamentals at all is unknown (null), not the worst score', () => {
    expect(fund(null)).toBeNull();
    expect(fund({ piotroski_f_score: null, return_on_equity: null, debt_to_equity: null, revenue_growth: null })).toBeNull();
  });

  it('a complete row scores exactly as before', () => {
    expect(fund({ piotroski_f_score: 7, return_on_equity: 0.25, debt_to_equity: 0.2, revenue_growth: 0.2 }))
      .toBeCloseTo(w(12), 5);
    expect(fund({ piotroski_f_score: 5, return_on_equity: 0.15, debt_to_equity: 0.9, revenue_growth: 0.1 }))
      .toBeCloseTo(w(4), 5);
  });
});
