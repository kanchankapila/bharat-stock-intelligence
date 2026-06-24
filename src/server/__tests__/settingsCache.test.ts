import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDbGet = vi.fn().mockResolvedValue({ value: 'tok_abc' });
vi.mock('../dbAsync', () => ({ dbGet: mockDbGet, dbRun: vi.fn() }));
vi.mock('../cacheService', () => ({ fetchWithCache: vi.fn() }));

const { getNiftyTraderHeaders, invalidateNiftyTraderToken } = await import('../niftytraderService');

describe('niftytraderService token cache', () => {
  beforeEach(() => {
    mockDbGet.mockClear();
    mockDbGet.mockResolvedValue({ value: 'tok_abc' });
    invalidateNiftyTraderToken();
  });

  it('getNiftyTraderHeaders reads DB only on first call, then caches', async () => {
    await getNiftyTraderHeaders();
    await getNiftyTraderHeaders();
    await getNiftyTraderHeaders();
    expect(mockDbGet).toHaveBeenCalledTimes(1);
  });

  it('invalidateNiftyTraderToken forces re-read on next call', async () => {
    await getNiftyTraderHeaders();
    expect(mockDbGet).toHaveBeenCalledTimes(1);

    mockDbGet.mockClear();
    invalidateNiftyTraderToken();
    await getNiftyTraderHeaders();
    expect(mockDbGet).toHaveBeenCalledTimes(1);
  });
});
