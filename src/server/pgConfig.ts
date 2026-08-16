/**
 * PostgreSQL / TimescaleDB connection config (Phase 3).
 *
 * Mirrors redisConfig: env-driven with dev fallbacks. Nothing in the app imports a pg
 * client yet — the data-access layer is wired in a later Phase 3 sub-phase. This module
 * exists so the connection string lives in exactly one place from the start.
 *
 * Set in .env:
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB
 *   (or a single POSTGRES_URL, which takes precedence)
 */

export const PG_CONFIG = {
  host:     process.env.POSTGRES_HOST     || '127.0.0.1',
  port:     parseInt(process.env.POSTGRES_PORT || '5433', 10),
  user:     process.env.POSTGRES_USER     || 'bharat',
  password: process.env.POSTGRES_PASSWORD || 'bharat',
  database: process.env.POSTGRES_DB       || 'bharat_intel',
} as const;

export function pgConnectionString(): string {
  if (process.env.POSTGRES_URL) return process.env.POSTGRES_URL;
  const { host, port, user, password, database } = PG_CONFIG;
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/**
 * The vitest suite's private, throwaway Postgres schema, or null outside the suite.
 *
 * Set by `vitest.globalSetup.ts` (which creates the schema, applies db/schema.postgres.sql into
 * it, and drops it CASCADE afterwards) and read by `pgClient.getPool()`, which pins every pooled
 * connection's `search_path` to it. This is the TypeScript mirror of the Python side's
 * `pg_schema`/`pg_conn` fixtures in `src/server/tests/conftest.py` -- same guarantee, same
 * reason: a test pointed at Postgres WITHOUT a private schema is pointed at LIVE PRODUCTION.
 *
 * The name is deliberately NOT `USE_POSTGRES`-shaped and is never read from `.env`. `.env` sets
 * `USE_POSTGRES=true`, and every `*.live.test.ts` file loads `dotenv/config`; with
 * `pool: 'forks', singleFork: true` that mutates one shared `process.env` for the whole run, so
 * the OLD env-var rule made a test's target database depend on FILE EXECUTION ORDER. Measured
 * 2026-08-16: that wrote 2,148 fabricated Saturday bars into production `stock_ohlcv`, and made
 * `deliveryFetcher.live` fail against empty SQLite in one run and pass against production in the
 * next, minutes apart. See the memory entry `live-tests-hit-production-postgres-2026-08-16`.
 */
export function vitestSchema(): string | null {
  return process.env.VITEST_PG_SCHEMA || null;
}

/**
 * PostgreSQL IS the database. This is no longer a switch.
 *
 * It used to be `process.env.USE_POSTGRES === 'true'` — a cutover flag from the SQLite era.
 * That default was the wrong way round and it cost this project repeatedly, because the
 * failure is SILENT: any process that did not happen to load `.env` resolved to `false` and
 * talked to a stale local `database.sqlite` while printing entirely convincing numbers.
 * Recorded instances:
 *   - A standalone `tsx` script missing `import 'dotenv/config'` reported 121,669
 *     screener_appearances rows for Trendlyne with 26 carrying a new column. Postgres actually
 *     held 435,700 and 0. It even resolved a different screenpk for the same screener.
 *     (`.claude/rules/recurring-bugs.md`, Environment & deploy.)
 *   - `infra_gotchas` memory recorded "AlphaQuant writing SQLite" for months; it never was —
 *     two dead `sqlite:///`-forcing lines made it look that way (deleted 2026-08-15).
 *   - The local `database.sqlite` is 3.49 GB and ~2 months stale on the canonical tables
 *     (`unified_recommendations` 2026-06-19 vs 2026-08-17 live), so a silent fallback does not
 *     fail — it answers, wrongly.
 *
 * Now: Postgres unconditionally for every REAL process — dev, prod, cron, hand-run script —
 * with no environment variable consulted at all. A missing or unloaded `.env` can no longer
 * reroute a process to a different database; the worst it can do is fail to connect, loudly.
 *
 * **`USE_POSTGRES` is no longer read anywhere, including inside the test runner (2026-08-16).**
 * The test-runner branch used to be `process.env.USE_POSTGRES === 'true'`, on the reasoning that
 * `VITEST` is runner-owned and `.env` cannot forge it. True, but it missed the second half: every
 * `*.live.test.ts` file calls `await import('dotenv/config')`, `.env` sets `USE_POSTGRES=true`,
 * and `pool: 'forks', singleFork: true` means one shared `process.env` for the entire run. So the
 * FIRST live file to load dotenv silently flipped every test collected after it onto production
 * Postgres. Measured 2026-08-16: 2,148 fabricated Saturday `stock_ohlcv` bars written to
 * production, and `deliveryFetcher.live` failing against empty SQLite in one run and passing
 * against production in the next. A test's target database must not depend on file execution
 * order.
 *
 * Now: Postgres unconditionally, everywhere. Inside the vitest `unit` project that means the
 * private throwaway schema `vitest.globalSetup.ts` creates (see `vitestSchema()`); inside the
 * `live` project and every real process it means the real database. There is no SQLite branch
 * left to fall into and no variable that can select one.
 *
 * Pinned by `src/server/__tests__/postgresOnly.test.ts` and the Python mirror
 * `src/server/tests/test_sql_translate.py` — keep the two rules identical.
 */
export function usePostgres(): boolean {
  return true;
}

/** Whether Postgres connection info exists (for tooling/health checks, not for routing). */
export function isPostgresConfigured(): boolean {
  return Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_HOST);
}
