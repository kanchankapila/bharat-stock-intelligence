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
 * Inside a test runner the historical env-based rule still applies (SQLite unless
 * `USE_POSTGRES=true`). `VITEST` is set by vitest itself and cannot be supplied by `.env`, so
 * the escape hatch is unreachable outside the suite. This direction is deliberate: most test
 * files build a throwaway SQLite fixture and never set the variable, so defaulting THEM to
 * Postgres would point the suite at the live production database — briefly tried 2026-08-15
 * on the Python side and immediately visible as a 115s → 600s+ suite (it wrote nothing, but
 * that is not a thing to rely on twice).
 *
 * So the variable survives in exactly one place: choosing a fixture inside a test runner. It
 * can no longer decide which database a real process talks to. `docs/SQLITE_DECOMMISSION_PLAN.md`
 * Phase 2 removes even that by moving the suites onto Postgres, after which this is `return true`.
 *
 * Pinned by `src/server/__tests__/postgresOnly.test.ts` and the Python mirror
 * `src/server/tests/test_sql_translate.py` — keep the two rules identical.
 */
export function usePostgres(): boolean {
  if (process.env.VITEST) return process.env.USE_POSTGRES === 'true';
  return true;
}

/** Whether Postgres connection info exists (for tooling/health checks, not for routing). */
export function isPostgresConfigured(): boolean {
  return Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_HOST);
}
