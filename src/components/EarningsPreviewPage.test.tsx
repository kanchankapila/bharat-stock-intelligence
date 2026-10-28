import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EarningsPreviewPage, pct, setupLabel, signedPct } from './EarningsPreviewPage';

const { preview, log } = vi.hoisted(() => ({ preview: vi.fn(), log: vi.fn() }));
vi.mock('../lib/trpc', () => ({
  trpc: {
    getEarningsPreview: { useQuery: preview },
    getEarningsPreviewLog: { useQuery: log },
  },
}));

const upcoming = (symbol: string, decile: number | null, adt: number) => ({
  symbol, name: `${symbol} Ltd`, sector: 'Banking', expected_date: '2026-10-29', adt_cr: adt,
  score: decile, score_pct: decile == null ? null : decile * 10 - 5, decile, n_features: 6,
  prior_pat_yoy: 0.31, peer_pat_yoy: 0.12, beat_score_4q: 0.5, runup_20d: 0.04,
});

describe('EarningsPreviewPage helpers', () => {
  it('formats fractions as percents and refuses non-finite values', () => {
    expect(pct(0.1234)).toBe('12.3%');
    expect(signedPct(0.05, 0)).toBe('+5%');
    expect(signedPct(-0.012, 2)).toBe('-1.20%');
    expect(pct(NaN)).toBe('—');
    expect(signedPct(null)).toBe('—');
  });

  it('labels deciles at the stated boundaries and never invents a label without a decile', () => {
    expect(setupLabel(10).label).toBe('Strong results likely');
    expect(setupLabel(9).label).toBe('Strong results likely');
    expect(setupLabel(8).label).toBe('Above-average');
    expect(setupLabel(4).label).toBe('Middling');
    expect(setupLabel(2).label).toBe('Below-average');
    expect(setupLabel(1).label).toBe('Weak results likely');
    expect(setupLabel(null).label).toBe('Not enough data');
  });
});

describe('EarningsPreviewPage', () => {
  beforeEach(() => log.mockReturnValue({ data: [], isLoading: false }));

  it('explains that the forecast is about the reported numbers, not the price move', () => {
    preview.mockReturnValue({ isLoading: false, data: {
      live: { season: '2026-09-30', as_of_session: '2026-10-26', primary_model: 'learned', live_grading: {},
              upcoming: [upcoming('STRONGCO', 10, 50), upcoming('TINYCO', 10, 2)], reported: [] },
      backtest: { seasons: 15 },
    } });
    const html = renderToStaticMarkup(<EarningsPreviewPage />);
    expect(html).toContain('does not predict the share-price');
    expect(html).toContain('Research only: not a buy list');
    expect(html).toContain('STRONGCO');
    expect(html).toContain('Strong results likely');
    // the tradeable-only filter is on by default: a Rs 2 cr/day name is not listed
    expect(html).not.toContain('TINYCO');
    expect(html).toContain('Learned');
  });

  it('says plainly when no snapshot exists instead of rendering an empty table', () => {
    preview.mockReturnValue({ isLoading: false, data: { live: null, backtest: null } });
    const html = renderToStaticMarkup(<EarningsPreviewPage />);
    expect(html).toContain('No preview snapshot yet');
    expect(html).not.toContain('Upcoming results');
  });
});
