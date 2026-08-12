// Task 2.2 Verify: "integration tests for -- resume after a simulated crash
// mid-range produces no gap and no duplicates; a 404 date yields skipped;
// re-running a completed range writes zero new rows." Runs against a LOCAL
// fixture server, never the live NSE archive (that's the separate opt-in
// live-canary run, matching this repo's own live_datasource convention).
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
 * weekends return 404 -- exactly like the real archive. */
function fixtureUrlForDate(base: string) {
  return (date: string): string => `${base}/bhav/${date}.csv`;
}

async function startFixtureServer(tradingDates: Set<string>): Promise<string> {
  const base = await listen((req, res) => {
    const m = /^\/bhav\/(\d{4}-\d{2}-\d{2})\.csv$/.exec(req.url ?? '');
    const date = m?.[1];
    if (date && tradingDates.has(date)) {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(NORMAL_DAY_CSV);
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
// connections. Cleaned up explicitly instead, in FK-safe order.
beforeEach(async () => {
  pool = createPool();
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ('nse', 'NSE Archives', '{}', 'none', 'permitted')`,
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ('nse.bhavcopy', 'nse', 'ingestion', 'fixture', 'v1')`,
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('nse.bhavcopy', 'backfill test job', 'Asia/Kolkata', 'v1')`,
  );
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
  await pool.query(`DELETE FROM market_bar WHERE source = 'nse'`);
  await pool.query(`DELETE FROM delivery_stat WHERE source = 'nse'`);
  await pool.query(`DELETE FROM trading_session WHERE exchange = 'NSE'`);
  await pool.query(`DELETE FROM raw_object WHERE endpoint_key = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM security WHERE symbol IN
    ('20MICRONS','21STCENMGM','360ONE','RELIANCE','IDEA','NIFTYBEES','SILVERBEES')`);
  await pool.query(`DELETE FROM job_definition WHERE job_id = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM provider WHERE provider = 'nse'`);
  await pool.end();
});

test('oldest-first over a small range: weekday trading days accepted, weekend 404s skipped', async () => {
  // 2026-08-10 Mon, 11 Tue trading; 12 Wed excluded (simulating a holiday, no
  // fixture entry -> 404, same as a real non-trading weekday).
  const base = await startFixtureServer(new Set(['2026-08-10', '2026-08-11']));

  const results = await runBackfill(pool, {
    from: '2026-08-10', to: '2026-08-12',
    codeCommit: 'test-commit',
    urlForDate: fixtureUrlForDate(base),
  });

  expect(results.map((r) => r.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  expect(results[0]!.status).toBe('succeeded');
  expect(results[1]!.status).toBe('succeeded');
  expect(results[2]!.status).toBe('skipped');
  expect(results[2]!.reason).toMatch(/non-trading day \(404\)/);

  // The 404 date's run is 'skipped', never 'failed'.
  const { rows: runRows } = await pool.query(
    `SELECT status FROM ingestion_run WHERE job_id = 'nse.bhavcopy' AND input_watermark = '2026-08-12'`,
  );
  expect(runRows[0]?.status).toBe('skipped');

  // trading_session was derived as a byproduct, only for real trading days.
  const { rows: sessionRows } = await pool.query(
    `SELECT session_date::text FROM trading_session WHERE exchange = 'NSE' ORDER BY session_date`,
  );
  expect(sessionRows.map((r) => r.session_date)).toEqual(['2026-08-10', '2026-08-11']);
});

test('re-running a completed range writes zero new rows (idempotent)', async () => {
  const base = await startFixtureServer(new Set(['2026-08-10']));
  const opts = { from: '2026-08-10', to: '2026-08-10', codeCommit: 'test-commit', urlForDate: fixtureUrlForDate(base) };

  await runBackfill(pool, opts);
  const { rows: countAfterFirst } = await pool.query(`SELECT count(*)::int AS n FROM market_bar`);

  const secondRun = await runBackfill(pool, opts);
  const { rows: countAfterSecond } = await pool.query(`SELECT count(*)::int AS n FROM market_bar`);

  expect(secondRun[0]!.reason).toBe('already completed (idempotent no-op)');
  expect(countAfterSecond[0]!.n).toBe(countAfterFirst[0]!.n);

  // And there is still only ONE ingestion_run row for that date -- the
  // idempotent skip never opened a second one.
  const { rows: runCount } = await pool.query(
    `SELECT count(*)::int AS n FROM ingestion_run WHERE job_id = 'nse.bhavcopy' AND input_watermark = '2026-08-10'`,
  );
  expect(runCount[0]!.n).toBe(1);
});

test('resume after a simulated crash mid-range: no gap, no duplicate rows', async () => {
  const base = await startFixtureServer(new Set(['2026-08-10', '2026-08-11', '2026-08-12']));
  const opts = { codeCommit: 'test-commit', urlForDate: fixtureUrlForDate(base) };

  // Simulate a crash: only the FIRST date of the range actually completed
  // before the process died.
  await runBackfillForDate(pool, '2026-08-10', opts);

  // "Restart": run the full range again from the same `from`.
  const results = await runBackfill(pool, { ...opts, from: '2026-08-10', to: '2026-08-12' });

  expect(results.map((r) => r.status)).toEqual(['skipped', 'succeeded', 'succeeded']);
  expect(results[0]!.reason).toBe('already completed (idempotent no-op)');

  // No gap: all three dates ended up with exactly one closed run each.
  const { rows } = await pool.query(
    `SELECT input_watermark, count(*)::int AS n FROM ingestion_run
     WHERE job_id = 'nse.bhavcopy' GROUP BY input_watermark ORDER BY input_watermark`,
  );
  expect(rows).toEqual([
    { input_watermark: '2026-08-10', n: 1 },
    { input_watermark: '2026-08-11', n: 1 },
    { input_watermark: '2026-08-12', n: 1 },
  ]);

  // No duplicates: each accepted symbol has exactly one market_bar row per date.
  const { rows: dupCheck } = await pool.query(
    `SELECT symbol, session_date::text, count(*)::int AS n FROM market_bar
     GROUP BY symbol, session_date HAVING count(*) > 1`,
  );
  expect(dupCheck).toEqual([]);
});

test('dry-run fetches and parses but writes no fact rows', async () => {
  const base = await startFixtureServer(new Set(['2026-08-10']));
  const result = await runBackfillForDate(pool, '2026-08-10', {
    dryRun: true, codeCommit: 'test-commit', urlForDate: fixtureUrlForDate(base),
  });

  expect(result.status).toBe('succeeded');
  expect(result.rowsAccepted).toBeGreaterThan(0);
  expect(result.reason).toMatch(/dry-run: would write/);

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM market_bar`);
  expect(rows[0]!.n).toBe(0);
  const { rows: runRows } = await pool.query(`SELECT count(*)::int AS n FROM ingestion_run`);
  expect(runRows[0]!.n).toBe(0); // dry-run touches no run-ledger state either
});

test('nextCalendarDate is plain day-by-day arithmetic, month/year boundaries included', () => {
  expect(nextCalendarDate('2026-08-10')).toBe('2026-08-11');
  expect(nextCalendarDate('2026-08-31')).toBe('2026-09-01');
  expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01');
});
