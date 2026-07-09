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
 * The cutover switch. STRICTLY gated on USE_POSTGRES === 'true' — NOT on the mere
 * presence of POSTGRES_URL, which is set in .env for the migration tooling while the
 * running app must stay on SQLite until the explicit cutover.
 */
export function usePostgres(): boolean {
  return process.env.USE_POSTGRES === 'true';
}

/** Whether Postgres connection info exists (for tooling/health checks, not for routing). */
export function isPostgresConfigured(): boolean {
  return Boolean(process.env.POSTGRES_URL || process.env.POSTGRES_HOST);
}
