import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const caller = createCallerFactory(appRouter)({} as any);

// All three tables are Python-fetcher-owned (nse_fo_market_positioning_fetcher.py /
// nse_corporate_announcements_fetcher.py ensure_schema), so the test schema needs its own copy.
beforeEach(async () => {
  await dbExec(`CREATE TABLE IF NOT EXISTS nse_fo_ban_list (
    trade_date DATE NOT NULL, symbol TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'nse_archive',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (trade_date, symbol))`);
  await dbExec(`CREATE TABLE IF NOT EXISTS nse_participant_positions (
    trade_date DATE NOT NULL, kind TEXT NOT NULL, client_type TEXT NOT NULL,
    fut_idx_long DOUBLE PRECISION, fut_idx_short DOUBLE PRECISION,
    fut_stk_long DOUBLE PRECISION, fut_stk_short DOUBLE PRECISION,
    opt_idx_call_long DOUBLE PRECISION, opt_idx_put_long DOUBLE PRECISION,
    opt_idx_call_short DOUBLE PRECISION, opt_idx_put_short DOUBLE PRECISION,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (trade_date, kind, client_type))`);
  await dbExec(`CREATE TABLE IF NOT EXISTS nse_corporate_announcements (
    seq_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, company_name TEXT, category TEXT, summary TEXT,
    attachment_url TEXT, disseminated_at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL DEFAULT 'nse_api', fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await dbExec('DELETE FROM nse_fo_ban_list');
  await dbExec('DELETE FROM nse_participant_positions');
  await dbExec('DELETE FROM nse_corporate_announcements');
});

const ban = (d: string, s: string) => dbRun('INSERT INTO nse_fo_ban_list (trade_date, symbol) VALUES (?,?)', [d, s]);

describe('getFnoBanList', () => {
  it('returns only the newest stored trade date, as a plain date string', async () => {
    await ban('2026-11-25', 'OLDNAME');
    await ban('2026-11-26', 'MANAPPURAM');
    await ban('2026-11-26', 'APLAPOLLO');
    const r = await caller.getFnoBanList();
    expect(r.tradeDate).toBe('2026-11-26');
    expect(r.symbols).toEqual(['APLAPOLLO', 'MANAPPURAM']);
    expect(r.fetchedAt).toBeTruthy();
  });

  it('is empty, not an error, when nothing is stored', async () => {
    expect(await caller.getFnoBanList()).toEqual({ tradeDate: null, fetchedAt: null, symbols: [] });
  });
});

describe('getParticipantPositions', () => {
  const put = (d: string, kind: string, who: string, long: number | null, short: number) => dbRun(
    `INSERT INTO nse_participant_positions
       (trade_date, kind, client_type, fut_idx_long, fut_idx_short, fut_stk_long, fut_stk_short,
        opt_idx_call_long, opt_idx_call_short, opt_idx_put_long, opt_idx_put_short)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [d, kind, who, long, short, 500, 200, 90, 40, 30, 80]);

  it('reports net OI and the change against the previous stored session, without TOTAL or volume rows', async () => {
    await put('2026-11-24', 'oi', 'FII', 100, 300);
    await put('2026-11-25', 'oi', 'FII', 100, 400);
    await put('2026-11-25', 'oi', 'DII', null, 10);
    await put('2026-11-25', 'oi', 'TOTAL', 999, 999);
    await put('2026-11-25', 'vol', 'FII', 7, 7);
    const r = await caller.getParticipantPositions();
    expect([r.date, r.prevDate]).toEqual(['2026-11-25', '2026-11-24']);
    expect(r.rows.map(x => x.participant)).toEqual(['FII', 'DII']);
    expect(r.rows[0]).toMatchObject({
      idxFutNet: -300, idxFutNetChange: -100, idxFutLongPct: 20, stkFutNet: 300, idxCallNet: 50, idxPutNet: -50,
    });
    // A missing leg stays unknown; it must not read as a position of zero.
    expect(r.rows[1]).toMatchObject({ idxFutNet: null, idxFutNetChange: null, idxFutLongPct: null });
  });

  it('is empty when nothing is stored', async () => {
    expect(await caller.getParticipantPositions()).toEqual({ date: null, prevDate: null, fetchedAt: null, rows: [] });
  });
});

describe('getCompanyAnnouncements', () => {
  const put = (id: string, sym: string, at: string) => dbRun(
    'INSERT INTO nse_corporate_announcements (seq_id, symbol, category, disseminated_at) VALUES (?,?,?,?)',
    [id, sym, 'Credit Rating', at]);

  it('filters by symbol, newest first, and honours the limit', async () => {
    await put('1', 'TCS', '2026-11-20T10:00:00+05:30');
    await put('2', 'INFY', '2026-11-25T10:00:00+05:30');
    await put('3', 'TCS', '2026-11-24T10:00:00+05:30');
    expect((await caller.getCompanyAnnouncements({ symbol: 'tcs' })).map(r => r.seq_id)).toEqual(['3', '1']);
    expect((await caller.getCompanyAnnouncements({ limit: 2 })).map(r => r.seq_id)).toEqual(['2', '3']);
  });
});
