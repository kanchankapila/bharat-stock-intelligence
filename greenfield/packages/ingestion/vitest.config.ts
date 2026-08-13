import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These tests hit a real local Postgres. Every individual query involved
    // is properly indexed and fast in isolation (verified via EXPLAIN
    // ANALYZE, 200-500ms) -- but pg_stat_activity caught the default 10s
    // hookTimeout tripping on genuine disk I/O wait (DataFileRead) on this
    // machine's local instance, not a slow plan. Not a logic bug; giving
    // real headroom for this box's I/O latency instead of chasing a query
    // that is already correct.
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});
