import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGlobalMarketData } from '../globalMarketService';

describe('fetchGlobalMarketData', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the working Moneycontrol feed and maps its response to the stable contract', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: 1,
        data: [{
          name: 'Nikkei 225', symbol: 'JP;N225', ltp: '64,711.00', chg: '635.58',
          chgper: '0.99', market_state: 'closed', updatedDate: '21 Oct, 2026',
          market_time: '11:30 AM',
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGlobalMarketData()).resolves.toEqual([{
      country: 'Japan',
      symbol: 'JP;N225',
      current_price: '64,711.00',
      change_value: '635.58',
      change_per: '0.99',
      market_status: false,
      created_at: '21 Oct, 2026',
      timestamp: '11:30 AM',
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=mi'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
