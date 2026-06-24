import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRelease = vi.fn();
const mockClient = { query: vi.fn(), release: mockRelease };
const mockConnect = vi.fn().mockResolvedValue(mockClient);
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect, on: vi.fn() })),
  types: { setTypeParser: vi.fn(), builtins: { INT8: 20 } },
}));

const { withClient } = await import('../pgClient');

describe('pgClient', () => {
  beforeEach(() => {
    mockRelease.mockClear();
    mockConnect.mockClear();
  });

  it('withClient releases client after success', async () => {
    const result = await withClient(async (c) => {
      return 42;
    });
    expect(result).toBe(42);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('withClient releases client even when fn throws', async () => {
    mockRelease.mockClear();
    await expect(
      withClient(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
