import { describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => undefined),
  dbAll: vi.fn(async () => []),
  dbRun: vi.fn(async () => undefined),
  dbExec: vi.fn(async () => undefined),
}));

import { DATA_QUALITY_CHECKS, DQ_STATIC_PROPERTY_CHECK_IDS } from '../dataQualityChecks';

const check = (id: string) => DATA_QUALITY_CHECKS.find(candidate => candidate.id === id)!;
const now = new Date('2026-11-02T02:00:00Z');

describe('data-quality checks do not masquerade static or moving inputs as frozen', () => {
  it.each([
    'fundamental-observation-writer-contract',
    'market-endpoint-tick-label-honesty',
    'signal-source-table-coverage',
  ])('%s declares its schema/reference invariant', id => {
    expect(check(id).assertsStaticProperty).toBe(true);
    expect(DQ_STATIC_PROPERTY_CHECK_IDS.has(id)).toBe(true);
  });

  it.each([
    ['earnings-revision-shadow-freshness',
      { last_date: '2026-11-01T01:00:00Z' }, { last_date: '2026-11-02T01:00:00Z' }],
    ['ohlcv-fabricated-session',
      { bad_days: 0, as_of: '2026-11-01' }, { bad_days: 0, as_of: '2026-11-02' }],
    ['ohlcv-exit-carryforward',
      { symbols: 0, bars: 0, as_of: '2026-11-01' }, { symbols: 0, bars: 0, as_of: '2026-11-02' }],
    ['technical-signals-feature-coverage',
      { newly_dead_count: 0, recent_dates: 10, ref_dates: 10, recent_max: '2026-10-30', ref_max: '2026-10-16' },
      { newly_dead_count: 0, recent_dates: 10, ref_dates: 10, recent_max: '2026-11-02', ref_max: '2026-10-19' }],
    ['unified-recommendations-conviction-enum',
      { bad: 0, total: 100, latest_batch: '2026-11-01T10:00:00Z' },
      { bad: 0, total: 101, latest_batch: '2026-11-02T10:00:00Z' }],
    ['unified-recommendations-ghost-symbols',
      { ghosts: 0, total: 100, latest_batch: '2026-11-01T10:00:00Z' },
      { ghosts: 0, total: 101, latest_batch: '2026-11-02T10:00:00Z' }],
  ])('%s reports changing evidence even while passing', (id, first, second) => {
    const firstDetail = check(id).evaluate(first, now).detail;
    const secondDetail = check(id).evaluate(second, now).detail;
    expect(firstDetail).not.toBe(secondDetail);
  });
});
