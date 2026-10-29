import { describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => undefined), dbAll: vi.fn(async () => []),
  dbRun: vi.fn(async () => {}), dbExec: vi.fn(async () => {}),
}));

import { DATA_QUALITY_CHECKS } from '../dataQualityChecks';

// AF-20260903-01: Yahoo's batch EOD sync silently dropped 412 of 2,550 symbols (RELIANCE included)
// with only a console.warn. reconcile-stock-ohlcv backfills from the official bhavcopy; nothing
// alarmed if the reconcile itself stopped working.
const check = () => DATA_QUALITY_CHECKS.find(c => c.id === 'ohlcv-bhavcopy-coverage')!;
const now = new Date('2026-10-29T05:00:00Z');

describe('ohlcv-bhavcopy-coverage', () => {
  it('exists and judges the latest complete official file, not today', () => {
    expect(check()).toBeDefined();
    expect(check().sql).toMatch(/date < current_date/);
    expect(check().sql).toMatch(/status = 'ACTIVE'/);
  });

  it('passes when every active traded symbol has a bar', () => {
    expect(check().evaluate({ trade_date: '2026-10-27', traded: 2169, missing: 0, nifty50_missing: 0 }, now).status).toBe('pass');
  });

  it('warns on a small gap', () => {
    expect(check().evaluate({ trade_date: '2026-10-23', traded: 2165, missing: 2, nifty50_missing: 0, symbols: 'CMLL CPL' }, now).status).toBe('warn');
  });

  it('fails on a gap of 1% or more of the traded universe', () => {
    expect(check().evaluate({ trade_date: '2026-09-02', traded: 2169, missing: 22, nifty50_missing: 0 }, now).status).toBe('fail');
  });

  it('fails when any NIFTY 50 name is missing', () => {
    expect(check().evaluate({ trade_date: '2026-09-03', traded: 2169, missing: 1, nifty50_missing: 1, symbols: 'RELIANCE' }, now).status).toBe('fail');
  });

  it('warns rather than passes when there is no complete file to judge', () => {
    expect(check().evaluate({ trade_date: null, traded: 0, missing: 0, nifty50_missing: 0 }, now).status).toBe('warn');
  });
});
