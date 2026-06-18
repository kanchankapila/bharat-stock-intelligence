/**
 * PostgreSQL connection pool (Phase 3).
 *
 * Lazily creates a single shared pool from pgConfig. Only used when USE_POSTGRES is on;
 * the dbAsync facade routes here. Kept separate from the facade so the pool lifecycle
 * (and a health probe) lives in one place.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { pgConnectionString } from './pgConfig';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: pgConnectionString(),
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[PG] idle client error:', err.message));
  }
  return pool;
}

/** Run a parameterised query ($1,$2,...). Returns the full result rows. */
export async function pgQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as any[]);
  return res.rows;
}

/** Run a query and return the raw result (for rowCount / RETURNING handling). */
export async function pgExecute(text: string, params: unknown[] = []) {
  return getPool().query(text, params as any[]);
}

/** Acquire a client for an explicit transaction; caller MUST release. */
export async function pgClient(): Promise<PoolClient> {
  return getPool().connect();
}

export async function pgHealthy(): Promise<boolean> {
  try {
    await pgQuery('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
