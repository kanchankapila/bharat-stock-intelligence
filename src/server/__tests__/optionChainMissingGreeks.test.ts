import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({ dbAll: vi.fn(async () => []) }));
vi.mock('../niftytraderService', () => ({ getNiftyTraderHeaders: vi.fn(async () => ({})) }));
vi.mock('../contracts/marketFeeds', () => ({ parseNtOptionChainResponse: (j: unknown) => j }));

const { fetchOptionChain } = await import('../optionChainService');

describe('fetchOptionChain with no Greeks from the feed (AF-20261128-01)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports missing IV and Greeks as null, not as a measured 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: 1,
        resultData: {
          spotPrice: 100,
          opDatas: [{ strike_price: 100, calls_oi: 5, puts_oi: 7, calls_iv: 0, call_delta: 0, puts_iv: 22.5 }],
          opTotals: { total_calls_oi: 5, total_puts_oi: 7 },
        },
      }),
    })));

    const row = (await fetchOptionChain('SOMESTOCK')).data.optionChain[0];

    for (const key of ['callIv', 'callDelta', 'callTheta', 'callVega', 'callGamma', 'putDelta']) {
      expect(row[key], key).toBeNull();
    }
    expect(row.putIv).toBe(22.5);
    expect(row.callOi).toBe(5);
  });
});
