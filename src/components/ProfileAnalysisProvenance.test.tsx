import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProfileAnalysisProvenance } from './ProfileAnalysisProvenance';

describe('profile assessment provenance', () => {
  it('shows the actual generation date and describes the evidential limit', () => {
    const html = renderToStaticMarkup(<ProfileAnalysisProvenance updatedAt="2026-10-05T15:30:00Z" />);
    expect(html).toContain('5 Oct 2026');
    expect(html).toContain('trading accuracy has not been validated');
  });

  it('does not invent a generation date for a missing or malformed timestamp', () => {
    for (const updatedAt of [null, 'invalid']) {
      expect(renderToStaticMarkup(<ProfileAnalysisProvenance updatedAt={updatedAt} />)).toContain('Last generated: unknown');
    }
  });

  it('covers both profile renderers reachable from the stock detail route', () => {
    for (const file of ['MCStockInfoPanel.tsx', 'V1StockDetails.tsx']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain(
        '<ProfileAnalysisProvenance updatedAt={(profileAnalysis as any).last_updated}',
      );
    }
  });
});
