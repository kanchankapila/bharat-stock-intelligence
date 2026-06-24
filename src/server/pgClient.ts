/**
 * PostgreSQL connection pool (Phase 3).
 *
 * Lazily creates a single shared pool from pgConfig. Only used when USE_POSTGRES is on;
 * the dbAsync facade routes here. Kept separate from the facade so the pool lifecycle
 * (and a health probe) lives in one place.
 */
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { pgConnectionString } from './pgConfig';

// Parse Postgres BIGINT (INT8) as JavaScript numbers (safe up to 2^53 - 1)
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

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

/** True for transient pool/socket errors where the query never reached the server. */
function isTransientConnError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  return /connection terminated|connection timeout|ECONNRESET|ETIMEDOUT|Client has encountered a connection error|server closed the connection/i.test(
    msg,
  );
}

/**
 * Run a parameterised query ($1,$2,...). Returns the full result rows.
 *
 * Read-only path (backs dbGet/dbAll). At market-open bursts the shared Postgres
 * (max_connections=50, split across all PM2 services + spawned Python) can briefly
 * refuse a new connection, surfacing as "Connection terminated". Retry once on those
 * transient errors only — safe here because SELECTs are idempotent.
 */
export async function pgQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const res = await getPool().query<T>(text, params as any[]);
    return res.rows;
  } catch (err) {
    if (!isTransientConnError(err)) throw err;
    await new Promise((r) => setTimeout(r, 250));
    const res = await getPool().query<T>(text, params as any[]);
    return res.rows;
  }
}

/** Run a query and return the raw result (for rowCount / RETURNING handling). */
export async function pgExecute(text: string, params: unknown[] = []) {
  return getPool().query(text, params as any[]);
}

/** Acquire a client for an explicit transaction; caller MUST release. */
export async function pgClient(): Promise<PoolClient> {
  return getPool().connect();
}

/**
 * Acquire a client, run `fn`, and release unconditionally.
 * Prefer this over the raw `pgClient()` export for all explicit transactions.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
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
