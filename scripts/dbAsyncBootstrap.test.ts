import { afterEach, describe, expect, it, vi } from 'vitest';

const { ensure } = vi.hoisted(() => ({ ensure: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/server/pgClient', () => ({
  pgQuery: vi.fn(), pgExecute: vi.fn(), pgClient: vi.fn(), pgEnsureColumns: ensure,
}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); ensure.mockClear(); });

describe('DB facade bootstrap boundary', () => {
  it('does not start background legacy DDL merely by importing a facade in Vitest', async () => {
    vi.stubEnv('VITEST', 'true');
    await import('../src/server/dbAsync');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('preserves the normal application bootstrap outside the test runner', async () => {
    vi.stubEnv('VITEST', undefined);
    await import('../src/server/dbAsync');
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
