/**
 * Shared bulk-insert helpers for the async data-access facade (Phase 3).
 *
 * Multi-row INSERTs cut per-row round-trips dramatically on Postgres. Rows are
 * chunked to stay under PG's 65535 bind-parameter ceiling; `?` placeholders are
 * rewritten to $n positionally by the SQL translator.
 *
 * Callers MUST dedupe rows by their ON CONFLICT key beforehand — a single
 * multi-row upsert that touches the same key twice errors on Postgres
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time").
 */
import type { DbTx } from './dbAsync';

/** Build N placeholder groups "(?,?,…),(?,?,…)" for a `cols`-wide multi-row INSERT. */
export function rowGroups(rowCount: number, cols: number): string {
  const group = `(${Array(cols).fill('?').join(',')})`;
  return Array(rowCount).fill(group).join(',');
}

/**
 * Same as rowGroups but for groups that embed SQL literals, e.g.
 * `"(?, 'etnow', ?, ?, ?)"`. Pass the count of `?` placeholders in the pattern
 * (not the column count) as `cols` to bulkUpsert so chunking stays under the
 * bind-parameter ceiling.
 */
export function rowGroupsWith(rowCount: number, pattern: string): string {
  return Array(rowCount).fill(pattern).join(',');
}

/**
 * Run one multi-row upsert per chunk. `buildSql(rowCount)` receives the chunk's
 * row count and must embed `rowGroups(rowCount, cols)` in its VALUES clause.
 */
export async function bulkUpsert(
  tx: DbTx,
  rows: unknown[][],
  cols: number,
  buildSql: (rowCount: number) => string,
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = Math.max(1, Math.floor(60000 / cols));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    await tx.run(buildSql(slice.length), slice.flat());
  }
}
