/**
 * Dual-mode async data-access facade (Phase 3).
 *
 * Exposes a small async API (dbGet/dbAll/dbRun/dbExec/dbTransaction) that routes to
 * either better-sqlite3 (sync, wrapped in a resolved promise) or the Postgres pool,
 * selected by USE_POSTGRES. Call sites converted to this API keep working on SQLite
 * today; the SQLite->Postgres cutover is then a single env flip — no further code change.
 *
 * Conversion notes for P3e:
 *   - Pass parameters as a positional array: dbAll(sql, [a, b]).
 *   - For an inserted id on Postgres, add `RETURNING id` — dbRun surfaces it as lastInsertRowid.
 *   - SQLite-only SQL (INSERT OR REPLACE, strftime) must be hand-converted; see sqlTranslate.ts.
 */
import sqliteDb from './db';
import { usePostgres } from './pgConfig';
import { pgQuery, pgExecute, pgClient, pgEnsureColumns } from './pgClient';
import { translateSql } from './sqlTranslate';

const usePg = () => usePostgres();

// Run column guard once per process start when Postgres is active.
// Idempotent — each ALTER uses IF NOT EXISTS.
if (usePostgres()) {
  pgEnsureColumns().catch(err =>
    console.error('[DB] pgEnsureColumns error (non-fatal):', (err as Error).message)
  );
}

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
  if (usePg()) {
    const rows = await pgQuery<any>(translateSql(sql), params);
    return rows[0] as T | undefined;
  }
  return sqliteDb.prepare(sql).get(...params) as T | undefined;
}

export async function dbAll<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (usePg()) {
    return (await pgQuery<any>(translateSql(sql), params)) as T[];
  }
  return sqliteDb.prepare(sql).all(...params) as T[];
}

export async function dbRun(sql: string, params: unknown[] = []): Promise<RunResult> {
  if (usePg()) {
    const res = await pgExecute(translateSql(sql), params);
    const lastId = (res.rows?.[res.rows.length - 1] as any)?.id ?? 0;
    return { changes: res.rowCount ?? 0, lastInsertRowid: lastId };
  }
  // better-sqlite3 throws if you .run() a statement that returns data (e.g. RETURNING),
  // so branch on `.reader` and read the RETURNING row's id as lastInsertRowid — giving
  // the same {changes,lastInsertRowid} contract on both engines.
  const stmt = sqliteDb.prepare(sql);
  if (stmt.reader) {
    const rows = stmt.all(...params) as any[];
    const last = rows.length ? (rows[rows.length - 1]?.id ?? 0) : 0;
    return { changes: rows.length, lastInsertRowid: last };
  }
  const info = stmt.run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

export async function dbExec(sql: string): Promise<void> {
  if (usePg()) {
    await pgExecute(translateSql(sql));
    return;
  }
  sqliteDb.exec(sql);
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function dbTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  if (usePg()) {
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

  // SQLite path: single connection, manual BEGIN/COMMIT so the fn can stay async.
  const tx: DbTx = {
    get: async (sql, params = []) => sqliteDb.prepare(sql).get(...params) as any,
    all: async (sql, params = []) => sqliteDb.prepare(sql).all(...params) as any[],
    run: async (sql, params = []) => {
      const info = sqliteDb.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
  sqliteDb.exec('BEGIN');
  try {
    const result = await fn(tx);
    sqliteDb.exec('COMMIT');
    return result;
  } catch (err) {
    try { sqliteDb.exec('ROLLBACK'); } catch { /* no active tx */ }
    throw err;
  }
}
