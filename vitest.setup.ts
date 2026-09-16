import { afterAll } from 'vitest';

// Vitest isolates the module registry PER TEST FILE, so pgClient's module-level `pool` cache is
// fresh in every one of them -- each file that touches the DB builds its OWN Pool (max 22,
// idleTimeoutMillis 20_000) and nothing ever closed it. `singleFork: true` means they all pile
// up inside one process, faster than the 20s idle reaper drains them.
//
// Measured 2026-08-16 against the real instance (max_connections = 60, 3 reserved): a bare
// `vitest run --project unit` peaked at 69 connections, which is why pgEnsureColumns was
// printing "sorry, too many clients already". It is logged non-fatal, so the suite stayed green
// while an unknown number of column-ensure calls silently did not happen -- the "looks healthy,
// is actually broken" shape, not a cosmetic warning. With this hook the same run peaks at 20.
//
// The import MUST be lazy. A top-level `import { closePool } from './src/server/pgClient'` puts
// the real pgClient (and the real `pg`) into the registry before the test file runs, which
// silently defeats pgClient.test.ts's `vi.mock('pg', ...)` -- its `await import('../pgClient')`
// then gets the already-cached unmocked module and 4 of its tests fail. Importing inside the
// hook resolves after the file's mocks are established, so a mocking file just gets its own
// mocked module back, where `pool` was never built and closePool() is a no-op.
afterAll(async () => {
  const { closePool } = await import('./src/server/pgClient');
  await closePool();
});
