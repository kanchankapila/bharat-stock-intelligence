import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const { default: db } = await import('../db');

import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

// stock_corporate_action_history / nse_filed_corporate_actions are Python-fetcher-owned tables
// (mc_corporate_actions_fetcher.py / investsights_corporate_actions_fetcher.py's own
// ensure_schema()) -- not mirrored into db.ts, same convention as ohlcv_adjustment_factors /
// superstar_investor_activity. The test DB needs its own copy of the shape to exercise the
// router procedures that read them.
beforeEach(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_corporate_action_history (
      symbol TEXT NOT NULL, action_type TEXT NOT NULL, event_key TEXT NOT NULL,
      announce_date TEXT, record_date TEXT,
      ratio_text TEXT, ratio_factor REAL, amount REAL, detail TEXT,
      source TEXT DEFAULT 'moneycontrol', fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (symbol, action_type, event_key)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nse_filed_corporate_actions (
      source_url TEXT PRIMARY KEY, symbol TEXT NOT NULL, company_name TEXT,
      category TEXT, headline TEXT, dividend_per_share REAL,
      record_date TEXT, ex_date TEXT, filing_date TEXT, upcoming INTEGER,
      source TEXT DEFAULT 'investsights_nse_filings', fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('DELETE FROM stock_corporate_action_history');
  db.exec('DELETE FROM nse_filed_corporate_actions');
});

describe('getCorporateActionHistory', () => {
  it('returns a symbol\'s dividend/bonus/split/rights history, newest first', async () => {
    const insert = db.prepare(`
      INSERT INTO stock_corporate_action_history
        (symbol, action_type, event_key, announce_date, record_date, ratio_text, ratio_factor, amount)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    insert.run('RELIANCE', 'bonus', 'k1', '2024-09-05', '2024-10-28', '1:1', 0.5, null);
    insert.run('RELIANCE', 'dividend', 'k2', '2026-04-24', '2026-06-05', null, null, 6.0);

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
    const insert = db.prepare(`
      INSERT INTO stock_corporate_action_history (symbol, action_type, event_key, record_date)
      VALUES (?,?,?,?)
    `);
    insert.run('AAA', 'dividend', 'k1', '2026-01-01');
    insert.run('BBB', 'dividend', 'k1', '2026-01-01');   // same event_key, different symbol

    const rows = await caller.getCorporateActionHistory({ symbol: 'AAA' });
    expect(rows.length).toBe(1);
  });
});

describe('getFiledCorporateActionsCalendar', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('returns filed actions within the default window', async () => {
    const insert = db.prepare(`
      INSERT INTO nse_filed_corporate_actions
        (source_url, symbol, company_name, category, headline, record_date, filing_date, upcoming)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    insert.run('https://nsearchives.nseindia.com/corporate/a.pdf', 'TATAPOWER',
      'Tata Power', 'board_meeting|dividend', 'Board approved dividend', '2026-06-23', today, 0);

    const rows = await caller.getFiledCorporateActionsCalendar({});
    expect(rows.length).toBe(1);
    expect(rows[0].symbol).toBe('TATAPOWER');
    expect(rows[0].source_url).toContain('nsearchives.nseindia.com');
  });

  it('filters to one symbol when given', async () => {
    const insert = db.prepare(`
      INSERT INTO nse_filed_corporate_actions (source_url, symbol, filing_date)
      VALUES (?,?,?)
    `);
    insert.run('https://x/1.pdf', 'AAA', today);
    insert.run('https://x/2.pdf', 'BBB', today);

    const rows = await caller.getFiledCorporateActionsCalendar({ symbol: 'aaa' });
    expect(rows.length).toBe(1);
    expect(rows[0].symbol).toBe('AAA');
  });

  it('excludes filings outside the requested window', async () => {
    const insert = db.prepare(`
      INSERT INTO nse_filed_corporate_actions (source_url, symbol, filing_date)
      VALUES (?,?,?)
    `);
    insert.run('https://x/old.pdf', 'OLDCO', '2020-01-01');

    const rows = await caller.getFiledCorporateActionsCalendar({ daysBack: 14, daysForward: 60 });
    expect(rows.find((r: any) => r.symbol === 'OLDCO')).toBeUndefined();
  });
});
