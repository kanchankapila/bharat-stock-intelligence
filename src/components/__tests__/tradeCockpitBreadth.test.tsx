import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/trpc', () => {
  const query = (data: unknown) => ({ useQuery: () => ({ data, refetch: () => {}, dataUpdatedAt: 0 }) });
  return { trpc: {
    getTradeDecisionCockpitData: query({ success: true, data: { marketOverview: { verdict: 'NO TRADE', advDecRatio: 0 }, candidates: [] } }),
    getAdvanceDecline: query({ success: 1, data: [{ advances: 1808, declines: 1364, time: 10281332 }] }),
    getAllIndices: query(null), getSectorPerformance: query(null), getTopMovers: query(null),
    getFiiDiiFlow: query(null), getMarketSentiment: query({ pcr: 1.4 }),
  } };
});
vi.mock('../RiskMetricsDashboard', () => ({ RiskMetricsDashboard: () => null }));
vi.mock('../ActivityFeed', () => ({ ActivityFeed: () => null }));

describe('Trade Decision Cockpit breadth', () => {
  it('renders the provider advance/decline snapshot, not the model-threshold ratio', async () => {
    const { TradeDecisionCockpit } = await import('../TradeDecisionCockpit');
    const html = renderToStaticMarkup(<MemoryRouter><TradeDecisionCockpit onSelectStock={() => {}} /></MemoryRouter>);
    expect(html).toContain('1808/1364');
    expect(html).toContain('More advances');
    expect(html).not.toContain('A/D 0');
    expect(html).toContain('Context only; direction is not established');
    expect(html).not.toContain('Contrarian Bull');
    expect(html).not.toContain('Contrarian Bear');
  });
});
