import { describe, expect, it, vi } from 'vitest';

/**
 * C-01 (2026-10-08 audit): confluence's "sector" slot is quant.momentum_score/100*8 -- the
 * stock's OWN momentum (corr 1.000 live), no sector input. The score is an EVIDENCE item and is
 * left unchanged; only the reasoning text, which claimed "strong sector momentum", is pinned here.
 */

vi.mock('../dbAsync', () => ({ dbGet: vi.fn(), dbAll: vi.fn(async () => []), dbTransaction: vi.fn() }));
vi.mock('../dbBulk', () => ({ rowGroups: () => '', bulkUpsert: vi.fn() }));
vi.mock('../pythonRunner', () => ({ runPython: vi.fn() }));

import { scoreStock } from '../confluenceEngine';

describe('confluence sector slot label', () => {
  const data = { symbol: 'ABC', screenerIds: [], screenerNames: [], screenerClasses: [] };
  const quant = { momentum_score: 95, above_sma200: 0, sma200_distance_pct: 0, rank_composite: 0 };

  it('does not claim sector strength for what is the stock own momentum', () => {
    const r = scoreStock(data, null, quant, null, null);
    expect(r.sectorScore).toBeGreaterThan(5); // the branch that used to emit the sector claim
    expect(r.reasoning).not.toMatch(/sector/i);
    expect(r.reasoning).toMatch(/strong own price momentum/);
  });

  it('leaves the slot value unchanged (score change is an EVIDENCE item)', () => {
    const r = scoreStock(data, null, quant, null, null);
    expect(r.sectorScore).toBeCloseTo(95 / 100 * 8 * 0.9, 5); // SIDEWAYS default regime weight
  });
});
