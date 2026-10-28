import { describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({ dbRun: vi.fn(), dbTransaction: vi.fn() }));
vi.mock('../marketIntelService', () => ({ fetchLiveMarketScreener: vi.fn() }));
vi.mock('../telegramService', () => ({ telegramService: { sendMarkdownMessage: vi.fn() } }));

import { writeFilterAppearances } from '../liveScreenerCollector';

// One INSERT per appearance was 588k single-row statements in 2.3 days (pg_stat_statements 2026-10-28).
describe('live screener appearances are written as one multi-row INSERT per filter', () => {
  it('sends every symbol-bearing record in a single statement', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await writeFilterAppearances({ run } as any, 42, 'gapUp', [
      { symbol_name: 'INFY', last_trade_price: 1500, change_per: 1.2, volume: 1000 },
      { symbol_name: '', last_trade_price: 1 },
      { symbol_name: 'TCS', last_trade_price: 4000, change_per: -0.5, volume: 2000 },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    const [sql, params] = run.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO live_screener_appearances/);
    expect(params).toEqual([42, 'INFY', 'gapUp', 1500, 1.2, 1000, 42, 'TCS', 'gapUp', 4000, -0.5, 2000]);
  });

  it('issues no statement when no record carries a symbol', async () => {
    const run = vi.fn();
    await writeFilterAppearances({ run } as any, 1, 'gapUp', [{ symbol_name: '' }]);
    expect(run).not.toHaveBeenCalled();
  });
});
