import { dbGet } from './dbAsync';

// Shared TTL-cached MAX(computed_at) probe for batch-written tables — one copy instead of the
// four divergent per-router copies it consolidates (commandCenter/misc/scoring/confluence,
// 2026-09-02). CAST to TEXT on purpose: the value is bound back into `computed_at = ?`
// equality joins, and TEXT preserves the stored precision, where a JS Date round-trip
// truncates to milliseconds.
//
// TTL, not invalidate-on-write (trpc-surface-review, 2026-08-14): the real producers are
// BullMQ jobs (unified_ranker's schedule, confluence-compute) that never call the admin-only
// refresh mutations these probes originally relied on for invalidation. A stale cached value
// makes those equality joins filter rows out silently rather than erroring, so the TTL is the
// staleness bound, not a nicety.
const TTL_MS = 5 * 60_000;

export type ComputedAtTable = 'unified_recommendations' | 'confluence_signals';

const cache = new Map<ComputedAtTable, { value: string | null; expires: number }>();

export async function latestComputedAt(table: ComputedAtTable): Promise<string | null> {
  const hit = cache.get(table);
  if (hit && Date.now() <= hit.expires) return hit.value;
  const row = await dbGet<{ ts: string | null }>(`SELECT CAST(MAX(computed_at) AS TEXT) AS ts FROM ${table}`);
  const value = row?.ts ?? null;
  // A NULL probe result is deliberately NOT cached: until a table's first row lands (cold
  // start), every call must re-probe, matching the original per-router copies' `!cached`
  // guard. Caching null here broke commandCenter.test.ts's empty-then-populated sequence.
  if (value !== null) cache.set(table, { value, expires: Date.now() + TTL_MS });
  return value;
}

export function invalidateLatestComputedAt(table: ComputedAtTable): void {
  cache.delete(table);
}
