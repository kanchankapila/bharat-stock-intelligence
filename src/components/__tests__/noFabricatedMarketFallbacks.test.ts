import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// AF-20260930-43: market values rendered from hard-coded fallbacks as if live -- VIX 13.40/13.8,
// USD/INR 83.95, crude $76.5, GIFT NIFTY 24,580, NIFTY 24,850 +0.65%, FII +1,420, breadth
// 1240/810 -- and six made-up STRONG BUY cards. A missing value must render as "—".
// Scans every .tsx under src/, so a new component cannot reintroduce the shape.
const SRC = resolve(__dirname, '../..');

const PATTERNS: Array<[string, RegExp]> = [
  // `x?.close ? x.close.toFixed(2) : '83.95'` -- a numeric string literal as the else-branch
  ['numeric-literal ternary fallback', /\?\.[A-Za-z_]+[^:\n]{0,80}\?[^:\n]{1,80}:\s*['"`]\$?[0-9][0-9,]*(?:\.[0-9]+)?%?['"`]/],
  // `x?.lastPrice || 13.8` / `?? 1420.5` -- a decimal market-sized number as a default
  ['decimal default for a live value', /\?\.[A-Za-z_]+\s*(?:\?\?|\|\|)\s*[1-9][0-9]{1,5}\.[0-9]+\b/],
];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : tsxFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

export function findFabricatedFallbacks(source: string): string[] {
  return source.split('\n').flatMap((line, i) =>
    PATTERNS.filter(([, re]) => re.test(line)).map(([name]) => `L${i + 1} ${name}: ${line.trim().slice(0, 120)}`));
}

describe('no fabricated market-value fallbacks in the frontend', () => {
  const files = tsxFiles(SRC);

  it('scans a real tree (non-vacuity)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('flags the exact shapes that shipped (negative control on the pre-fix lines)', () => {
    expect(findFabricatedFallbacks(`{usdTile?.close ? usdTile.close.toFixed(2) : '83.95'}`)).toHaveLength(1);
    expect(findFabricatedFallbacks(`{fmt(indiaVix?.lastPrice || 13.8, 2)}`)).toHaveLength(1);
    expect(findFabricatedFallbacks(`{vix?.close ? vix.close.toFixed(2) : '—'}`)).toHaveLength(0);
  });

  it('no component renders a hard-coded number in place of missing live data', () => {
    const hits = files.flatMap(f => findFabricatedFallbacks(readFileSync(f, 'utf8')).map(h => `${f.slice(SRC.length)} ${h}`));
    expect(hits).toEqual([]);
  });

  it('the decision matrix carries no hard-coded recommendation list', () => {
    const src = readFileSync(join(SRC, 'components/UltimateDecisionMatrix.tsx'), 'utf8');
    expect(src).not.toMatch(/const fallbacks = \[/);
    expect(src).not.toMatch(/>\s*RELIANCE, HAL, TATASTEEL\s*</); // rendered text, not a comment naming it
  });
});
