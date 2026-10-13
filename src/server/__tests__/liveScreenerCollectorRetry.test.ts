import { describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({ dbRun: vi.fn(), dbTransaction: vi.fn() }));
vi.mock('../marketIntelService', () => ({ fetchLiveMarketScreener: vi.fn() }));
vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: vi.fn() },
}));

import { fetchLiveScreenerFilterWithRetry } from '../liveScreenerCollector';

describe('live screener transient timeout retry', () => {
  it('retries one timeout and returns the recovered filter payload', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      .mockResolvedValueOnce({ result: 1, resultData: [{ symbol_name: 'ABC' }] });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await fetchLiveScreenerFilterWithRetry('yesterdayGapDown', fetcher, sleep);

    expect(result.result).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry deterministic auth failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(fetchLiveScreenerFilterWithRetry('stockPE5To10', fetcher, sleep))
      .rejects.toThrow('401 Unauthorized');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
