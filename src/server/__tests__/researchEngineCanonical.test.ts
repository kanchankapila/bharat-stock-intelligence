import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockDbAll = vi.fn();
vi.mock('../dbAsync', () => ({
  dbAll: mockDbAll,
  dbGet: vi.fn(),
  dbRun: vi.fn(),
}));

const mockGenerateStockAnalysis = vi.fn();
vi.mock('../../services/aiService', () => ({
  generateStockAnalysis: mockGenerateStockAnalysis,
}));

const {
  buildDeterministicBlurbs,
  generateBlurbs,
  loadCanonicalStockResearch,
} = await import('../researchEngine');

const canonicalBuy = {
  symbol: 'BEL',
  unified_score: 87.4,
  conviction_level: 'A_HIGH',
  classification: 'Strong Buy',
  regime: 'BEAR',
  screener_stock_score: 62,
  ml_score: 51,
  confluence_score: 91,
  technical_score: 76,
  dl_score: 0,
  avg_engine_track_record: 0.06,
  fundamental_score: 68,
  bullish_screener_count: 9,
  bearish_screener_count: 2,
  engine_coverage_count: 3,
  entry_zone_low: 298,
  entry_zone_high: 302,
  stop_loss: 286,
  target_1: 326,
  target_2: 344,
  risk_reward: 1.5,
  timeframe: 'SWING',
  valid_until: new Date('2026-10-13T10:00:00Z'),
  trade_reasoning: 'Strong relative strength with supporting volume.',
  rank_composite: 82,
  screener_net_score: 7,
  trailing_pe: 31,
  return_on_equity: 0.19,
  debt_to_equity: 12,
  piotroski_f_score: 8,
  return_1m: 6.2,
  return_3m: 14.1,
  above_sma200: 1,
  rsi: 63,
  adx: 29,
};

beforeEach(() => {
  mockDbAll.mockReset();
  mockGenerateStockAnalysis.mockReset();
  delete process.env.RESEARCH_AI_BLURBS_ENABLED;
});

describe('canonical daily research', () => {
  test('uses unified_score unchanged and preserves the canonical trade geometry', async () => {
    mockDbAll.mockResolvedValue([
      canonicalBuy,
      {
        ...canonicalBuy,
        symbol: 'WEAKCO',
        unified_score: 11,
        classification: 'Strong Sell',
        entry_zone_low: null,
        entry_zone_high: null,
        stop_loss: null,
        target_1: null,
        target_2: null,
        risk_reward: null,
        timeframe: null,
        valid_until: null,
        trade_reasoning: 'Persistent bearish trend.',
      },
    ]);

    const result = await loadCanonicalStockResearch();

    expect(result.picks).toHaveLength(1);
    expect(result.picks[0]).toMatchObject({
      symbol: 'BEL',
      conviction_score: 87.4,
      entry_zone_low: 298,
      entry_zone_high: 302,
      stop_loss: 286,
      target_1: 326,
      target_2: 344,
      risk_reward: 1.5,
      timeframe: 'SWING',
      classification: 'Strong Buy',
      layers_confirmed: 3,
    });
    expect(result.picks[0].stop_loss_pct).toBeCloseTo(-5.3, 1);
    expect(result.picks[0].target_1_pct).toBeCloseTo(7.9, 1);
    expect(result.avoid).toEqual([{ symbol: 'WEAKCO', reason: 'Persistent bearish trend.' }]);

    const sql = String(mockDbAll.mock.calls[0][0]);
    expect(sql).toContain('MAX(generated_at)');
    expect(sql).toContain('unified_recommendations');
  });

  test('builds factual deterministic blurbs without spending provider quota', async () => {
    mockDbAll.mockResolvedValue([canonicalBuy]);
    const { picks } = await loadCanonicalStockResearch();

    const deterministic = buildDeterministicBlurbs(picks, 'BEAR');
    const actual = await generateBlurbs(picks, 'BEAR');

    expect(actual).toEqual(deterministic);
    expect(actual.BEL).toContain('Canonical Strong Buy score 87.4/100');
    expect(actual.BEL).toContain('3 active engines');
    expect(actual.BEL).toContain('R:R 1.50');
    expect(mockGenerateStockAnalysis).not.toHaveBeenCalled();
  });
});
