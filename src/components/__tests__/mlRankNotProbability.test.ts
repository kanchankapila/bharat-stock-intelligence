import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mlRankLabel } from '../../lib/format';

// AF-20261008-45: technical_signals.win_probability / calibrated_win_probability rank stocks but
// are not probabilities (out of sample, no recalibration beat a constant base rate). No routed
// page may print either as a percent chance; they show "ML rank: top X%" instead.

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (e.name === '__tests__' ? [] : walk(join(d, e.name))) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [join(d, e.name)] : []);

// Routed = every module V1Routes.tsx lazy-imports, plus the TALA terminal (/tala/*).
const v1 = readFileSync('src/v1/V1Routes.tsx', 'utf8');
const routed = [
  ...[...v1.matchAll(/import\('(\.\.\/[^']+)'\)/g)].map(m => {
    const base = join('src/v1', m[1]);
    return ['.tsx', '.ts', '/index.tsx'].map(x => base + x).find(existsSync)!;
  }),
  ...walk('src/tala'),
];

// \b keeps LiveMarketScreener's ml_win_probability (a separate intraday screener model) out of scope.
const PROB = '\\b(?:win_probability|winProbability|mlProbability|mlWinProbability|avgWinProbability)';
const OFFENCES = [
  new RegExp(`${PROB}[^\\n]{0,40}\\*\\s*100`),                 // x * 100
  new RegExp(`${PROB}[^\\n;]{0,60}\\}\\s*%`),                   // {x}% or ${x}%
  new RegExp(`\\bprob\\([^)\\n]*${PROB}`),                      // TALA prob(x) -> "57.2%"
  /\bconfidence\)\}%/,                                           // matrix's old CAL. HIT-PROB cell
];

describe('no routed component shows the ML win probability as a percent chance', () => {
  it('finds the route modules it is meant to scan', () => {
    expect(routed.length).toBeGreaterThan(30);
    expect(routed.every(Boolean)).toBe(true);
    expect(routed.some(f => f.endsWith('TradeDecisionCockpit.tsx'))).toBe(true);
  });

  it('the patterns catch the old renderings (self-test)', () => {
    for (const bad of [
      '{c.mlProbability != null ? `${c.mlProbability}%` : \'—\'}',
      'const winPct = pick.win_probability != null ? Math.round(pick.win_probability * 100) : null;',
      '{prob(pick.win_probability)} win-prob',
      '{pick.confidence != null ? `${Math.round(pick.confidence)}%` : \'—\'}',
    ]) expect(OFFENCES.some(re => re.test(bad)), bad).toBe(true);
  });

  it.each(routed)('%s', (file) => {
    const hits = readFileSync(file, 'utf8').split('\n').filter(l => OFFENCES.some(re => re.test(l)));
    expect(hits).toEqual([]);
  });
});

describe('mlRankLabel', () => {
  it('turns a 0-100 percentile into "top X%" and never invents one', () => {
    expect(mlRankLabel(100)).toBe('top 1%');
    expect(mlRankLabel(90)).toBe('top 10%');
    expect(mlRankLabel(33.3)).toBe('top 67%');
    expect(mlRankLabel(0)).toBe('top 100%');
    for (const v of [null, undefined, '', NaN]) expect(mlRankLabel(v)).toBeNull();
  });
});
