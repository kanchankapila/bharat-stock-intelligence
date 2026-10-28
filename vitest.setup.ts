import { afterAll } from 'vitest';

// Each module instance registers its own cleanup only when it opens a pool. Importing
// pgClient here (even lazily) needlessly loads the real driver at teardown in mock-only
// suites and can exceed the hook budget. Registration also survives vi.resetModules.
export async function cleanupTestPools(): Promise<void> {
  const registry = (globalThis as any)[Symbol.for('bsi.vitest.pool-cleanups')] as Set<() => Promise<void>> | undefined;
  if (!registry) return;
  const cleanups = [...registry];
  registry.clear();
  const results = await Promise.allSettled(cleanups.map(async cleanup => cleanup()));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Test Postgres pool cleanup failed');
}

afterAll(cleanupTestPools);
