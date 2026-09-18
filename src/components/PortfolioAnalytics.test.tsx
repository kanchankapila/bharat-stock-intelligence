import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PortfolioAnalytics, { FactorRadar, DvmTile } from './PortfolioAnalytics';
import { correlationCellClass, factorEntries } from '../lib/intelligenceDisplay';

const mockState: { scoreDetail?: unknown; dvm?: unknown } = {};
vi.mock('../lib/trpc', () => ({
  trpc: {
    analyzePortfolio: { useMutation: () => ({ mutate: vi.fn(), isPending: false, data: undefined, error: null }) },
    getStockScoreDetail: { useQuery: () => ({ data: mockState.scoreDetail, isLoading: false, isError: false, refetch: vi.fn() }) },
    getTrendlyneDVM: { useQuery: () => ({ data: mockState.dvm, isLoading: false, isError: false }) },
  },
}));

describe('PortfolioAnalytics shell', () => {
  it('renders the sandbox, all three tabs and the standing disclosures', () => {
    const html = renderToStaticMarkup(<PortfolioAnalytics />);
    expect(html).toContain('Risk &amp; Correlation');
    expect(html).toContain('Factor Radar');
    expect(html).toContain('Valuation Snapshot');
    expect(html).toContain('RELIANCE');
    expect(html).toContain('NOT FINANCIAL ADVICE');
  });
});

describe('FactorRadar', () => {
  it('labels component factors as non-canonical and never ranks', () => {
    mockState.scoreDetail = {
      score: { score: 71.2, classification: 'BUY' },
      factors: { technical: 72, fundamental: 55.5, momentum: 61, valuation: 40, delivery: 66, news: 58 },
    };
    const html = renderToStaticMarkup(<FactorRadar symbol="RELIANCE" />);
    expect(html).toContain('Screener composite (non-canonical)');
    expect(html).toContain('BUY');
    expect(html).toContain('inputs the canonical unified score');
    mockState.scoreDetail = undefined;
  });
  it('reports a missing score row instead of rendering an empty chart', () => {
    const html = renderToStaticMarkup(<FactorRadar symbol="NOPE" />);
    expect(html).toContain('No screener score row stored for NOPE');
  });
});

describe('DvmTile', () => {
  it('shows the honest not-scored state when no synced DVM row exists', () => {
    const html = renderToStaticMarkup(<DvmTile symbol="TCS" />);
    expect(html).toContain('Not scored yet');
    expect(html).toContain('TCS');
  });
  it('renders the three DVM dimensions with their stored values', () => {
    mockState.dvm = {
      durability: { score: 72, color: 'Green' },
      valuation: { score: 4, color: 'Red' },
      momentum: { score: 55, color: 'Blue' },
    };
    const html = renderToStaticMarkup(<DvmTile symbol="HDFCBANK" />);
    expect(html).toContain('Valuation');
    expect(html).toContain('Durability');
    expect(html).toContain('Momentum');
    expect(html).toContain('72');
    mockState.dvm = undefined;
  });
});

describe('correlationCellClass', () => {
  it('bands concentrations, diversifiers, the diagonal and missing values differently', () => {
    expect(correlationCellClass(0.9)).toBe('bsi-corr-high');
    expect(correlationCellClass(0.5)).toBe('bsi-corr-mid');
    expect(correlationCellClass(0.2)).toBe('bsi-corr-low');
    expect(correlationCellClass(0.9, true)).toBe('bsi-corr-self');
    expect(correlationCellClass(undefined)).toBe('bsi-corr-none');
    expect(correlationCellClass(Number.NaN)).toBe('bsi-corr-none');
  });
});

describe('factorEntries', () => {
  it('keeps only finite numeric factors and labels them', () => {
    expect(factorEntries({ technical: 72, fundamental: 55.5, momentum: null, valuation: 'x', delivery: 0, news: Number.NaN }))
      .toEqual([
        { key: 'technical', label: 'Technical', value: 72 },
        { key: 'fundamental', label: 'Fundamental', value: 55.5 },
        { key: 'delivery', label: 'Delivery', value: 0 },
      ]);
  });
  it('returns nothing for absent or malformed rows', () => {
    expect(factorEntries(undefined)).toEqual([]);
    expect(factorEntries('nope')).toEqual([]);
  });
});

