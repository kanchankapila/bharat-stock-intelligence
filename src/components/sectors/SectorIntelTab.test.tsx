import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SectorIntelTab, mfDeltas } from './SectorIntelTab';

const mockState: { intel?: unknown; mf?: unknown } = {};
vi.mock('../../lib/trpc', () => ({
  trpc: {
    getSectorRotationIntel: { useQuery: () => ({ data: mockState.intel, isLoading: false, isError: false, refetch: vi.fn() }) },
    getSectorMfFlows: { useQuery: () => ({ data: mockState.mf, isLoading: false, isError: false, refetch: vi.fn() }) },
  },
}));

describe('SectorIntelTab', () => {
  it('renders quadrant scatter data, correlation pairs, and the summary takeaway', () => {
    mockState.intel = {
      rrg: [
        { sector: 'Nifty Bank', week_date: '2026-09-12', rs_ratio: 104, rs_momentum: 102, sector_return: 1.2, stocks_count: 12, quadrant: 'Leading' },
        { sector: 'Nifty IT', week_date: '2026-09-12', rs_ratio: 96, rs_momentum: 92, sector_return: -0.8, stocks_count: 10, quadrant: 'Lagging' },
      ],
      correlationPairs: [
        { sector_a: 'Nifty Bank', sector_b: 'Nifty Fin Services', correlation: 0.94, pair_type: 'redundant' },
        { sector_a: 'Nifty IT', sector_b: 'Nifty Pharma', correlation: 0.21, pair_type: 'diversifier' },
      ],
      sectorStats: [{ sector: 'Nifty Bank', avg_daily_return: 0.12, volatility: 0.9, total_return: 4.1, data_points: 60 }],
      summary: { data_date: '2026-09-12', avg_pairwise_correlation: 0.52, pct_pairs_above_0_7: 18, total_pairs: 66, takeaway: 'Correlations easing.' },
    };
    const html = renderToStaticMarkup(<SectorIntelTab />);
    expect(html).toContain('Nifty Bank');
    expect(html).toContain('redundant');
    expect(html).toContain('Correlations easing.');
    expect(html).toContain('18.0%');
    mockState.intel = undefined;
  });
  it('shows the honest empty state when nothing is stored', () => {
    const html = renderToStaticMarkup(<SectorIntelTab />);
    expect(html).toContain('No sector rotation intel stored');
  });
});

describe('mfDeltas', () => {
  it('computes latest-vs-previous month allocation deltas', () => {
    const rows = [
      { month: '2026-08', sector: 'Banks', aum_cr: 100, aum_pct: 30 },
      { month: '2026-09', sector: 'Banks', aum_cr: 110, aum_pct: 32.5 },
      { month: '2026-09', sector: 'IT', aum_cr: 50, aum_pct: 10 },
    ];
    const out = mfDeltas(rows);
    expect(out.find((r) => r.sector === 'Banks')?.delta).toBe(2.5);
    expect(out.find((r) => r.sector === 'IT')?.delta).toBeNull();
  });
});
