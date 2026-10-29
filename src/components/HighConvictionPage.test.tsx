import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const refresh = vi.fn();

vi.mock('../lib/trpc', () => ({
  trpc: {
    getCapitulationSignal: {
      useQuery: () => ({
        data: {
          asOf: '2026-10-19T09:45:00+05:30',
          matches: [],
          evidence: {
            as_of: '2026-08-20',
            n_days_history: 430,
            cost_pct_used: 0.15,
            is_edge: true,
            best: {
              filters: ['gap_down', 'open_eq_low', 'top_loser'],
              n_days: 430,
              n_signals: 658,
              spread_pct: 0.5064,
              t_stat: 3.48,
              p_value: 0.0005,
            },
          },
        },
        isLoading: false,
        isError: false,
        refetch: refresh,
        isRefetching: false,
      }),
    },
    getBuyRecommendations: {
      useQuery: () => ({
        data: {
          lastComputedAt: '2026-10-18T15:30:00+05:30',
          regime: 'BEAR',
          picks: [{
            symbol: 'RELIANCE',
            unified_score: 82.4,
            classification: 'Buy',
            timeframe: 'SWING',
            sector: 'Energy',
            livePrice: 2812.4,
            changePercent: 1.2,
            entry_zone_low: 2780,
            entry_zone_high: 2820,
            target_1: 2910,
            stop_loss: 2735,
            valid_until: '2026-10-24T15:30:00+05:30',
            planStatus: 'ACTIVE',
            trade_reasoning: '[{"name":"Positive relative strength","sentiment":"bullish","source":"Trendlyne"},{"name":"Promoter pledge increased","sentiment":"bearish","source":"Exchange filing"}]',
            engine_coverage_count: 4,
            days_to_next_results: 18,
          }],
        },
        isLoading: false,
        isError: false,
        refetch: refresh,
        isRefetching: false,
      }),
    },
  },
}));

const { HighConvictionPage } = await import('./HighConvictionPage');
const html = renderToStaticMarkup(<HighConvictionPage />);

describe('Best Picks evidence-first redesign', () => {
  it('keeps the validated setup separate and explains an empty live scan', () => {
    expect(html).toContain('Validated trade setup');
    expect(html).toContain('No validated setup today');
    expect(html).toContain('0.51%');
    expect(html).toContain('net after 0.15% cost');
    expect(html).toContain('p=0.0005');
  });

  it('shows canonical recommendations instead of leaving the page empty', () => {
    expect(html).toContain('Research shortlist');
    expect(html).toContain('RELIANCE');
    expect(html).toContain('82');
    expect(html).toContain('SWING');
    expect(html).toContain('ACTIVE');
    expect(html).toContain('Positive relative strength');
    expect(html).toContain('Promoter pledge increased');
    expect(html).not.toContain('[{&quot;name&quot;');
  });

  it('puts real recommendations before supporting methodology so stocks are visible first', () => {
    expect(html.indexOf('RELIANCE')).toBeGreaterThan(0);
    expect(html.indexOf('RELIANCE')).toBeLessThan(html.indexOf('What the number means'));
  });

  it('does not misrepresent the canonical rank as accuracy', () => {
    expect(html).toContain('Unproven ranking');
    expect(html).toContain('rank, not a probability');
    expect(html).toContain('No demonstrated net edge on liquid names');
    expect(html).not.toMatch(/82(?:\.4)?% accurate/i);
  });
});
