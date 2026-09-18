/**
 * Shared cache-key constants.
 *
 * These exist so that a PRODUCER (a background job that refreshes a table) and a CONSUMER (a
 * tRPC route that caches a read of that table) cannot drift apart on the key. That drift is
 * silent by construction: if the two spell the prefix differently nothing errors, the job
 * simply invalidates a key nobody reads, and the route keeps serving stale data until its TTL
 * lapses. Keeping the literal in one place makes the contract checkable.
 *
 * Deliberately dependency-free — importable from both routers and job modules without pulling
 * tRPC/BullMQ into either side, which would risk an import cycle.
 */

/**
 * Prefix for `getFiledCorporateActionsCalendar`'s cached reads of
 * `nse_filed_corporate_actions` (see fundamentals.router.ts).
 *
 * The full key appends the query's input parameters:
 *   `fund:filed-corp-actions:${daysBack}:${daysForward}:${symbol ?? ''}`
 *
 * Refreshed daily by `investsights_corporate_actions_fetcher.py`, which invalidates this
 * prefix via `cacheDelPrefix` once it has written. Keep the two ends in sync through this
 * constant rather than by retyping the string.
 */
export const FILED_CORP_ACTIONS_CACHE_PREFIX = 'fund:filed-corp-actions:';
