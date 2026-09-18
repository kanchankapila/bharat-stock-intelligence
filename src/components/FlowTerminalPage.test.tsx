import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import FlowTerminalPage, { InsiderTab } from './FlowTerminalPage';

const mockState: { blockDeals?: unknown[]; insider?: unknown[]; superstar?: unknown[] } = {};
vi.mock('../lib/trpc', () => ({
  trpc: {
    getBlockDeals: { useQuery: () => ({ data: mockState.blockDeals, isLoading: false, isError: false, refetch: vi.fn() }) },
    getInsiderTransactions: { useQuery: () => ({ data: mockState.insider, isLoading: false, isError: false, refetch: vi.fn() }) },
    getSuperstarActivityFeed: { useQuery: () => ({ data: mockState.superstar, isLoading: false, isError: false, refetch: vi.fn() }) },
  },
}));

describe('FlowTerminalPage', () => {
  it('renders the hero, all three tabs and the standing disclosures', () => {
    const html = renderToStaticMarkup(<FlowTerminalPage />);
    expect(html).toContain('Who is actually trading.');
    expect(html).toContain('Block Deals');
    expect(html).toContain('Insider Transactions');
    expect(html).toContain('Superstar Activity');
    expect(html).toContain('pct_transacted');
    expect(html).toContain('NOT FINANCIAL ADVICE');
  });
  it('block deals: totals only count numeric values and rows render', () => {
    mockState.blockDeals = [
      { symbol: 'RELIANCE', date: '2026-09-15', trade_type: 'BUY', qty: 100000, price: 1420.5, value_cr: 142.05, pct_transacted: 1.4, client_name: 'Morgan Stanley', category: 'CLIENT' },
      { symbol: 'TCS', date: '2026-09-15', trade_type: 'SELL', qty: 50000, price: 4100, value_cr: 205, pct_transacted: 0.6, client_name: 'GS', category: 'CLIENT' },
    ];
    const html = renderToStaticMarkup(<FlowTerminalPage />);
    expect(html).toContain('347.1');
    expect(html).toContain('Morgan Stanley');
    expect(html).toContain('1.40%');
    mockState.blockDeals = undefined;
  });
  it('insider: rows render with the source-freshness disclosure; null holdings are null by design', () => {
    mockState.insider = [
      { symbol: 'INFY', person_name: 'Promoter Group', person_category: 'Promoter', transaction_mode: 'Buy', quantity: 900000, value_cr: 150, before_pct: null, after_pct: null, transaction_date: '2026-09-16' },
    ];
    const html = renderToStaticMarkup(<InsiderTab />);
    expect(html).toContain('Promoter Group');
    expect(html).toContain('insider_trades');
    expect(html).toContain('null by design');
    mockState.insider = undefined;
  });
});
