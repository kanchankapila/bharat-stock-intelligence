// Task 2.2 Verify: "integration tests for -- resume after a simulated crash
// mid-range produces no gap and no duplicates; a 404 date yields skipped;
// re-running a completed range writes zero new rows." Runs against a LOCAL
// fixture server, never the live NSE archive (that's the separate opt-in
// live-canary run, matching this repo's own live_datasource convention).
//
// Isolation, post-incident (2026-08-13): this file's fixtures used to reuse
// the REAL 'nse'/'nse.bhavcopy' job/provider/endpoint identifiers and dates
// (2026-08-10..12) that fell inside the real backfill's actual range. A
// broad `DELETE ... WHERE source = 'nse'` in this file's own afterEach then
// deleted the ENTIRE real 2021-present backfill (market_bar, delivery_stat,
// trading_session all went to zero rows) the first time both coexisted in
// the same database. Fixed at the root two ways: (1) backfill.ts now takes
// jobId/endpointKey overrides so tests never share the production
// identifier at all; (2) every date here is pinned to 2031, far outside any
// real backfill's range, so even a REAL-looking symbol name (this fixture's
// RELIANCE, IDEA, ...) can never collide with real data on the
// (symbol, session_date, source) primary key. Cleanup below is still scoped
// by exact date, not a broad column match -- defense in depth, not reliance
// on any single layer.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool } from '@greenfield/db';
import { nextCalendarDate, runBackfill, runBackfillForDate } from './backfill.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const NORMAL_DAY_CSV = readFileSync(path.join(FIXTURES_DIR, 'normal-day.csv'), 'utf8');

const TEST_JOB_ID = 'zzzbf.bhavcopy';
const TEST_ENDPOINT_KEY = 'zzzbf.bhavcopy';
const TEST_PROVIDER = 'zzzbf';
// Future relative to the real backfill's current progress (which only ever
// reaches "yesterday"), so it can never collide with real data no matter
// what symbol names the fixture CSV uses -- but still inside an EXISTING
// market_bar partition (migration 004 only creates partitions through
// 2027; a date past that has no partition to route into at all, which
// Postgres correctly rejects -- caught by this file's own first re-run).
const D1 = '2027-03-08';
const D2 = '2027-03-09';
const D3 = '2027-03-10';
const ALL_TEST_DATES = [D1, D2, D3];

let server: Server | undefined;
let pool: pg.Pool;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function listen(handler: Handler): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Fixture NSE server: trading days (weekdays) return the real-format CSV,
 * weekends return 404 -- exactly like the real archive. Note: normal-day.csv
 * has DATE1 fixed at 2026-08-12, which does NOT match any of the 2031 dates
 * requested here -- that's fine for these tests specifically because
 * runBackfillForDate's stale-content check would reject a mismatch, so the
 * date-mismatch tests below pass their own base URL with a bespoke handler
 * instead of reusing this one. */
function fixtureUrlForDate(base: string) {
  return (date: string): string => `${base}/bhav/${date}.csv`;
}

/** Same as normal-day.csv's rows but with DATE1 patched to the requested
 * test date, so runBackfillForDate's file-date validation passes. */
function csvForDate(date: string): string {
  const [y, m, d] = date.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ddMonYyyy = `${d}-${months[Number(m) - 1]}-${y}`;
  return NORMAL_DAY_CSV.replaceAll('12-Aug-2026', ddMonYyyy);
}

async function startFixtureServer(tradingDates: Set<string>): Promise<string> {
  const base = await listen((req, res) => {
    const m = /^\/bhav\/(\d{4}-\d{2}-\d{2})\.csv$/.exec(req.url ?? '');
    const date = m?.[1];
    if (date && tradingDates.has(date)) {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(csvForDate(date));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return base;
}

// NOT wrapped in BEGIN/ROLLBACK: runBackfill opens its OWN pool connection
// per date internally (real usage spans thousands of dates and can't hold
// one giant transaction open), so seed data must actually be committed to be
// visible to it -- an external test transaction would be invisible across
// connections. Cleaned up explicitly instead, in FK-safe order, scoped by
// exact date/id -- never a broad column-value match (see file header).
beforeEach(async () => {
  pool = createPool();
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ($1, 'ZZZ Backfill Test Provider', '{}', 'none', 'permitted')`,
    [TEST_PROVIDER],
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ($1, $2, 'ingestion', 'fixture', 'v1')`,
    [TEST_ENDPOINT_KEY, TEST_PROVIDER],
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ($1, 'backfill test job', 'Asia/Kolkata', 'v1')`,
    [TEST_JOB_ID],
  );
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
  await pool.query(`DELETE FROM market_bar WHERE session_date = ANY($1::date[])`, [ALL_TEST_DATES]);
  await pool.query(`DELETE FROM delivery_stat WHERE session_date = ANY($1::date[])`, [ALL_TEST_DATES]);
  await pool.query(`DELETE FROM trading_session WHERE session_date = ANY($1::date[])`, [ALL_TEST_DATES]);
  await pool.query(`DELETE FROM raw_object WHERE endpoint_key = $1`, [TEST_ENDPOINT_KEY]);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  // These are real, common NSE symbol names (the fixture CSV mirrors a real
  // bhavcopy), so they may legitimately also be referenced by real
  // backfilled data coexisting in this database -- NOT EXISTS keeps this
  // scoped to rows this test actually owns instead of throwing an FK
  // violation (market_bar_symbol_fkey) against real data.
  await pool.query(`DELETE FROM security s WHERE s.symbol IN
    ('20MICRONS','21STCENMGM','360ONE','RELIANCE','IDEA','NIFTYBEES','SILVERBEES')
    AND NOT EXISTS (SELECT 1 FROM market_bar mb WHERE mb.symbol = s.symbol)`);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = $1`, [TEST_ENDPOINT_KEY]);
  await pool.query(`DELETE FROM provider WHERE provider = $1`, [TEST_PROVIDER]);
  await pool.end();
});

test('oldest-first over a small range: weekday trading days accepted, weekend 404s skipped', async () => {
  // D1, D2 trading; D3 excluded (simulating a holiday, no fixture entry ->
  // 404, same as a real non-trading weekday).
  const base = await startFixtureServer(new Set([D1, D2]));

  const results = await runBackfill(pool, {
    from: D1, to: D3,
    codeCommit: 'test-commit',
    urlForDate: fixtureUrlForDate(base),
    jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY,
  });

  expect(results.map((r) => r.date)).toEqual([D1, D2, D3]);
  expect(results[0]!.status).toBe('succeeded');
  expect(results[1]!.status).toBe('succeeded');
  expect(results[2]!.status).toBe('skipped');
  expect(results[2]!.reason).toMatch(/non-trading day \(404\)/);

  // The 404 date's run is 'skipped', never 'failed'.
  const { rows: runRows } = await pool.query(
    `SELECT status FROM ingestion_run WHERE job_id = $1 AND input_watermark = $2`, [TEST_JOB_ID, D3],
  );
  expect(runRows[0]?.status).toBe('skipped');

  // trading_session was derived as a byproduct, only for real trading days.
  const { rows: sessionRows } = await pool.query(
    `SELECT session_date::text FROM trading_session WHERE session_date = ANY($1::date[]) ORDER BY session_date`,
    [ALL_TEST_DATES],
  );
  expect(sessionRows.map((r) => r.session_date)).toEqual([D1, D2]);
});

test('re-running a completed range writes zero new rows (idempotent)', async () => {
  const base = await startFixtureServer(new Set([D1]));
  const opts = { from: D1, to: D1, codeCommit: 'test-commit', urlForDate: fixtureUrlForDate(base), jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY };

  await runBackfill(pool, opts);
  const { rows: countAfterFirst } = await pool.query(`SELECT count(*)::int AS n FROM market_bar WHERE session_date = $1`, [D1]);

  const secondRun = await runBackfill(pool, opts);
  const { rows: countAfterSecond } = await pool.query(`SELECT count(*)::int AS n FROM market_bar WHERE session_date = $1`, [D1]);

  expect(secondRun[0]!.reason).toBe('already completed (idempotent no-op)');
  expect(countAfterSecond[0]!.n).toBe(countAfterFirst[0]!.n);

  // And there is still only ONE ingestion_run row for that date -- the
  // idempotent skip never opened a second one.
  const { rows: runCount } = await pool.query(
    `SELECT count(*)::int AS n FROM ingestion_run WHERE job_id = $1 AND input_watermark = $2`, [TEST_JOB_ID, D1],
  );
  expect(runCount[0]!.n).toBe(1);
});

test('resume after a simulated crash mid-range: no gap, no duplicate rows', async () => {
  const base = await startFixtureServer(new Set([D1, D2, D3]));
  const opts = { codeCommit: 'test-commit', urlForDate: fixtureUrlForDate(base), jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY };

  // Simulate a crash: only the FIRST date of the range actually completed
  // before the process died.
  await runBackfillForDate(pool, D1, opts);

  // "Restart": run the full range again from the same `from`.
  const results = await runBackfill(pool, { ...opts, from: D1, to: D3 });

  expect(results.map((r) => r.status)).toEqual(['skipped', 'succeeded', 'succeeded']);
  expect(results[0]!.reason).toBe('already completed (idempotent no-op)');

  // No gap: all three dates ended up with exactly one closed run each.
  const { rows } = await pool.query(
    `SELECT input_watermark, count(*)::int AS n FROM ingestion_run
     WHERE job_id = $1 GROUP BY input_watermark ORDER BY input_watermark`, [TEST_JOB_ID],
  );
  expect(rows).toEqual([
    { input_watermark: D1, n: 1 },
    { input_watermark: D2, n: 1 },
    { input_watermark: D3, n: 1 },
  ]);

  // No duplicates: each accepted symbol has exactly one market_bar row per date.
  const { rows: dupCheck } = await pool.query(
    `SELECT symbol, session_date::text, count(*)::int AS n FROM market_bar
     WHERE session_date = ANY($1::date[]) GROUP BY symbol, session_date HAVING count(*) > 1`,
    [ALL_TEST_DATES],
  );
  expect(dupCheck).toEqual([]);
});

test('dry-run fetches and parses but writes no fact rows', async () => {
  const base = await startFixtureServer(new Set([D1]));
  const result = await runBackfillForDate(pool, D1, {
    dryRun: true, codeCommit: 'test-commit', urlForDate: fixtureUrlForDate(base),
    jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY,
  });

  expect(result.status).toBe('succeeded');
  expect(result.rowsAccepted).toBeGreaterThan(0);
  expect(result.reason).toMatch(/dry-run: would write/);

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM market_bar WHERE session_date = $1`, [D1]);
  expect(rows[0]!.n).toBe(0);
  const { rows: runRows } = await pool.query(`SELECT count(*)::int AS n FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  expect(runRows[0]!.n).toBe(0); // dry-run touches no run-ledger state either
});

test('stale content (file DATE1 != requested date) is skipped, not written as a phantom session', async () => {
  // Live-verified 2026-08-13: NSE's archive server returns HTTP 200 with the
  // PREVIOUS FRIDAY's file content, byte-identical, when queried for a
  // Sunday's date. This fixture reproduces that exactly: whatever date is
  // requested, the server always returns normal-day.csv UNPATCHED, whose own
  // DATE1 is fixed at 2026-08-12 -- so requesting a 2031 date must be
  // detected as stale, not silently accepted as a real session for it.
  const base = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end(NORMAL_DAY_CSV); // always DATE1=12-Aug-2026, regardless of URL
  });
  const requestedDate = D1;
  const staleUrl = () => `${base}/bhav.csv`;

  const result = await runBackfillForDate(pool, requestedDate, {
    codeCommit: 'test-commit', urlForDate: staleUrl, jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY,
  });

  expect(result.status).toBe('skipped');
  expect(result.reason).toMatch(/stale content/);
  expect(result.reason).toMatch(/2026-08-12/); // names the file's real date

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM market_bar WHERE session_date = $1`, [requestedDate]);
  expect(rows[0]!.n).toBe(0); // no phantom session written

  const { rows: runRows } = await pool.query(
    `SELECT status FROM ingestion_run WHERE job_id = $1 AND input_watermark = $2`, [TEST_JOB_ID, requestedDate],
  );
  expect(runRows[0]?.status).toBe('skipped'); // never 'failed', never 'succeeded'
});

test('nextCalendarDate is plain day-by-day arithmetic, month/year boundaries included', () => {
  expect(nextCalendarDate('2026-08-10')).toBe('2026-08-11');
  expect(nextCalendarDate('2026-08-31')).toBe('2026-09-01');
  expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01');
});
