import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRow: { current: Record<string, any> | undefined } = { current: undefined };
vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => mockRow.current),
  dbRun: vi.fn(async () => {}),
  dbExec: vi.fn(async () => {}),
}));

import { DATA_QUALITY_CHECKS, daysStale, safeRatio, runDataQualityChecks } from '../dataQualityChecks';

describe('daysStale', () => {
  const now = new Date('2026-07-19T12:00:00Z');

  it('returns null for missing/empty values', () => {
    expect(daysStale(null, now)).toBeNull();
    expect(daysStale(undefined, now)).toBeNull();
    expect(daysStale('', now)).toBeNull();
  });

  it('returns null for an unparseable date', () => {
    expect(daysStale('not-a-date', now)).toBeNull();
  });

  it('computes fractional days for a date string', () => {
    expect(daysStale('2026-07-17T12:00:00Z', now)).toBeCloseTo(2, 5);
  });

  it('accepts a Date instance directly', () => {
    expect(daysStale(new Date('2026-07-18T12:00:00Z'), now)).toBeCloseTo(1, 5);
  });
});

describe('safeRatio', () => {
  it('divides normally', () => {
    expect(safeRatio(3, 12)).toBeCloseTo(0.25, 6);
  });

  it('returns 0 for a zero or missing denominator instead of throwing/NaN', () => {
    expect(safeRatio(5, 0)).toBe(0);
    expect(safeRatio(5, undefined)).toBe(0);
    expect(safeRatio(5, null)).toBe(0);
  });

  it('treats a non-numeric numerator as 0', () => {
    expect(safeRatio(undefined, 10)).toBe(0);
  });
});

describe('DATA_QUALITY_CHECKS registry', () => {
  it('has no duplicate ids', () => {
    const ids = DATA_QUALITY_CHECKS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every check has a non-empty label and sql', () => {
    for (const c of DATA_QUALITY_CHECKS) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.sql.length).toBeGreaterThan(0);
    }
  });
});

describe('individual evaluate() functions', () => {
  const now = new Date('2026-07-19T12:00:00Z');
  const byId = (id: string) => DATA_QUALITY_CHECKS.find(c => c.id === id)!;

  it('ohlcv-freshness-coverage fails when there is no recent data', () => {
    const r = byId('ohlcv-freshness-coverage').evaluate(undefined, now);
    expect(r.status).toBe('fail');
  });

  it('ohlcv-freshness-coverage fails on thin universe coverage even if fresh', () => {
    const r = byId('ohlcv-freshness-coverage').evaluate({ last_date: '2026-07-19', symbols: 50 }, now);
    expect(r.status).toBe('fail');
  });

  it('ohlcv-freshness-coverage passes for fresh, broad data', () => {
    const r = byId('ohlcv-freshness-coverage').evaluate({ last_date: '2026-07-19T00:00:00Z', symbols: 2000 }, now);
    expect(r.status).toBe('pass');
  });

  it('technical-signals-freshness-coverage fails on the exact silent-collapse regression (low coverage, job still "fresh")', () => {
    const r = byId('technical-signals-freshness-coverage').evaluate(
      { total: 2000, scored: 40, last_date: '2026-07-19T00:00:00Z' }, now,
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/coverage/);
  });

  it('technical-signals-range-bounds fails when any row violates RSI/probability bounds', () => {
    const r = byId('technical-signals-range-bounds').evaluate({ bad: 3 }, now);
    expect(r.status).toBe('fail');
  });

  it('technical-signals-range-bounds passes with zero violations', () => {
    const r = byId('technical-signals-range-bounds').evaluate({ bad: 0 }, now);
    expect(r.status).toBe('pass');
  });

  it('technical-signals-stuck-value fails when every row has the same signal_score', () => {
    const r = byId('technical-signals-stuck-value').evaluate({ distinct_scores: 1, total: 500 }, now);
    expect(r.status).toBe('fail');
  });

  it('unified-recommendations-conviction-enum fails on an unrecognized value', () => {
    const r = byId('unified-recommendations-conviction-enum').evaluate({ bad: 2 }, now);
    expect(r.status).toBe('fail');
  });

  it('signal-outcomes-resolution-rate fails when most resolvable signals are stuck PENDING', () => {
    const r = byId('signal-outcomes-resolution-rate').evaluate({ total: 200, pending: 150 }, now);
    expect(r.status).toBe('fail');
  });

  it('signal-outcomes-resolution-rate passes when the backlog is mostly resolved', () => {
    const r = byId('signal-outcomes-resolution-rate').evaluate({ total: 200, pending: 10 }, now);
    expect(r.status).toBe('pass');
  });
});

describe('runDataQualityChecks (orchestration)', () => {
  beforeEach(() => { mockRow.current = undefined; });

  it('produces one result per registered check, never throwing on a bad row shape', async () => {
    const results = await runDataQualityChecks(new Date('2026-07-19T12:00:00Z'));
    expect(results.length).toBe(DATA_QUALITY_CHECKS.length);
    for (const r of results) {
      expect(['pass', 'warn', 'fail', 'error']).toContain(r.status);
    }
  });
});
