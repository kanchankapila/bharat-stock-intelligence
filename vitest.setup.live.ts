// LIVE-PROJECT-ONLY setup, layered on top of the shared vitest.setup.ts.
//
// Root cause (found 2026-08-28 while deep-diagnosing 3 "live_datasource" test failures that
// turned out not to be real upstream problems): vitest.globalSetup.ts's setup() runs in the
// shared vitest ORCHESTRATOR process (that's how globalSetup always works — it is not per
// forked worker) and does `process.env.VITEST_PG_SCHEMA = schema` there, scoped to the `unit`
// project only per its own docstring. But a forked child process inherits its parent's env by
// default, and vitest spawns every project's fork from that same orchestrator process — so
// whenever `unit` and `live` run in the SAME `vitest run` invocation (exactly what CLAUDE.md's
// own gate command, a bare `npx vitest run`, does), the `live` project's fork ALSO receives
// VITEST_PG_SCHEMA, even though `live`'s config has no globalSetup of its own and pgClient.ts's
// getPool() has no way to tell the two projects apart — it just reads the env var. That silently
// repoints every *.live.test.ts file's Postgres pool at the `unit` project's ephemeral,
// schema.postgres.sql-only (no rows, unless a concurrently-running unit test happens to insert
// a fixture into the exact same table) throwaway schema instead of real production, for the
// WHOLE run.
//
// Two confirmed, reproduced-twice symptoms of exactly this, not two unrelated bugs:
//   - etMarketstats.live.test.ts's beforeAll threw "et_marketstats_screeners is empty" even
//     though production has 95 real rows (confirmed via a direct, unmocked connection) — it was
//     empty in the *throwaway* schema, which no unit test happens to seed.
//   - trendlyneScreener.live.test.ts and etnow.live.test.ts's beforeAll each picked up literal
//     fixture rows ('TL Test Screener'/screenpk 'tlpk430', 'ET Test Screener'/query_condition
//     '{}') written by trendlyneScreenerListIds.test.ts's `unit`-project beforeEach — production
//     never received those inserts (checked immediately after, in both the leaked and isolated
//     runs) — and then made a REAL network call to Trendlyne/ETnow with that bogus, leaked value,
//     which the real upstream API correctly rejected. The resulting "API error"/"Unexpected
//     response format" read exactly like a genuine upstream problem and would have sent anyone
//     chasing it down the wrong path (WAF blocking, a parser bug) without ever finding the actual
//     cause: the request itself was garbage before it left this process.
//
// Deleting (not blanking to '') both vars here, in this project-scoped setupFile, keeps the
// `unit` project's own isolation completely untouched (its own forked process still gets a real,
// unleaked VITEST_PG_SCHEMA from the orchestrator) while guaranteeing every `live` project test
// file — whose whole job, per data-sources.md, is to prove a fetcher writes "genuine, correct
// production data, not test fixture pollution" — actually talks to production, run standalone or
// co-run with `unit` alike. Runs synchronously, before any test file's own top-level `await
// import('../pgClient')`/`await import('../dbAsync')` can call getPool() and read the (until now,
// possibly leaked) value.
delete process.env.VITEST_PG_SCHEMA;
delete process.env.VITEST_PG_URL;
