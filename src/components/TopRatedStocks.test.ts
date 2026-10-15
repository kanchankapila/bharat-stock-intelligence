import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('TopRatedStocks error honesty', () => {
  it('does not render a failed query as a legitimate empty ranking', () => {
    const source = readFileSync(new URL('./TopRatedStocks.tsx', import.meta.url), 'utf8');
    expect(source).toContain('isError: boolean');
    expect(source).toMatch(/stocks\.length === 0 && !isLoading && !isError/);
    expect(source).toContain('Could not load this ranking');
  });
});
