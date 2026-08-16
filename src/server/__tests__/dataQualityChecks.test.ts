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

  describe('model-registry-active-ensemble (ml-promotion-gate-review, 2026-08-15)', () => {
    it('fails when there is no active model at all', () => {
      const r = byId('model-registry-active-ensemble').evaluate(
        { active_trained_at: null, active_auc: null, last_run_at: null }, now);
      expect(r.status).toBe('fail');
    });

    it('passes a fresh active model with a fresh run', () => {
      const r = byId('model-registry-active-ensemble').evaluate(
        { active_trained_at: '2026-07-15T00:00:00Z', active_auc: 0.65,
          last_run_at: '2026-07-15T00:00:00Z' }, now);
      expect(r.status).toBe('pass');
    });

    it('warns when the retrain job itself has not run in a long time', () => {
      const r = byId('model-registry-active-ensemble').evaluate(
        { active_trained_at: '2026-05-01T00:00:00Z', active_auc: 0.65,
          last_run_at: '2026-05-01T00:00:00Z' }, now);
      expect(r.status).toBe('warn');
    });

    it('does NOT warn when the active model is old but the job has kept running and correctly rejecting -- the fix', () => {
      // The bug this check used to have: reading only the ACTIVE row's trained_at means a
      // weekly retrain that keeps correctly rejecting a still-best stale baseline (the
      // staleness-override safety valve hasn't fired yet) looked identical to a job that
      // stopped running entirely. promote_or_register() writes a model_registry row on every
      // run, promoted or rejected, so last_run_at is real evidence the job ran recently even
      // though the ACTIVE row is 60 days old.
      const r = byId('model-registry-active-ensemble').evaluate(
        { active_trained_at: '2026-05-01T00:00:00Z', active_auc: 0.65,
          last_run_at: '2026-07-15T00:00:00Z' }, now);
      expect(r.status).toBe('pass');
      expect(r.detail).toContain('active model is');
    });
  });
});

describe('mc-consolidated-metrics-freshness (hand-rolled: needs a WHERE source_api filter the factory cannot express)', () => {
  const now = new Date('2026-08-03T12:00:00Z'); // a Monday
  const byId = (id: string) => DATA_QUALITY_CHECKS.find(c => c.id === id)!;

  it('filters on source_api so a sibling writer (et_marketstats) sharing this table cannot mask this source going stale', () => {
    // The mandate this check exists to satisfy is specifically that a bare MAX(fetched_at)
    // over the whole table would report "fresh" purely from et_marketstats' own daily writes.
    expect(byId('mc-consolidated-metrics-freshness').sql).toMatch(/source_api\s*=\s*'mc_consolidated'/);
  });

  it('is non-critical and reads an empty table as a soft warn, not a fail (request-time writer, no fixed schedule)', () => {
    const check = byId('mc-consolidated-metrics-freshness');
    expect(check.critical).toBe(false);
    const r = check.evaluate(undefined, now);
    expect(r.status).toBe('warn');
  });

  it('never fails even when very stale (sparse-by-nature style, matching insider-trades-recency)', () => {
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    const r = byId('mc-consolidated-metrics-freshness').evaluate({ last_date: sixtyDaysAgo }, now);
    expect(r.status).toBe('warn');
  });

  it('passes when a recent row exists', () => {
    const r = byId('mc-consolidated-metrics-freshness').evaluate({ last_date: now.toISOString() }, now);
    expect(r.status).toBe('pass');
  });
});

describe('trendlyne-screener-constituent-coverage (hand-rolled: per-screener, aggregate check cannot express it)', () => {
  const now = new Date('2026-08-03T12:00:00Z'); // a Monday
  const byId = (id: string) => DATA_QUALITY_CHECKS.find(c => c.id === id)!;
  const check = () => byId('trendlyne-screener-constituent-coverage');

  it('passes at the live-measured 2026-08-11 baseline (96/1003 gated upstream) — must not cry wolf on correct data', () => {
    const r = check().evaluate({ total: 1003, empty_count: 96 }, now);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('9.6%');
  });

  it('warns once the empty share grows clear of that baseline', () => {
    expect(check().evaluate({ total: 1003, empty_count: 200 }, now).status).toBe('warn');
  });

  it('fails on the shape a real parser regression takes — nsecode header renamed, every screener empties at once', () => {
    expect(check().evaluate({ total: 1003, empty_count: 1003 }, now).status).toBe('fail');
  });

  it('fails when discovery has never run, rather than dividing by zero into a false pass', () => {
    expect(check().evaluate({ total: 0, empty_count: 0 }, now).status).toBe('fail');
    expect(check().evaluate(undefined, now).status).toBe('fail');
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
    // The reason this table is empty is known and upstream (AMFI's portfolio-disclosure
    // endpoint now serves the scheme master list), so the daily report must SAY that rather
    // than repeat a bare "is empty" every morning -- a re-stated, already-triaged alert is
    // the kind that trains people to skim the report and miss a genuinely new failure.
    expect(r.detail).toMatch(/^mf_sector_allocation is empty/);
    expect(r.detail).toMatch(/AMFI/);
  });

  it('emptyDetail is opt-in -- a table without one still gets the bare default', () => {
    // Negative control for the field added alongside the AMFI note above: if the factory ever
    // starts applying one check's emptyDetail to another's, this catches it.
    const r = byId('mf-stock-holdings-recency').evaluate(undefined, now);
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('mf_stock_holdings is empty');
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

  it('mc-swot-history-freshness (request-time writer, no fixed schedule) never fails, only warns/passes', () => {
    const check = byId('mc-swot-history-freshness');
    expect(check.critical).toBe(false);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    expect(check.evaluate({ last_date: sixtyDaysAgo }, now).status).toBe('warn');
    expect(check.evaluate({ last_date: now.toISOString() }, now).status).toBe('pass');
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

// ── Regression guards for the four defects the 2026-08-11 audit found live ────────────
// Each was invisible for weeks because the table was fresh and full the whole time -- just
// full of the wrong rows. Freshness checks cannot catch any of them, which is why these
// evaluate() bodies exist. The SQL was validated by running it against live Postgres; these
// tests pin the decision logic, including that a clean table does NOT alarm.
describe('audit regression guards (2026-08-11)', () => {
  const find = (id: string) => {
    const c = DATA_QUALITY_CHECKS.find(x => x.id === id);
    expect(c, `check ${id} is not registered`).toBeDefined();
    return c!;
  };
  const now = new Date('2026-08-11T12:00:00Z');

  it('ghost-symbol check fails when a ranked symbol has no price history', () => {
    const c = find('unified-recommendations-ghost-symbols');
    expect(c.evaluate({ ghosts: 29014 }, now).status).toBe('fail');
    expect(c.evaluate({ ghosts: 29014 }, now).detail).toContain('--ghost-recommendations');
    expect(c.evaluate({ ghosts: 0 }, now).status).toBe('pass');
    expect(c.critical).toBe(true);
  });

  it('trading-day check fails on a snapshot dated to a closed day', () => {
    const c = find('unified-recommendations-trading-day');
    expect(c.evaluate({ bad_days: 4 }, now).status).toBe('fail');
    expect(c.evaluate({ bad_days: 4 }, now).detail).toContain('logical_session_date');
    expect(c.evaluate({ bad_days: 0 }, now).status).toBe('pass');
  });

  it('liquid-coverage check fails when the ranker universe diverges from the tradeable one', () => {
    const c = find('unified-recommendations-liquid-coverage');
    // The real 2026-07-29 shape: 8 of 1,534 liquid names ranked while the table held 2,301 rows.
    expect(c.evaluate({ liquid: 1534, covered: 8 }, now).status).toBe('fail');
    expect(c.evaluate({ liquid: 1519, covered: 700 }, now).status).toBe('warn');
    // The real post-fix shape.
    expect(c.evaluate({ liquid: 1519, covered: 1387 }, now).status).toBe('pass');
  });

  it('liquid-coverage warns rather than dividing by zero on an empty universe', () => {
    const c = find('unified-recommendations-liquid-coverage');
    expect(c.evaluate({ liquid: 0, covered: 0 }, now).status).toBe('warn');
  });

  it('delivery-trades check fails when trades duplicates delivery_qty', () => {
    const c = find('stock-delivery-trades-not-duplicated');
    // The original defect, verbatim: the positional read captured DELIV_QTY for every row.
    expect(c.evaluate({ dupes: 664006, populated: 664006 }, now).status).toBe('fail');
    expect(c.evaluate({ dupes: 664006, populated: 664006 }, now).detail).toContain('--delivery-trades');
    expect(c.evaluate({ dupes: 0, populated: 664006 }, now).status).toBe('pass');
  });

  it('delivery-trades check tolerates a coincidental match on an illiquid name', () => {
    // Live 2026-08-11: ASTAR traded 4 shares in 4 trades at 100% delivery, so trades = 4 =
    // delivery_qty on correct data. Under the old bare `dupes > 0` rule that one row failed the
    // whole check. A check that fails on correct data stops being read.
    const c = find('stock-delivery-trades-not-duplicated');
    const r = c.evaluate({ dupes: 1, populated: 4888 }, now);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('coincidental');
  });

  it('delivery-trades check still fires well below a full-table drift', () => {
    // Guards the floor itself: partial drift (e.g. one exchange segment's columns moving) must
    // not slip under it. 10% of rows is nothing like arithmetic coincidence.
    const c = find('stock-delivery-trades-not-duplicated');
    expect(c.evaluate({ dupes: 500, populated: 5000 }, now).status).toBe('fail');
  });

  it('delivery-trades check warns when the column is entirely unpopulated', () => {
    const c = find('stock-delivery-trades-not-duplicated');
    const r = c.evaluate({ dupes: 0, populated: 0 }, now);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('entirely NULL');
  });

  it('all four are registered and none duplicates an existing id', () => {
    const ids = DATA_QUALITY_CHECKS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'unified-recommendations-ghost-symbols',
      'unified-recommendations-trading-day',
      'unified-recommendations-liquid-coverage',
      'stock-delivery-trades-not-duplicated',
    ]) expect(ids).toContain(id);
  });
});

describe('technical-signals-provenance-timestamps', () => {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === 'technical-signals-provenance-timestamps')!;
  const now = new Date('2026-08-15T12:00:00Z');

  it('is registered', () => {
    expect(check).toBeDefined();
  });

  it('NEGATIVE CONTROL: fails when the columns are dead — the exact pre-migration state', () => {
    // All 73,563 rows had created_at/updated_at NULL before migration 1787040000000. This is the
    // state that made the 2026-08-15 win_probability look-ahead undetectable; if this check
    // cannot fail on it, it protects nothing.
    const r = check.evaluate!({ todays_rows: 2192, created_at_set: 0, updated_at_set: 0 }, now);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('created_at');
    expect(r.detail).toContain('updated_at');
  });

  it('fails when only updated_at is dead (DEFAULT applied but trigger missing)', () => {
    // The realistic partial-failure mode: a DEFAULT fires on INSERT so created_at populates,
    // while updated_at stays NULL because the BEFORE UPDATE trigger was dropped. That still
    // destroys write-time provenance for the later enrichment UPDATEs, which is the whole point.
    const r = check.evaluate!({ todays_rows: 2192, created_at_set: 2192, updated_at_set: 0 }, now);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('updated_at');
    expect(r.detail).not.toContain('created_at and');
  });

  it('passes when both are populated', () => {
    const r = check.evaluate!({ todays_rows: 2192, created_at_set: 2192, updated_at_set: 2192 }, now);
    expect(r.status).toBe('pass');
  });

  it('passes vacuously only when no rows exist yet today (holiday/pre-scan)', () => {
    const r = check.evaluate!({ todays_rows: 0, created_at_set: 0, updated_at_set: 0 }, now);
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('nothing to check');
  });
});

describe('win-probability-scored-in-time', () => {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === 'win-probability-scored-in-time')!;
  const now = new Date('2026-08-15T12:00:00Z');

  it('is registered', () => expect(check).toBeDefined());

  it('NEGATIVE CONTROL: fails on a multi-day scoring lag, whatever the cadence turns out to be', () => {
    // A value written days after its signal date cannot have been traded on at the next open.
    // That property is about the LAG, not about how often the scorer runs -- an earlier version
    // of this comment asserted `--score` runs only in the weekly retrain, which measurement.md
    // withdrew on 2026-08-15 (it runs daily via queues.ts:1037 `pythonApi.scorePending()`).
    // The scenario below is valid either way; only the explanation was wrong.
    const r = check.evaluate!({ scored: 2192, avg_lag_days: 5.2, max_lag_days: 8.9 }, now);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('look-ahead');
  });

  it('NEGATIVE CONTROL: refuses to render a verdict from a single manual write', () => {
    // Live on 2026-08-16 exactly ONE row carried a stamp, at 1.41d -- which measurement.md
    // records as "an artifact of a manual test write, NOT the real cadence". Without the
    // minimum-sample floor this row alone drove a WARN on 36/36 consecutive runs, which is what
    // put this check on the unvarying-verdict meta-check's list. Same shape as measurement.md's
    // "dramatic number from a small filtered subsample" (t=-3.44 -> -1.28 once re-anchored).
    // Pre-fix this returned 'warn'; it must now decline to judge.
    const r = check.evaluate!({ scored: 1, avg_lag_days: 1.41, max_lag_days: 1.41 }, now);
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/too thin to judge/i);
  });

  it('the minimum-sample floor does not swallow a real defect once a full batch lands', () => {
    // 2,192 rows at a 5.2d lag is a genuine batch and must still FAIL, not be excused as thin.
    const r = check.evaluate!({ scored: 2192, avg_lag_days: 5.2, max_lag_days: 8.9 }, now);
    expect(r.status).toBe('fail');
  });

  it('warns when the write lands after the next open but is not yet a backfilled label', () => {
    const r = check.evaluate!({ scored: 2192, avg_lag_days: 1.8, max_lag_days: 2.4 }, now);
    expect(r.status).toBe('warn');
  });

  it('passes on same-evening scoring, which is genuinely actionable next-open', () => {
    // The 1.41d lag measured live on 2026-08-15 sits in the warn band by design: a value written
    // ~34h after the signal date has missed the next session's open.
    const r = check.evaluate!({ scored: 2192, avg_lag_days: 0.4, max_lag_days: 0.9 }, now);
    expect(r.status).toBe('pass');
  });

  it('passes explicitly-uninformatively before the scorer has run at all', () => {
    const r = check.evaluate!({ scored: 0, avg_lag_days: null, max_lag_days: null }, now);
    expect(r.status).toBe('pass');
    // Assert the BEHAVIOUR (it names the migration and says nothing has landed yet), not a
    // substring of one sentence -- the previous assertion pinned the phrase "has not run" from
    // wording that encoded the withdrawn weekly-cadence claim, so correcting the claim broke a
    // test that was never about cadence.
    expect(r.detail).toContain('1787050000000');
  });
});
