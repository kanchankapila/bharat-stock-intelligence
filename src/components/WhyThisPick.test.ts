import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('WhyThisPick scoring authority', () => {
  it('explains the canonical unified row and never the legacy stock_scores composite', () => {
    const source = readFileSync(new URL('./WhyThisPick.tsx', import.meta.url), 'utf8');
    expect(source).toContain('getUnifiedScoreForSymbol.useQuery');
    expect(source).not.toContain('getStockScoreDetail.useQuery');
    expect(source).not.toContain("stock_scores.reasons");
  });
});
