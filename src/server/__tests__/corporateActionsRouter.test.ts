import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';
import { cacheDel } from '../cacheService';

const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

// stock_corporate_action_history / nse_filed_corporate_actions are Python-fetcher-owned tables
// (mc_corporate_actions_fetcher.py / investsights_corporate_actions_fetcher.py's own
// ensure_schema()) -- not mirrored into db.ts, same convention as ohlcv_adjustment_factors /
// superstar_investor_activity. The test DB needs its own copy of the shape to exercise the
// router procedures that read them.
beforeEach(async () => {
  await dbExec(`
    CREATE TABLE IF NOT EXISTS stock_corporate_action_history (
      symbol TEXT NOT NULL, action_type TEXT NOT NULL, event_key TEXT NOT NULL,
      announce_date TEXT, record_date TEXT,
      ratio_text TEXT, ratio_factor REAL, amount REAL, detail TEXT,
      source TEXT DEFAULT 'moneycontrol', fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (symbol, action_type, event_key)
    )
  `);
  await dbExec(`
    CREATE TABLE IF NOT EXISTS nse_filed_corporate_actions (
      source_url TEXT PRIMARY KEY, symbol TEXT NOT NULL, company_name TEXT,
      category TEXT, headline TEXT, dividend_per_share REAL,
      record_date TEXT, ex_date TEXT, filing_date TEXT, upcoming INTEGER,
      source TEXT DEFAULT 'investsights_nse_filings', fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // ohlcv_adjustment_factors -- same "not mirrored into db.ts" convention as the two tables
  // above. getCorporateActionHistory cross-references it to annotate each corp-action row with
  // whether ohlcv_adjust.py's own heuristic (or its cross-validation pass) independently
  // confirmed the same split/bonus, mirroring that file's DATE_WINDOW_DAYS=5/RATIO_TOL=0.025.
  await dbExec(`
    CREATE TABLE IF NOT EXISTS ohlcv_adjustment_factors (
      symbol TEXT NOT NULL, ex_date TEXT NOT NULL, factor REAL NOT NULL,
      source TEXT DEFAULT 'bhavcopy_prev_close',
      PRIMARY KEY (symbol, ex_date)
    )
  `);
  await dbExec('DELETE FROM stock_corporate_action_history');
  await dbExec('DELETE FROM nse_filed_corporate_actions');
  await dbExec('DELETE FROM ohlcv_adjustment_factors');
});

describe('getCorporateActionHistory', () => {
  it('returns a symbol\'s dividend/bonus/split/rights history, newest first', async () => {
    const insert = `
      INSERT INTO stock_corporate_action_history
        (symbol, action_type, event_key, announce_date, record_date, ratio_text, ratio_factor, amount)
      VALUES (?,?,?,?,?,?,?,?)
    `;
    await dbRun(insert, ['RELIANCE', 'bonus', 'k1', '2024-09-05', '2024-10-28', '1:1', 0.5, null]);
    await dbRun(insert, ['RELIANCE', 'dividend', 'k2', '2026-04-24', '2026-06-05', null, null, 6.0]);

    const rows = await caller.getCorporateActionHistory({ symbol: 'reliance' });
    expect(rows.length).toBe(2);
    expect(rows[0].record_date).toBe('2026-06-05');   // newest first
    expect(rows.find((r: any) => r.action_type === 'bonus').ratio_factor).toBeCloseTo(0.5);
  });

  it('returns an empty array, not an error, for a symbol with no history', async () => {
    const rows = await caller.getCorporateActionHistory({ symbol: 'ZZZZZZ' });
    expect(rows).toEqual([]);
  });

  it('never mixes one symbol\'s history into another\'s response', async () => {
    const insert = `
      INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date)
      VALUES (?,?,?,?)
    `;
    await dbRun(insert, ['AAA', 'dividend', 'k1', '2026-01-01']);
    await dbRun(insert, ['BBB', 'dividend', 'k1', '2026-01-01']);   // same event_key, different symbol

    const rows = await caller.getCorporateActionHistory({ symbol: 'AAA' });
    expect(rows.length).toBe(1);
  });

  describe('crossCheck annotation (ohlcv_adjustment_factors reconciliation)', () => {
    it('marks a split/bonus confirmed_by_bhavcopy when a heuristic-detected factor matches within window+tolerance', async () => {
      await dbRun(`INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date, ratio_factor)
                   VALUES (?,?,?,?,?)`, ['NESTLEIND', 'split', 'k1', '2026-02-10', 0.2]);
      // 3 days apart (<=5), 2% off (<=2.5% tolerance) -- source left at the DB default
      // (bhavcopy_prev_close), i.e. the heuristic found it independently.
      await dbRun(`INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor) VALUES (?,?,?)`, ['NESTLEIND', '2026-02-13', 0.204]);

      const rows = await caller.getCorporateActionHistory({ symbol: 'NESTLEIND' });
      expect(rows[0].crossCheck).toBe('confirmed_by_bhavcopy');
    });

    it('marks confirmed_via_this_source when the only matching factor came from this same MC ledger (mc_corporate_action)', async () => {
      await dbRun(`INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date, ratio_factor)
                   VALUES (?,?,?,?,?)`, ['RELIANCE', 'bonus', 'k1', '2017-09-07', 0.5]);
      await dbRun(`INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor, source) VALUES (?,?,?,?)`, ['RELIANCE', '2017-09-07', 0.5, 'mc_corporate_action']);

      const rows = await caller.getCorporateActionHistory({ symbol: 'RELIANCE' });
      expect(rows[0].crossCheck).toBe('confirmed_via_this_source');
    });

    it('marks unconfirmed when no nearby/matching factor exists', async () => {
      await dbRun(`INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date, ratio_factor)
                   VALUES (?,?,?,?,?)`, ['ORPHANCO', 'split', 'k1', '2026-03-01', 0.5]);

      const rows = await caller.getCorporateActionHistory({ symbol: 'ORPHANCO' });
      expect(rows[0].crossCheck).toBe('unconfirmed');
    });

    it('does not confirm a factor that is outside the +-5 day window even with an identical ratio', async () => {
      await dbRun(`INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date, ratio_factor)
                   VALUES (?,?,?,?,?)`, ['FARAPART', 'split', 'k1', '2026-03-01', 0.5]);
      await dbRun(`INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor) VALUES (?,?,?)`, ['FARAPART', '2026-03-10', 0.5]);   // 9 days apart

      const rows = await caller.getCorporateActionHistory({ symbol: 'FARAPART' });
      expect(rows[0].crossCheck).toBe('unconfirmed');
    });

    it('does not confirm a factor outside the 2.5% ratio tolerance even within the date window', async () => {
      await dbRun(`INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date, ratio_factor)
                   VALUES (?,?,?,?,?)`, ['OFFRATIO', 'bonus', 'k1', '2026-03-01', 0.5]);
      await dbRun(`INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor) VALUES (?,?,?)`, ['OFFRATIO', '2026-03-02', 0.6]);   // 20% off

      const rows = await caller.getCorporateActionHistory({ symbol: 'OFFRATIO' });
      expect(rows[0].crossCheck).toBe('unconfirmed');
    });

    it('marks not_applicable for a dividend (amount-based, no ratio_factor to cross-check)', async () => {
      await dbRun(`INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date, amount)
                   VALUES (?,?,?,?,?)`, ['DIVCO', 'dividend', 'k1', '2026-04-24', 6.0]);

      const rows = await caller.getCorporateActionHistory({ symbol: 'DIVCO' });
      expect(rows[0].crossCheck).toBe('not_applicable');
    });

    it('never cross-checks one symbol\'s action against another symbol\'s factor', async () => {
      await dbRun(`INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date, ratio_factor)
                   VALUES (?,?,?,?,?)`, ['SYMA', 'split', 'k1', '2026-03-01', 0.5]);
      await dbRun(`INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor) VALUES (?,?,?)`, ['SYMB', '2026-03-01', 0.5]);   // exact match, but a different symbol

      const rows = await caller.getCorporateActionHistory({ symbol: 'SYMA' });
      expect(rows[0].crossCheck).toBe('unconfirmed');
    });
  });
});

describe('getFiledCorporateActionsCalendar', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('returns filed actions within the default window', async () => {
    const insert = `
      INSERT INTO nse_filed_corporate_actions
        (source_url, symbol, company_name, category, headline, record_date, filing_date, upcoming)
      VALUES (?,?,?,?,?,?,?,?)
    `;
    await dbRun(insert, ['https://nsearchives.nseindia.com/corporate/a.pdf', 'TATAPOWER',
      'Tata Power', 'board_meeting|dividend', 'Board approved dividend', '2026-06-23', today, 0]);

    const rows = await caller.getFiledCorporateActionsCalendar({});
    expect(rows.length).toBe(1);
    expect(rows[0].symbol).toBe('TATAPOWER');
    expect(rows[0].source_url).toContain('nsearchives.nseindia.com');
  });

  it('filters to one symbol when given', async () => {
    const insert = `
      INSERT INTO nse_filed_corporate_actions (source_url, symbol, filing_date)
      VALUES (?,?,?)
    `;
    await dbRun(insert, ['https://x/1.pdf', 'AAA', today]);
    await dbRun(insert, ['https://x/2.pdf', 'BBB', today]);

    const rows = await caller.getFiledCorporateActionsCalendar({ symbol: 'aaa' });
    expect(rows.length).toBe(1);
    expect(rows[0].symbol).toBe('AAA');
  });

  it('excludes filings outside the requested window', async () => {
    const insert = `
      INSERT INTO nse_filed_corporate_actions (source_url, symbol, filing_date)
      VALUES (?,?,?)
    `;
    await dbRun(insert, ['https://x/old.pdf', 'OLDCO', '2020-01-01']);

    // getFiledCorporateActionsCalendar wraps its query in fetchWithCache keyed by
    // `daysBack:daysForward:symbol` -- {daysBack:14, daysForward:60} is this file's default
    // and the first test above already populated that exact key, so calling with the same
    // values here would silently reuse ITS cached result instead of running this test's own
    // query. That masked a real bug: the router's WHERE clause used to no-op entirely under
    // the SQLite dev fallback (CURRENT_DATE ± (? || ' days')::interval -- stripPgCasts leaves
    // invalid arithmetic behind, trpc-surface-review 2026-08-14 / fixed 2026-08-15) --
    // run in isolation with `-t`, this test correctly failed pre-fix; run as part of the full
    // file, the stale cache from the first test masked it and it passed regardless. Clear the
    // key explicitly rather than picking different daysBack/daysForward values -- SQLite's
    // untyped storage-class comparison rules make the no-op's symptom value-dependent (a
    // (5,5) window happens not to trigger it at all; (14,60) reliably does), so changing the
    // values to dodge the collision would trade one accidental pass for another.
    await cacheDel('fund:filed-corp-actions:14:60:');
    const rows = await caller.getFiledCorporateActionsCalendar({ daysBack: 14, daysForward: 60 });
    expect(rows.find((r: any) => r.symbol === 'OLDCO')).toBeUndefined();
  });
});
