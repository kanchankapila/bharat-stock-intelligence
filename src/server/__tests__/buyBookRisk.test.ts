import { describe, expect, it } from 'vitest';
import { bookRisk, type Close } from '../buyBookRisk';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const series = (rets: number[], start = 100): Close[] => {
  const out: Close[] = [{ date: day(0), close: start }];
  rets.forEach((r, i) => out.push({ date: day(i + 1), close: out[i].close * (1 + r) }));
  return out;
};
const wave = (n: number, amp: number, phase = 0) => Array.from({ length: n }, (_, i) => amp * Math.sin(i / 3 + phase));

describe('bookRisk (AF-20261119-12)', () => {
  it('reads a book that moves 2x the index as beta 2 with the index drawdown doubled', () => {
    const m = wave(100, 0.01);
    const res = bookRisk(new Map([['A', series(m.map(x => 2 * x))], ['B', series(m.map(x => 2 * x))]]), series(m), { A: 'IT', B: 'Banks' });
    expect(res.names).toBe(2);
    expect(res.beta).toBeCloseTo(2, 1);
    expect(res.avgPairCorr).toBeCloseTo(1, 2);
    expect(res.maxDrawdownPct!).toBeLessThan(0);
    expect(res.sectorWeights).toEqual([{ sector: 'IT', weightPct: 50 }, { sector: 'Banks', weightPct: 50 }].sort((a, b) => b.weightPct - a.weightPct || 0));
    expect(res.weighting).toBe('equal');
  });

  it('excludes names with too little history instead of extrapolating them', () => {
    const m = wave(100, 0.01);
    const res = bookRisk(new Map([['OLD', series(m)], ['NEW', series(wave(20, 0.01))]]), series(m));
    expect(res.names).toBe(1);
    expect(res.excluded).toEqual(['NEW']);
    expect(res.avgPairCorr).toBeNull();
  });

  it('opposite movers diversify: negative correlation, lower volatility than either name', () => {
    const m = wave(100, 0.01);
    const res = bookRisk(new Map([['UP', series(m)], ['DOWN', series(m.map(x => -x))]]), series(m));
    expect(res.avgPairCorr!).toBeLessThan(-0.9);
    expect(res.annualVolPct!).toBeLessThan(1);
  });

  it('returns an empty book when nothing qualifies', () => {
    expect(bookRisk(new Map(), series(wave(100, 0.01))).names).toBe(0);
  });
});
