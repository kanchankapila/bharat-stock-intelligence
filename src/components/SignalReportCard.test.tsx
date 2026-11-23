import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const q = (data: unknown) => ({ useQuery: () => ({ data, isLoading: false, error: null, isError: false }) });
const tierRows = (verdict: string) => [
  { tier: 0.01, coverage_pct: 1, calls_per_date: 0, dates: 0, eff_dates: 0, hit_rate: null, base_hit: null, hit_lift: null, hit_ci95: null, mean_excess_pct: null, t_eff: null, verdict },
  { tier: 'published', coverage_pct: null, calls_per_date: 0, dates: 0, eff_dates: 0, hit_rate: null, base_hit: null, hit_lift: null, hit_ci95: null, mean_excess_pct: null, t_eff: null, verdict },
];
vi.mock('../lib/trpc', () => ({
  trpc: {
    getSignalReportCard: q({
      sourceSummary: [], outcomeSummary: [], activeSignalGrowth: [], recommendationSourceBreakdown: [],
      recentBacktestResults: [], strategyPerformance: [],
      recommendationSummary: { total_recommendations: 0, win_count: 0, avg_actual_return_pct: null, worst_actual_return_pct: null },
    }),
    getLiveHitRates: q({ rows: [] }),
    getEdgeStatus: q({
      forwardTest: { protocol_hash: '13210b4e2c3ae688', generated_at: '2026-10-08T21:27:09',
        blocks: { forward: { since: '2026-10-06', calls: 4650, sessions: 2, tiers: { '5': tierRows('LOW-DATA'), '10': tierRows('LOW-DATA') },
          trade_profitability: {
            long_5: { side: 'long', horizon: '5d', trades: 1135, wins: 463, win_rate: 0.408, base_win_rate: 0.443, win_rate_lift: -0.035,
              avg_net_return_pct: -0.787, avg_win_pct: 4.741, avg_loss_pct: -4.596, profit_factor: 0.711, eff_dates: 5, low_data: true },
            short_intraday: { side: 'short', horizon: 'intraday', trades: 2125, wins: 1113, win_rate: 0.524, base_win_rate: 0.52, win_rate_lift: 0.004,
              avg_net_return_pct: -0.053, avg_win_pct: 1.727, avg_loss_pct: -2.014, profit_factor: 0.945, eff_dates: 29, low_data: false },
            '21': { buy_calls: 9, profit_rate: 0.99 },   // superseded v1 Buy-only shape: must not render as a trade
          } } } },
      forwardTestAsOf: '2026-10-08 15:57:04+00', scorecard: null, scorecardAsOf: null, minIndependentWindows: 20,
      calendarBlockedUntil: { '5': '2027-02-23', '10': '2027-07-13', '21': null },
    }),
    getReliabilityCurve: q({
      bins: [{ bin: 5, lo: 0.4, hi: 0.5, n: 6334, dates: 42, predicted: 0.4816, realised: 0.3047 },
             { bin: 8, lo: 0.7, hi: 0.8, n: 16355, dates: 60, predicted: 0.7895, realised: 0.4498 }],
      deciles: [{ decile: 1, n: 100, dates: 10, predicted: 0.3, mean_return_pct: -0.4 }, { decile: 10, n: 100, dates: 10, predicted: 0.8, mean_return_pct: 0.2 }],
      n: 42614, dates: 70, baseRate: 0.41, brier: 0.2712, asOf: '2026-10-01', roundTripCostPct: 0.5,
      source: 'signal_outcomes (technical, 5-session horizon, last 365 days) joined to technical_signals.calibrated_win_probability',
    }),
  },
}));

const { SignalReportCard } = await import('./SignalReportCard');
const html = renderToStaticMarkup(<SignalReportCard />);

describe('/signal-report-card forward test and reliability sections', () => {
  it('renders the frozen forward test per coverage tier with hash, windows and calendar block', () => {
    expect(html).toContain('Forward test');
    expect(html).toContain('13210b4e2c3ae688');
    expect(html).toContain('published');
    expect(html).toContain('LOW-DATA');
    expect(html).toContain('calendar-blocked until about 2027-02-23');
    expect(html).toMatch(/independent windows/);
  });

  it('grades Buy calls as longs and Sell calls as intraday shorts, each against a random pick', () => {
    expect(html).toContain('Buy → long 5d');
    expect(html).toContain('Sell → intraday short');
    expect(html).toContain('Random-pick win rate');
    expect(html).toContain('40.8%');      // Buy win rate
    expect(html).toContain('44.3%');      // the random pick it has to beat
    expect(html).toContain('-3.5%');      // lift: worse than chance
    expect(html).toContain('52.4%');      // short win rate
    expect(html.match(/Buy → long/g)?.length).toBe(1);   // the v1 row is not shown as a trade
  });

  it('renders the reliability curve titled predicted vs realised with Brier, base rate and n per bin', () => {
    expect(html).toContain('predicted vs realised WIN rate');
    expect(html).toContain('Brier 0.271');
    expect(html).toContain('base rate 41.0%');
    expect(html).toContain('16355');
    expect(html).toMatch(/ranks, not probabilities/);
  });

  it('renders the score-decile realised return with gross and net of the round-trip cost', () => {
    expect(html).toContain('Realised 5-session return by calibrated-probability decile');
    expect(html).toContain('-0.90%');   // decile 1 net = -0.4 - 0.5
  });
});
