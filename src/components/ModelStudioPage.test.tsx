import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ModelStudioPage from './ModelStudioPage';

vi.mock('../lib/trpc', () => ({
  trpc: {
    getQuantScoringStatus: { useQuery: () => ({ data: { total_scored: 1421, pending: 0 }, isLoading: false, isError: false, refetch: vi.fn() }) },
    getDLModelPerformance: { useQuery: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }) },
    getModelRocDiagnostics: { useQuery: () => ({ data: undefined, isLoading: false }) },
    getLiveHitRates: { useQuery: () => ({ data: undefined, isLoading: false }) },
    getScreenerSurfacingSignals: { useQuery: () => ({ data: [], isLoading: false }) },
  },
}));

describe('ModelStudioPage', () => {
  it('renders the hero, all five tabs, and the scoring-authority disclosure', () => {
    const html = renderToStaticMarkup(<ModelStudioPage />);
    expect(html).toContain('Watch the engines, not the story.');
    expect(html).toContain('Scoring Status');
    expect(html).toContain('ROC Diagnostics');
    expect(html).toContain('Live Hit Rates');
    expect(html).toContain('Surfacing Monitor');
    expect(html).toContain('DL Performance');
    expect(html).toContain('component inputs to the canonical unified ranking');
    expect(html).toContain('NOT FINANCIAL ADVICE');
  });
  it('renders real status scalars as tiles without rescoring them', () => {
    const html = renderToStaticMarkup(<ModelStudioPage />);
    expect(html).toContain('Total Scored');
    expect(html).toContain('1,421');
  });
});
