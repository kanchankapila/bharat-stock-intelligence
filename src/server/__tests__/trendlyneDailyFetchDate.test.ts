import { afterEach, describe, expect, it, vi } from 'vitest';

const { dbRun, fetchMetrics } = vi.hoisted(() => ({
  dbRun: vi.fn().mockResolvedValue(undefined),
  fetchMetrics: vi.fn().mockResolvedValue({ body: { PE_TTM: { value: 32.3 } } }),
}));

vi.mock('../dbAsync', () => ({ dbAll: vi.fn(), dbRun }));
vi.mock('../trendlyneService', () => ({ fetchTrendlyneStockMetrics: fetchMetrics }));

import { runTrendlyneMetricsFetch } from '../trendlyneDailyFetchService';

describe('Trendlyne metrics observation date', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('uses the actual Indian calendar date for a retry after midnight IST', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T19:23:17Z'));
    expect(await runTrendlyneMetricsFetch('RRKABEL', true)).toBe(true);
    expect(dbRun.mock.calls[0][1].slice(0, 2)).toEqual(['RRKABEL', '2026-11-07']);
  });
});
