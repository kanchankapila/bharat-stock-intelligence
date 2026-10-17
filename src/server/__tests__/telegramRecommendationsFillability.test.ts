import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbAll = vi.hoisted(() => vi.fn());
vi.mock('../dbAsync', () => ({ dbAll: mockDbAll }));

import { fetchLongTermPicks } from '../telegramRecommendations';

const rankedRow = {
  symbol: 'HITECHCORP', unified_score: 97.8, conviction_level: 'S_ELITE',
  classification: 'Strong Buy', timeframe: 'SWING', entry_zone_low: 411.45,
  stop_loss: 390, target_1: 440, risk_reward: 1.5, sector: 'Packaging',
  trade_reasoning: 'stored reason', screener_names_json: null,
  engine_coverage_count: 3, bullish_screener_count: 0,
};

describe('published-pick entry fillability', () => {
  beforeEach(() => mockDbAll.mockReset());

  it('carries the prior-session one-price warning into the published pick', async () => {
    mockDbAll.mockResolvedValue([{ ...rankedRow, prior_single_price: true }]);
    const [pick] = await fetchLongTermPicks();
    expect(pick.executionWarning).toContain('entry fill is unverified');
    const sql = String(mockDbAll.mock.calls[0][0]);
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain("symbol = 'NIFTY50'");
  });

  it('does not infer a one-price warning from an ordinary prior bar', async () => {
    mockDbAll.mockResolvedValue([{ ...rankedRow, prior_single_price: false }]);
    const [pick] = await fetchLongTermPicks();
    expect(pick.executionWarning).toBeNull();
  });
});
