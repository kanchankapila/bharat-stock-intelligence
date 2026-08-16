/**
 * Async data-access facade. Postgres only.
 *
 * Exposes dbGet/dbAll/dbRun/dbExec/dbTransaction over the Postgres pool.
 *
 * This was a DUAL-mode facade until 2026-08-16 (SQLITE_DECOMMISSION_PLAN Phase 3): every
 * function branched on `usePostgres()` and fell back to better-sqlite3 against a local
 * database.sqlite. That arm is gone -- `usePostgres()` now returns true unconditionally, so it
 * was unreachable code that still looked like a supported path. The SQLite schema module it
 * imported has been RENAMED, not deleted, to src/server/db.sqlite-legacy.ts; nothing imports it.
 *
 * Notes for call sites:
 *   - Pass parameters as a positional array: dbAll(sql, [a, b]).
 *   - For an inserted id, add `RETURNING id` — dbRun surfaces it as lastInsertRowid.
 *   - `?` placeholders are still the convention; translateSql() converts them to $n.
 */
import { pgQuery, pgExecute, pgClient, pgEnsureColumns } from './pgClient';
import { translateSql } from './sqlTranslate';

// Run column guard once per process start. Idempotent — each ALTER uses IF NOT EXISTS.
pgEnsureColumns().catch(err =>
  console.error('[DB] pgEnsureColumns error (non-fatal):', (err as Error).message)
);

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DbTx {
  get<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
}

// ─── Top-level operations ─────────────────────────────────────────────────────

export async function dbGet<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await pgQuery<any>(translateSql(sql), params);
  return rows[0] as T | undefined;
}

export async function dbAll<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pgQuery<any>(translateSql(sql), params)) as T[];
}

export async function dbRun(sql: string, params: unknown[] = []): Promise<RunResult> {
  const res = await pgExecute(translateSql(sql), params);
  const lastId = (res.rows?.[res.rows.length - 1] as any)?.id ?? 0;
  return { changes: res.rowCount ?? 0, lastInsertRowid: lastId };
}

export async function dbExec(sql: string): Promise<void> {
  await pgExecute(translateSql(sql));
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function dbTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  const client = await pgClient();
  const tx: DbTx = {
    get: async (sql, params = []) => (await client.query(translateSql(sql), params as any[])).rows[0],
    all: async (sql, params = []) => (await client.query(translateSql(sql), params as any[])).rows,
    run: async (sql, params = []) => {
      const r = await client.query(translateSql(sql), params as any[]);
      return { changes: r.rowCount ?? 0, lastInsertRowid: (r.rows?.[0] as any)?.id ?? 0 };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
