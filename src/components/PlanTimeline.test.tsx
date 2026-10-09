import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/trpc', () => ({
  trpc: {
    getPlanTimeline: { useQuery: () => ({ isError: false, data: {
      symbol: 'TLN', lastBar: { date: '2026-10-08', close: 108 },
      plans: [
        { computed_at: '2026-10-07', generated_at: '2026-10-07 12:30:00+00', valid_until: '2026-10-15 10:00:00+00', classification: 'Buy', timeframe: 'SWING',
          entry_zone_low: 100, entry_zone_high: 102, stop_loss: 95, target_1: 110, target_2: 115, unified_score: 80,
          firstTouch: { result: 'OPEN', date: null }, signalOutcomes: [] },
        { computed_at: '2026-10-01', generated_at: null, valid_until: '2026-10-06 10:00:00+00', classification: 'Strong Buy', timeframe: 'SWING',
          entry_zone_low: 100, entry_zone_high: 102, stop_loss: 95, target_1: 110, target_2: 115, unified_score: 85,
          firstTouch: { result: 'T1', date: '2026-10-02' },
          signalOutcomes: [{ signal_source: 'technical', horizon_days: 5, outcome: 'WIN', exit_reason: 'TIME_EXIT', return_pct: 2.5 }] },
      ] } }) },
  },
}));

const { PlanTimeline } = await import('./PlanTimeline');

describe('PlanTimeline', () => {
  const html = renderToStaticMarkup(<PlanTimeline symbol="TLN" />);
  it('shows each plan: generated -> entry -> valid until -> first touch, with levels and units', () => {
    expect(html).toContain('Plan lifecycle');
    expect(html).toContain('2026-10-01');
    expect(html).toContain('T1 hit 2026-10-02');
    expect(html).toContain('open');
    expect(html).toContain('₹100.00–102.00');
    expect(html).toContain('SL ₹95.00');
  });
  it('shows the same-day graded signal outcome with its source, labelled as not the plan grade', () => {
    expect(html).toContain('technical 5d: WIN +2.50% (TIME_EXIT)');
    expect(html).toMatch(/not a graded trade/);
  });
  it('is rendered by the routed stock-detail page', () => {
    expect(readFileSync('src/components/V1StockDetails.tsx', 'utf8')).toMatch(/<PlanTimeline symbol=\{symbol\} \/>/);
  });
});
