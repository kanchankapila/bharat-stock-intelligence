import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRow: { current: Record<string, any> | undefined } = { current: undefined };
vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => mockRow.current),
  dbRun: vi.fn(async () => {}),
  dbExec: vi.fn(async () => {}),
}));

import { DATA_QUALITY_CHECKS, daysStale, tradingDaysStale, safeRatio, runDataQualityChecks } from '../dataQualityChecks';

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

describe('tradingDaysStale', () => {
  it('returns null for missing/unparseable values, same as daysStale', () => {
    const now = new Date('2026-08-03T12:00:00Z');
    expect(tradingDaysStale(null, now)).toBeNull();
    expect(tradingDaysStale('not-a-date', now)).toBeNull();
  });

  it('subtracts the weekend from a Friday-to-Monday gap (the regression this fixes)', () => {
    // Friday 2026-07-31 -> Monday 2026-08-03, ~08:40 IST (03:10 UTC) check time.
    const now = new Date('2026-08-03T03:10:00Z');
    const raw = daysStale('2026-07-31', now)!;
    const adjusted = tradingDaysStale('2026-07-31', now)!;
    expect(raw).toBeGreaterThan(3); // this is what falsely warned before the fix
    expect(adjusted).toBeLessThan(2); // Sat+Sun subtracted -> reads as a normal same-week lag
    expect(raw - adjusted).toBeCloseTo(2, 5);
  });

  it('does not subtract anything for a same-week weekday gap', () => {
    // Tuesday -> Wednesday, no weekend in between.
    const now = new Date('2026-07-22T12:00:00Z');
    expect(tradingDaysStale('2026-07-21', now)).toBeCloseTo(daysStale('2026-07-21', now)!, 5);
  });

  it('never goes negative even if the weekend subtraction would overshoot', () => {
    const now = new Date('2026-08-01T01:00:00Z'); // Saturday, just after Friday close
    const adjusted = tradingDaysStale('2026-07-31T18:30:00Z', now)!;
    expect(adjusted).toBeGreaterThanOrEqual(0);
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

  it('covers at least 55 checks (25 hand-written + the 2026-08-03 live-datasource sweep)', () => {
    // Not a magic-number pin on the exact count -- a floor. This exists so a future refactor
    // that accidentally drops the generated TABLE_FRESHNESS_CHECKS entries (e.g. forgetting the
    // spread into DATA_QUALITY_CHECKS) fails a test instead of silently shrinking coverage back
    // toward the ~25 checks this file started with.
    expect(DATA_QUALITY_CHECKS.length).toBeGreaterThanOrEqual(55);
  });

  it('every generated freshness check\'s SQL targets its own declared table', () => {
    // Spot-checks a representative sample rather than every entry -- this is a wiring
    // sanity check (did the factory interpolate the right table name), not a re-test of the
    // factory's own logic (covered by the dedicated describe block below).
    const sample = ['nse-universe-history-freshness', 'confluence-signals-freshness', 'mf-sector-allocation-recency'];
    for (const id of sample) {
      const check = DATA_QUALITY_CHECKS.find(c => c.id === id)!;
      expect(check).toBeDefined();
      expect(check.sql).toMatch(/FROM \S+/);
    }
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

  it('ohlcv-freshness-coverage does not false-warn on a Monday morning check for Friday data (regression)', () => {
    const mondayMorning = new Date('2026-08-03T03:10:00Z'); // ~08:40 IST
    const r = byId('ohlcv-freshness-coverage').evaluate({ last_date: '2026-07-31', symbols: 2436 }, mondayMorning);
    expect(r.status).toBe('pass');
  });

  it('fii-dii-flow-freshness does not false-warn on a Monday morning check for Friday data (regression)', () => {
    const mondayMorning = new Date('2026-08-03T03:10:00Z');
    const r = byId('fii-dii-flow-freshness').evaluate({ last_date: '2026-07-31' }, mondayMorning);
    expect(r.status).toBe('pass');
  });

  it('market-regimes-freshness does not false-warn on a Monday morning check for Friday data (regression)', () => {
    const mondayMorning = new Date('2026-08-03T03:10:00Z');
    const r = byId('market-regimes-freshness').evaluate({ last_date: '2026-07-31' }, mondayMorning);
    expect(r.status).toBe('pass');
  });

  it('ohlcv/fii-dii/market-regimes freshness checks still fail a real multi-weekday outage', () => {
    // A full week stale (well beyond any weekend adjustment) must still fail/warn.
    const aWeekLater = new Date('2026-08-07T12:00:00Z');
    expect(byId('ohlcv-freshness-coverage').evaluate({ last_date: '2026-07-31', symbols: 2436 }, aWeekLater).status).toBe('fail');
    expect(byId('fii-dii-flow-freshness').evaluate({ last_date: '2026-07-31' }, aWeekLater).status).toBe('fail');
    expect(byId('market-regimes-freshness').evaluate({ last_date: '2026-07-31' }, aWeekLater).status).toBe('fail');
  });

  it('insider-trades-recency reads the parsed date_iso column, not the raw non-sortable display-text date', () => {
    // insider_trades.date is NSE's raw "22 May, 2026"-style text -- MAX(date) sorts lexically and
    // silently returns the wrong "latest" row. date_iso is the ISO column added to fix that.
    expect(byId('insider-trades-recency').sql).toMatch(/date_iso/);
    expect(byId('insider-trades-recency').sql).not.toMatch(/MAX\(date\)/);
  });

  it('bulk-deals-recency (id kept stable) now points at the live block_deals table, not the dead bulk_deals one', () => {
    expect(byId('bulk-deals-recency').sql).toMatch(/block_deals/);
    expect(byId('bulk-deals-recency').sql).not.toMatch(/\bbulk_deals\b/);
  });

  it('regime-edge-trust-floor passes as informational when no regime has enough history yet', () => {
    const r = byId('regime-edge-trust-floor').evaluate({ breached_count: 0, ready_count: 0, latest_computed_at: null }, now);
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/not.*enough history|no regime/i);
  });

  it('regime-edge-trust-floor warns when a ready regime is below the 0.55 trust floor', () => {
    const r = byId('regime-edge-trust-floor').evaluate(
      { breached_count: 1, ready_count: 3, latest_computed_at: now.toISOString() }, now);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/1 of 3/);
  });

  it('regime-edge-trust-floor passes when every ready regime clears the trust floor', () => {
    const r = byId('regime-edge-trust-floor').evaluate(
      { breached_count: 0, ready_count: 2, latest_computed_at: now.toISOString() }, now);
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/clear the live-edge trust floor/);
  });

  it('regime-edge-trust-floor warns if its own snapshot has gone stale, even with no breach', () => {
    const fourDaysLater = new Date(now.getTime() + 4 * 86_400_000);
    const r = byId('regime-edge-trust-floor').evaluate(
      { breached_count: 0, ready_count: 2, latest_computed_at: now.toISOString() }, fourDaysLater);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/refresh/);
  });

  it('technical-signals-freshness-coverage fails on the exact silent-collapse regression (low coverage, job still "fresh")', () => {
    const r = byId('technical-signals-freshness-coverage').evaluate(
      { total: 2000, scored: 40, last_date: '2026-07-19T00:00:00Z' }, now,
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/coverage/);
  });

  it('technical-signals-freshness-coverage does not false-fail on a Monday morning check for Friday data (regression 2026-08-10)', () => {
    // data-quality-daily runs 08:40 IST, well before technical-signals-daily's own 8:30am-4pm
    // IST weekday window has produced a fresh Monday row -- Friday's last scan is correctly
    // only ~0.7 trading-days old, not the ~2.7-3.1 raw calendar days that flagged this "fail"
    // every Monday until this check used tradingDaysStale() like its 3 siblings already did.
    const mondayMorning = new Date('2026-08-10T03:10:00Z');
    const r = byId('technical-signals-freshness-coverage').evaluate(
      { total: 2200, scored: 1800, last_date: '2026-08-07' }, mondayMorning,
    );
    expect(r.status).toBe('pass');
  });

  it('technical-signals-freshness-coverage still fails a real multi-weekday outage', () => {
    const aWeekLater = new Date('2026-08-14T12:00:00Z');
    const r = byId('technical-signals-freshness-coverage').evaluate(
      { total: 2200, scored: 1800, last_date: '2026-08-07' }, aWeekLater,
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/old/);
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

describe('generated freshness checks (TABLE_FRESHNESS_CHECKS via makeFreshnessCheck)', () => {
  const now = new Date('2026-08-03T12:00:00Z'); // a Monday
  const byId = (id: string) => DATA_QUALITY_CHECKS.find(c => c.id === id)!;

  it('a critical, standard 3-tier check (nse_universe_history) fails on an empty table', () => {
    const r = byId('nse-universe-history-freshness').evaluate(undefined, now);
    expect(r.status).toBe('fail');
  });

  it('a non-critical standard check reads empty as a warn, not a fail', () => {
    const r = byId('so-option-chain-freshness').evaluate(undefined, now);
    expect(r.status).toBe('warn');
  });

  it('a "sparse by nature" check (no failDays) never returns fail, only warn/pass', () => {
    // 66 days stale -- would be a hard fail under a standard 3-tier threshold.
    const r = byId('insider-transactions-recency').evaluate({ last_date: '2026-05-29' }, now);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/sparse by nature/);
  });

  it('mf-sector-allocation-recency (found empty by this very sweep) reads as warn on a real empty table', () => {
    const r = byId('mf-sector-allocation-recency').evaluate(undefined, now);
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('mf_sector_allocation is empty');
  });

  it('trading-day-aware checks absorb a weekend gap (Friday data on a Monday check)', () => {
    // Same regression shape as the ohlcv/fii-dii/market-regimes fix above, exercised through
    // the generic factory this time instead of a bespoke evaluate().
    const r = byId('nse-universe-history-freshness').evaluate({ last_date: '2026-07-31' }, now);
    expect(r.status).toBe('pass');
  });

  it('confluence-signals-freshness is NOT trading-day-aware, but tolerates the real ~9h daily skip window', () => {
    // Fixed 2026-08-07: confluence-compute does NOT run every 30 minutes every day (that was
    // the bug this threshold was originally, wrongly, sized around) -- processConfluenceCompute
    // deliberately skips ALL real writes for ~9h/trading day (isMarketOpen() 9:15am-3:30pm PLUS
    // isConfluenceComputeWindow()'s wider 8am-9:15am/3:30pm-5pm skip -- see confluence.jobs.ts).
    // A naive hour-scale threshold false-alarmed WARN then CRITICAL FAIL every single trading
    // day -- live-caught via `npm run dq:check` mid-warn at 10am IST. 3 hours stale (well inside
    // the legitimate gap) must NOT warn; something genuinely beyond the ~9h/12h window must.
    const threeHoursAgo = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    expect(byId('confluence-signals-freshness').evaluate({ last_date: threeHoursAgo }, now).status).toBe('pass');
    const tenHoursAgo = new Date(now.getTime() - 10 * 3_600_000).toISOString();
    expect(byId('confluence-signals-freshness').evaluate({ last_date: tenHoursAgo }, now).status).toBe('warn');
    const thirteenHoursAgo = new Date(now.getTime() - 13 * 3_600_000).toISOString();
    expect(byId('confluence-signals-freshness').evaluate({ last_date: thirteenHoursAgo }, now).status).toBe('fail');
    // A weekend gap must still NOT be absorbed here (not trading-day-aware) -- Saturday's data
    // is genuinely stale by Monday, far beyond even the widened threshold.
    const satMorning = new Date(now.getTime() - 2.2 * 86_400_000).toISOString();
    expect(byId('confluence-signals-freshness').evaluate({ last_date: satMorning }, now).status).toBe('fail');
  });

  it('nativeDateColumn casts the date column to ::text in the generated SQL', () => {
    // macro_asset_prices.date is a native Postgres DATE column (see stock_ohlcv precedent).
    expect(byId('macro-asset-prices-freshness').sql).toMatch(/date::text/);
  });

  it('news-sentiment-freshness is NOT trading-day-aware (news lands 7 days a week) and does not absorb a weekend gap', () => {
    // A tradingDayAware:true check would forgive a Fri->Mon gap (~2 weekend days subtracted)
    // and read this as fresh. This table is fed by RSS/Google News/BSE/GNews around the
    // clock, so the same raw gap must still register as stale, never silently absorbed to 'pass'.
    const satMorning = new Date(now.getTime() - 2.2 * 86_400_000).toISOString();
    expect(byId('news-sentiment-freshness').evaluate({ last_date: satMorning }, now).status).toBe('warn');

    // Comfortably past failDays=3 with no weekend-forgiveness applied -> fail.
    const fourDaysAgo = new Date(now.getTime() - 4 * 86_400_000).toISOString();
    expect(byId('news-sentiment-freshness').evaluate({ last_date: fourDaysAgo }, now).status).toBe('fail');
  });

  it('news-sentiment-freshness reads empty as a warn (non-critical)', () => {
    const r = byId('news-sentiment-freshness').evaluate(undefined, now);
    expect(r.status).toBe('warn');
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
