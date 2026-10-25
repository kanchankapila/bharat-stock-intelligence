import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ failed: false, overview: {} as any, pulse: {} as any }));
vi.mock('../../../lib/trpc', () => {
  const query = (getData: () => unknown) => ({ useQuery: () => ({ data: state.failed ? undefined : getData(),
    isLoading: false, isError: state.failed, refetch: vi.fn() }) });
  return { trpc: {
    getMarketOverview: query(() => state.overview), getMarketPulse: query(() => state.pulse),
    getTopMovers: query(() => []), getTopRatedStocks: query(() => []),
    getSignals: query(() => []), getSignalTracking: query(() => []), getAccuracyMetrics: query(() => ({})),
    getStockScoreDetail: query(() => null), getTechnicalPredictions: query(() => []),
    getUnifiedScoreForSymbol: query(() => ({ unified_score: 51.5, engine_coverage_count: 3, classification: 'Sell' })),
    getOHLCData: query(() => []), getSignalHistory: query(() => []), getFnoOptionChainSummary: query(() => null),
    getScreenerCriteria: query(() => null),
    runScreener: { useMutation: () => ({ mutate: vi.fn(), isError: state.failed }) },
  } };
});
vi.mock('../components/PriceChart', () => ({ PriceChart: () => null }));
import { V7Shell } from '../V7Shell';
import { DashboardPage } from '../pages/Dashboard';
import { TopPicksPage } from '../pages/TopPicks';
import { SignalsPage } from '../pages/Signals';
import { ScreenerPage } from '../pages/Screener';
import { StockDetailPage } from '../pages/StockDetail';
import { DataTable } from '../components/DataTable';

const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter initialEntries={['/v7-stock/TCS']}>
  <Routes><Route path="/v7-stock/:symbol" element={node} /></Routes></MemoryRouter>);
describe('v7 missing-data and accessible public surfaces', () => {
  beforeEach(() => { state.failed = false; state.overview = {}; state.pulse = {}; });
  afterEach(() => { vi.useRealTimers(); });

  it('does not label absent or zero institutional flow as an inflow', () => {
    expect(html(<DashboardPage />)).not.toContain('FII INFLOW');
    state.pulse = { fiiDii: { fii_net: 0, dii_net: 0 } };
    expect(html(<DashboardPage />)).toContain('FII FLAT');
    state.pulse.fiiDii.fii_net = -10;
    expect(html(<DashboardPage />)).toContain('FII OUTFLOW');
    state.pulse.fiiDii.fii_net = 10;
    expect(html(<DashboardPage />)).toContain('FII INFLOW');
  });

  it('keeps missing index changes unknown even when an index value is present', () => {
    state.overview = { nifty50: { value: 25000, changePct: null } };
    expect(html(<V7Shell>child</V7Shell>)).not.toContain('+0.00%');
  });

  it('stock detail obtains its Unified Score from the canonical reader, not legacy component scores', () => {
    const result = html(<StockDetailPage />);
    expect(result).toContain('51.5');
    expect(result).toContain('Canonical engine coverage');
    expect(result).toContain('Legacy component breakdown');
    expect(result).not.toContain('Component contributions to the score');
  });

  it('never claims a confirmed live exchange session from an hour-only clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T06:00:00Z')); // Sunday
    expect(html(<V7Shell>child</V7Shell>)).not.toContain('>LIVE<');
    vi.setSystemTime(new Date('2026-10-26T06:00:00Z'));
    const weekday = html(<V7Shell>child</V7Shell>);
    expect(weekday).toContain('Scheduled session');
    expect(weekday).toContain('holiday');
  });

  it.each([['dashboard', DashboardPage], ['picks', TopPicksPage], ['signals', SignalsPage], ['screener', ScreenerPage], ['stock', StockDetailPage]] as const)(
    '%s distinguishes an API failure from a successful empty result', (_name, Page) => {
      state.failed = true;
      const result = html(<Page />);
      expect(result).toContain('Data request failed');
      expect(result).toContain('Retry');
      expect(result).not.toContain('FII INFLOW');
    });

  it('provides keyboard-operable sorting, row activation, and a labelled filter', () => {
    const result = html(<DataTable columns={[{ key: 'symbol', label: 'Symbol', sortable: true }]}
      data={[{ symbol: 'TCS' }]} onRowClick={() => {}} />);
    expect(result).toContain('<button');
    expect(result).toContain('aria-sort="none"');
    expect(result).toContain('tabindex="0"');
    expect(result).toContain('aria-label="Filter rows"');
  });
});
