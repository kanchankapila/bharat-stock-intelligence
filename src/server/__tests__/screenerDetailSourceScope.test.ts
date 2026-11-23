import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbAll: vi.fn(async () => []),
  dbGet: vi.fn(async () => null),
  dbRun: vi.fn(),
}));

const { dbAll, dbGet } = await import('../dbAsync');
const { screenersRouter } = await import('../routers/screeners.router');
const caller = screenersRouter.createCaller({} as any);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbAll).mockResolvedValue([]);
  vi.mocked(dbGet).mockResolvedValue(null);
});

describe('getScreenerDetail', () => {
  it('scopes performance and appearance queries by provider as well as screener id', async () => {
    const input = { screener_id: 'shared-scan-id', source: 'MoneyControl' };
    await caller.getScreenerDetail(input);

    expect(dbGet).toHaveBeenCalledWith(
      expect.stringContaining('LOWER(spv.source) = LOWER(?)'),
      [input.screener_id, input.source],
    );

    expect(dbAll).toHaveBeenCalledTimes(2);
    for (const [query, params] of vi.mocked(dbAll).mock.calls) {
      expect(query).toContain('LOWER(source) = LOWER(?)');
      expect(params).toEqual([input.screener_id, input.source]);
    }
  });
});
