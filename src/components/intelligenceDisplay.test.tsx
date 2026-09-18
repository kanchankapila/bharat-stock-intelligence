import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import DLIIntelligenceCenter from './DLIIntelligenceCenter';
import { MetricTile } from './MetricTile';
import { decodeHtmlEntities, percentPoint, stripHtmlToText } from '../lib/intelligenceDisplay';

vi.mock('../lib/trpc', () => ({ trpc: {
  getDLPredictions: { useQuery: () => ({ data: [{ symbol: 'TEST', confidence: 0.75, prob_up_1d: 0.75, prob_dn_1d: 0.25, exp_ret_1d: null, exp_ret_5d: 0.025 }], isLoading: false, refetch: vi.fn() }) },
} }));
vi.mock('./ScoreRadial', () => ({ ScoreRadial: ({ score }: { score: number }) => <span>score={score}</span> }));

describe('intelligence display regressions', () => {
  it('renders supplied icon nodes without treating them as constructors', () => {
    expect(renderToStaticMarkup(<MetricTile label="Articles" value={3} icon={<span>News icon</span>} />)).toContain('News icon');
  });
  it('converts fractional confidence to a displayed percentage', () => {
    expect(renderToStaticMarkup(<DLIIntelligenceCenter />)).toContain('75.0%');
  });
  it('shows the available five-day return instead of a fabricated zero one-day return', () => {
    const html = renderToStaticMarkup(<DLIIntelligenceCenter />);
    expect(html).toContain('2.50%');
    expect(html).not.toContain('+0.00%');
  });
});

describe('percentPoint (fields already stored in percent units)', () => {
  it('renders stored percent values without rescaling', () => {
    expect(percentPoint(-2.1713)).toBe('-2.17%');
    expect(percentPoint(0)).toBe('0.00%');
  });
  it('keeps unresolved values absent, never zero', () => {
    expect(percentPoint(null)).toBe('—');
    expect(percentPoint(undefined)).toBe('—');
    expect(percentPoint(Number.NaN)).toBe('—');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named and numeric entities commonly found in news feeds', () => {
    expect(decodeHtmlEntities('Tata &amp; Sons &#39;raises&#39; stake')).toBe('Tata & Sons \'raises\' stake');
    expect(decodeHtmlEntities('profit &#8217; beat &#x27; guidance&nbsp;now')).toBe('profit ’ beat \' guidance now');
  });
  it('leaves unknown entities and entity-free text intact', () => {
    expect(decodeHtmlEntities('100 &mystery; done')).toBe('100 &mystery; done');
    expect(decodeHtmlEntities('plain headline')).toBe('plain headline');
    expect(decodeHtmlEntities('')).toBe('');
  });
  it('never turns decoded markup into injectable output', () => {
    const decoded = decodeHtmlEntities('&lt;img src=x onerror=alert(1)&gt;');
    expect(decoded).toBe('<img src=x onerror=alert(1)>');
    expect(renderToStaticMarkup(<p>{decoded}</p>)).not.toContain('<img');
    expect(renderToStaticMarkup(<p>{decoded}</p>)).toContain('&lt;img');
  });
  it('extracts plain text from raw HTML summaries', () => {
    expect(stripHtmlToText('<a href="https://x">Headline</a> <font color="#6f6f6f">Source</font>')).toBe('Headline Source');
    expect(stripHtmlToText('Tata &amp; Sons   rises')).toBe('Tata & Sons rises');
    expect(stripHtmlToText('')).toBe('');
  });
});
