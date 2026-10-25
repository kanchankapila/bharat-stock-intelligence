import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const q = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false, isError: false, refetch: vi.fn(), isRefetching: false, dataUpdatedAt: 0 }) });
const lowData = {
  forwardTest: { protocol_hash: '13210b4e2c3ae688', generated_at: '2026-10-08T21:27:09',
    blocks: { forward: { since: '2026-10-06', calls: 4650, sessions: 2, tiers: { '5': [{ tier: 'published', verdict: 'LOW-DATA', eff_dates: 0 }] } } } },
  forwardTestAsOf: '2026-10-08 15:57:04+00', scorecard: null, scorecardAsOf: null,
  minIndependentWindows: 20, calendarBlockedUntil: { '5': '2027-02-23', '10': null, '21': null },
};
vi.mock('../lib/trpc', () => ({
  trpc: {
    getCommandCenter: q({
      regime: { name: 'BEAR', confidence: 0.99, updated_at: '2026-10-08' },
      eodPicks: [
        { symbol: 'PICKA', unified_score: 90, conviction_level: 'S_ELITE', classification: 'Strong Buy', timeframe: 'SWING', planStatus: 'ACTIVE' },
        { symbol: 'SHORTA', unified_score: 10, conviction_level: 'S_ELITE', classification: 'Strong Sell', timeframe: 'SWING', screener_names_json: JSON.stringify(['Negative Breakout', 'Supertrend Signal changed to Sell']) },
        { symbol: 'UNKNOWN', unified_score: 90, conviction_level: 'S_ELITE', classification: null },
      ],
      lastComputedAt: '2026-10-08', avgEngineTrackRecord: null,
    }),
    runUnifiedRanker: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    getEdgeStatus: q(lowData),
    getWhatChanged: q({ latest: '2026-10-08', previous: '2026-10-07',
      newBuys: [{ symbol: 'NEWBUY', from: 'Hold', to: 'Buy', score: 80 }], dropped: [{ symbol: 'GONE', from: 'Buy', to: 'Hold', score: 50 }],
      flips: [], expiredPlans: [{ symbol: 'OLDPLAN', valid_until: '2026-10-08T10:00:00Z', score: 70 }],
      counts: { latestBuys: 316, previousBuys: 300 } }),
    getMarketPulse: q({
      breadth: { advances: 1200, declines: 800, unchanged: 30, asOf: '2026-10-08', vsDate: '2026-10-07', source: 'stock_ohlcv' },
      vix: { value: 15.24, asOf: '2026-10-08 10:00:11+00', source: 'intraday_regime_history' },
      fiiDii: { date: '2026-10-08', fii_net: -12943.58, dii_net: 10703.11, unit: 'Rs Cr' },
      regime: { label: 'BELOW 200D MEAN', close: 24000, mean200: 25000, distPct: -4 }, regimeAsOf: '2026-10-08', regimeSessions: 200,
    }),
    getEarningsFlags: q({ asOf: '2026-10-08', rows: [{ symbol: 'PICKA', days_to_next_results: 3, eps_surprise_q1: 7.5, eps_beat_streak: 4 }] }),
  },
}));

const { CommandCenterDashboard } = await import('./CommandCenterDashboard');
const html = renderToStaticMarkup(<MemoryRouter><CommandCenterDashboard onSelectStock={() => {}} /></MemoryRouter>);

describe('Alpha (CommandCenterDashboard) honesty surfaces', () => {
  it('shows the no-call banner as a watch-list with source, hash and as-of when the forward test is LOW-DATA', () => {
    expect(html).toContain('No verified edge yet');
    expect(html).toMatch(/watch-list/);
    expect(html).toContain('13210b4e');
    expect(html).toContain('2027-02-23');
    expect(html).toMatch(/ranks, not probabilities/);
  });

  it('shows what changed since the previous ranker run, disclaimed as rank changes', () => {
    expect(html).toContain('What changed since 2026-10-07');
    expect(html).toContain('NEWBUY');
    expect(html).toContain('GONE');
    expect(html).toContain('OLDPLAN');
    expect(html).toMatch(/not evidence of edge/);
  });

  it('shows the market pulse with units and as-of, and an objective (non-HMM) regime', () => {
    expect(html).toContain('1200');
    expect(html).toContain('15.24');
    expect(html).toContain('−₹12943.58 Cr');
    expect(html).toContain('BELOW 200D MEAN');
    expect(html).toMatch(/not the HMM/);
  });

  it('shows earnings event-risk chips on pick cards', () => {
    expect(html).toContain('Results in 3d');
    expect(html).toContain('EPS ×4');
  });

  it('makes pick cards keyboard-operable', () => {
    expect(html).toMatch(/role="button"[^>]*tabindex="0"|tabindex="0"[^>]*role="button"/);
  });

  it('uses the explicit classification, not the conviction tier, for card direction', () => {
    const cardClass = (symbol: string) => html.match(new RegExp(`<div[^>]*class="([^"]*)"[^>]*aria-label="Open ${symbol} in the trade cockpit"`))?.[1];
    expect(cardClass('PICKA')).toContain('v1-card-up');
    expect(cardClass('SHORTA')).toContain('v1-card-down');
    expect(cardClass('UNKNOWN')).toContain('v1-card-neutral');
    expect(html).toMatch(/class="[^"]*text-rose-400[^"]*"[^>]*>Strong Sell<\/span>/);
  });

  it('does not describe a direction-agnostic conviction tier as a Buy-only rating', () => {
    expect(html).toContain('direction-agnostic');
    expect(html).not.toContain('Tier mirrors the Buy/Strong Buy rating');
  });

  it('does not present a generic scanner-membership list as bullish evidence', () => {
    expect(html).toContain('Scanner matches');
    expect(html).not.toContain('Bullish screeners');
  });
});
