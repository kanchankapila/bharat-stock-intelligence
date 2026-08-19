import { describe, it, expect } from 'vitest';
import { buildStockBadges } from '../StockTagRow';

// Regression check for the data-honesty class fixed 2026-08-19: a missing (null) field must
// suppress a badge, never render one derived from a fallback of 0.
describe('buildStockBadges', () => {
  it('shows no badges for an all-null/undefined row', () => {
    expect(buildStockBadges({})).toEqual([]);
  });

  it('suppresses the block-deal badge when the flag is set but direction is unknown', () => {
    const badges = buildStockBadges({ block_deal_flag: true, block_deal_direction: null });
    expect(badges.find(b => b.label.startsWith('Block'))).toBeUndefined();
  });

  it('shows Block buy only once direction is a real positive number', () => {
    const badges = buildStockBadges({ block_deal_flag: true, block_deal_direction: 5 });
    expect(badges.map(b => b.label)).toContain('Block buy');
  });

  it('shows Block sell for a real negative direction', () => {
    const badges = buildStockBadges({ block_deal_flag: true, block_deal_direction: -2 });
    expect(badges.map(b => b.label)).toContain('Block sell');
  });

  it('a real zero direction shows neither buy nor sell (0 clears no threshold)', () => {
    const badges = buildStockBadges({ block_deal_flag: true, block_deal_direction: 0 });
    expect(badges.find(b => b.label.startsWith('Block'))).toBeUndefined();
  });

  it('suppresses EPS beat / promoter / MF-inflow badges when their fields are null', () => {
    const badges = buildStockBadges({
      eps_beat_streak: null, eps_surprise_q1: null,
      promoter_net_90d: null, mf_sector_flow_pct: null,
    });
    expect(badges).toEqual([]);
  });

  it('shows EPS beat once the real value clears the threshold', () => {
    const badges = buildStockBadges({ eps_surprise_q1: 7.2 });
    expect(badges.map(b => b.label)).toContain('EPS beat');
  });
});
