import { describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => undefined), dbAll: vi.fn(async () => []),
  dbRun: vi.fn(async () => {}), dbExec: vi.fn(async () => {}),
}));

import { DATA_QUALITY_CHECKS } from '../dataQualityChecks';

// AF-20261028-22: the unclean Postgres stop of 2026-10-26 reset the cumulative statistics, leaving
// 177 of 267 tables with no analyze time, so autovacuum/autoanalyze ran late until a manual
// VACUUM (ANALYZE). Sized by pg_class.reltuples, because a crash also zeroes n_live_tup.
const check = () => DATA_QUALITY_CHECKS.find(c => c.id === 'pg-tables-analyzed')!;
const now = new Date('2026-10-29T05:00:00Z');

describe('pg-tables-analyzed', () => {
  it('sizes tables by planner reltuples, not the crash-reset live-tuple counter', () => {
    expect(check().sql).toMatch(/reltuples/);
    expect(check().sql).not.toMatch(/n_live_tup/);
  });
  it('passes when every large table has been analyzed', () => {
    expect(check().evaluate({ big: 180, unanalyzed: 0 }, now).status).toBe('pass');
  });
  it('warns when a few large tables were never analyzed', () => {
    expect(check().evaluate({ big: 180, unanalyzed: 20, sample: 'a b' }, now).status).toBe('warn');
  });
  it('fails after a stats reset leaves most large tables unanalyzed', () => {
    expect(check().evaluate({ big: 180, unanalyzed: 120, sample: 'a b' }, now).status).toBe('fail');
  });
});
