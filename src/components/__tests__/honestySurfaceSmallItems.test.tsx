import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(p, 'utf8');

describe('as-of lines on data pages (spec 2026-10-08 2.D)', () => {
  it('AsOfLine renders source and a relative fetch time, and a dash before the first fetch', async () => {
    const { AsOfLine } = await import('../AsOfLine');
    const html = renderToStaticMarkup(<AsOfLine source="sector tables" fetchedAt={Date.now() - 5 * 60_000} dataDate="2026-10-08" />);
    expect(html).toContain('Source: sector tables');
    expect(html).toContain('data 2026-10-08');
    expect(html).toContain('5m ago');
    expect(renderToStaticMarkup(<AsOfLine source="x" fetchedAt={0} />)).toContain('not fetched yet');
  });

  it.each([
    'src/components/sectors/SectorIntelligencePage.tsx',
    'src/components/FnOIntelligenceCenter.tsx',
    'src/components/v5/pages/OptionsDeskPage.tsx',
    'src/components/v4/components/PreMarketBriefing.tsx',
  ])('%s renders an AsOfLine', (file) => {
    expect(src(file)).toMatch(/<AsOfLine\b/);
  });
});

describe('daily-cadence polling', () => {
  // getFiiDiiFlow is one row per day; polling it every few minutes implies live data.
  it.each(['src/components/TradeDecisionCockpit.tsx', 'src/components/UltimateDecisionMatrix.tsx'])(
    '%s does not poll getFiiDiiFlow', (file) => {
      const line = src(file).split('\n').find(l => l.includes('getFiiDiiFlow.useQuery'))!;
      expect(line).not.toMatch(/refetchInterval/);
    });
  it('UltimateDecisionMatrix polls the nightly ranking no faster than every 15 minutes', () => {
    const line = src('src/components/UltimateDecisionMatrix.tsx').split('\n').find(l => l.includes('getBuyRecommendations.useQuery'))!;
    expect(line).not.toMatch(/refetchInterval:\s*120000/);
    expect(line).toMatch(/15 \* 60_000/);
  });
  it('TopPicksWidget treats the nightly ranking as slow data and never labels raw model output as a win probability', () => {
    const s = src('src/components/v4/components/TopPicksWidget.tsx');
    expect(s).toMatch(/refetchInterval:\s*30 \* 60_000/);
    expect(s).not.toContain('p.win_probability');
    expect(s).toContain('days_to_next_results');
    expect(s).toContain('Results');
  });
  it('sector overview polling matches its five-minute source cadence', () => {
    const s = src('src/components/sectors/SectorIntelligencePage.tsx');
    const query = s.slice(s.indexOf('getSectorsOverview.useQuery'), s.indexOf('getSectorDeepDive.useQuery'));
    expect(query).toMatch(/refetchInterval:\s*5 \* 60_000/);
  });
});

describe('Dashboard layout and Stock Intelligence labels', () => {
  it('DashboardPage has no fixed three-column inline grid (overflows on a phone)', () => {
    expect(src('src/components/DashboardPage.tsx')).not.toMatch(/gridTemplateColumns:\s*'220px 1fr 280px'/);
    expect(src('src/components/DashboardPage.tsx')).toMatch(/lg:grid-cols-\[220px_1fr_280px\]/);
  });
  it('Stock Intelligence labels stock_scores as an input score, not a composite with % confidence', () => {
    const s = src('src/components/v4/views/StockIntelligencePage.tsx');
    expect(s).not.toMatch(/title="Composite Score"/);
    expect(s).not.toMatch(/% confidence</);
    expect(s).toMatch(/input to the ranker/);
  });
});
