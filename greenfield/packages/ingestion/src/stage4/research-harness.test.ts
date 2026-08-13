import { describe, expect, it } from 'vitest';
import {
  computeAnnualizedExcessReturn, computeForwardReturns, computeIC, computeNetAnnualizedExcessReturn, winsorizePerDate,
  type FactorPoint,
} from './research-harness.js';
import type { OpenPriceRow } from '@greenfield/db';

const ADT_LIQUID = 2_00_00_000; // Rs 2cr, above the Rs 1cr floor

function bar(symbol: string, sessionDate: string, open: number | null, adt252d = ADT_LIQUID): OpenPriceRow {
  return { symbol, sessionDate, open, adt252d };
}

// Deterministic synthetic universe: N symbols x M sessions, with a KNOWN
// factor->forward-return relationship built in, so IC/annualized-return
// sign and rough magnitude are known ahead of time -- lets each negative
// control assert a specific, predicted outcome rather than just "some
// number came out."
// Deterministic pseudo-noise (classic sine-hash trick) -- NOT Math.random():
// tests must be reproducible. Without any noise, the synthetic factor would
// correlate with forward return at exactly IC=1.0 on every single date,
// giving zero cross-date variance and an undefined (correctly null) t-stat
// -- realistic data never behaves that way, so the test fixture shouldn't either.
function pseudoNoise(a: number, b: number): number {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return (x - Math.floor(x)) - 0.5; // in [-0.5, 0.5)
}

function buildSyntheticUniverse(nSymbols: number, nSessions: number): { bars: OpenPriceRow[]; factors: FactorPoint[] } {
  const bars: OpenPriceRow[] = [];
  const factors: FactorPoint[] = [];
  const prices = new Array(nSymbols).fill(100);
  for (let d = 0; d < nSessions; d++) {
    // Zero-padded synthetic index, not a real calendar date -- neither
    // computeForwardReturns nor computeIC/computeAnnualizedExcessReturn
    // parse sessionDate as a date, only sort/group it as a string key, and
    // this avoids day-of-month rollover past 31 for long synthetic runs.
    const sessionDate = `D${String(d + 1).padStart(5, '0')}`;
    for (let s = 0; s < nSymbols; s++) {
      const symbol = `SYM${s}`;
      bars.push(bar(symbol, sessionDate, prices[s]!));
      // Factor value == symbol's rank (0..nSymbols-1) -- a strong, but not
      // perfectly noiseless, signal.
      factors.push({ symbol, sessionDate, value: s });
      // Higher-ranked symbols drift up more on average, with per-date noise
      // so the day-to-day IC actually varies (a real t-stat is computable).
      prices[s] = prices[s]! * (1 + 0.001 * s + 0.02 * pseudoNoise(s, d));
    }
  }
  return { bars, factors };
}

describe('winsorizePerDate', () => {
  it('clips extreme values to the per-date 1st/99th percentile band', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ symbol: `S${i}`, sessionDate: 'D1', value: i }));
    points.push({ symbol: 'OUTLIER', sessionDate: 'D1', value: 100_000 }); // a +127,900%-style phantom bar
    const result = winsorizePerDate(points);
    expect(result.get('OUTLIER|D1')).toBeLessThan(1000);
  });

  it('winsorises each date independently', () => {
    const points = [
      { symbol: 'A', sessionDate: 'D1', value: 1 }, { symbol: 'B', sessionDate: 'D1', value: 2 }, { symbol: 'C', sessionDate: 'D1', value: 1000 },
      { symbol: 'A', sessionDate: 'D2', value: 5000 }, { symbol: 'B', sessionDate: 'D2', value: 6000 }, { symbol: 'C', sessionDate: 'D2', value: 7000 },
    ];
    const result = winsorizePerDate(points);
    expect(result.get('C|D1')).toBeLessThan(1000); // clipped on D1's own (small) scale
    expect(result.get('A|D2')).toBe(5000); // D2's own scale is much larger -- not clipped by D1's bounds
  });
});

describe('computeForwardReturns', () => {
  it('computes open-to-open return from next-session entry to rebalanceDays-later exit', () => {
    const bars = [bar('A', '2026-01-01', 100), bar('A', '2026-01-02', 110), bar('A', '2026-01-03', 121)];
    const returns = computeForwardReturns(bars, 1);
    // Signal on 01-01 -> entry 01-02 (110) -> exit 1 session later, 01-03 (121) -> +10%
    expect(returns[0]?.forwardReturn).toBeCloseTo(0.1);
  });

  it('negative control (exit-pricing bug): a symbol missing its exit bar is EXCLUDED by default, not written off at -100%', () => {
    const bars = [bar('A', '2026-01-01', 100), bar('A', '2026-01-02', 110)]; // no bar 1 session after entry
    const excluded = computeForwardReturns(bars, 1, 'exclude');
    expect(excluded[0]?.forwardReturn).toBeNull();

    const buggy = computeForwardReturns(bars, 1, 'writeOff');
    expect(buggy[0]?.forwardReturn).toBe(-1);
  });
});

describe('computeIC', () => {
  it('detects a real, noiseless factor->return relationship with IC significantly positive', () => {
    const { bars, factors } = buildSyntheticUniverse(30, 20);
    const returns = computeForwardReturns(bars, 1);
    const result = computeIC(factors, returns);
    expect(result.meanIC).not.toBeNull();
    expect(result.meanIC!).toBeGreaterThan(0.5);
    expect(result.tStat).not.toBeNull();
    expect(Math.abs(result.tStat!)).toBeGreaterThan(3);
  });

  it('negative control (leakage): a factor that IS tomorrow\'s return (perfect foresight) produces IC ~= 1 -- proves the harness can detect a real relationship, it is not silently blind', () => {
    const { bars } = buildSyntheticUniverse(20, 15);
    const returns = computeForwardReturns(bars, 1);
    // The "leaky" factor is literally the forward return itself.
    const leakyFactor: FactorPoint[] = returns
      .filter((r) => r.forwardReturn !== null)
      .map((r) => ({ symbol: r.symbol, sessionDate: r.sessionDate, value: r.forwardReturn }));
    const result = computeIC(leakyFactor, returns);
    expect(result.meanIC).not.toBeNull();
    expect(result.meanIC!).toBeGreaterThan(0.99);
  });

  it('negative control (known-null): an entirely-NULL factor produces no dates, not a fabricated IC/t-stat', () => {
    const { bars } = buildSyntheticUniverse(20, 10);
    const returns = computeForwardReturns(bars, 1);
    const nullFactor: FactorPoint[] = returns.map((r) => ({ symbol: r.symbol, sessionDate: r.sessionDate, value: null }));
    const result = computeIC(nullFactor, returns);
    expect(result.nDates).toBe(0);
    expect(result.meanIC).toBeNull();
    expect(result.tStat).toBeNull();
    expect(Number.isNaN(result.meanIC)).toBe(false);
  });

  it('excludes illiquid names via the ADT floor', () => {
    const bars = [bar('LIQUID', '2026-01-01', 100, ADT_LIQUID), bar('LIQUID', '2026-01-02', 110, ADT_LIQUID),
      bar('ILLIQUID', '2026-01-01', 100, 1), bar('ILLIQUID', '2026-01-02', 999999, 1)];
    const returns = computeForwardReturns(bars, 1);
    const factors: FactorPoint[] = [{ symbol: 'LIQUID', sessionDate: '2026-01-01', value: 1 }, { symbol: 'ILLIQUID', sessionDate: '2026-01-01', value: 2 }];
    const result = computeIC(factors, returns);
    // Only 1 liquid name on the date -> too few (<5) to rank -> no dates.
    expect(result.nDates).toBe(0);
  });
});

describe('computeAnnualizedExcessReturn -- benchmark negative control', () => {
  // A permanent, ever-compounding rank->drift relationship (buildSyntheticUniverse
  // above) is unrealistic here: with genuine geometric compounding, "mean
  // excess return per period x periods/year" simply isn't the same number
  // at different period lengths even with a perfectly correct implementation
  // -- that's a property of compounding, not evidence of the predecessor's
  // actual bug (a wrong benchmark/exit-pricing computation). This control
  // instead uses a factor that changes every session (no persistent
  // winners) driving small ADDITIVE price moves, so the "edge per unit
  // time" is genuinely constant and rebalance-invariant, the way a real,
  // non-persistent factor edge behaves.
  function buildRebalanceInvariantUniverse(nSymbols: number, nSessions: number): { bars: OpenPriceRow[]; factors: FactorPoint[] } {
    const bars: OpenPriceRow[] = [];
    const factors: FactorPoint[] = [];
    const price = new Array(nSymbols).fill(100);
    for (let d = 0; d < nSessions; d++) {
      const sessionDate = `D${String(d + 1).padStart(5, '0')}`;
      for (let s = 0; s < nSymbols; s++) {
        const symbol = `SYM${s}`;
        bars.push(bar(symbol, sessionDate, price[s]!));
        const factorValue = pseudoNoise(s, d);
        factors.push({ symbol, sessionDate, value: factorValue });
        price[s] = price[s]! + 0.05 * factorValue;
      }
    }
    return { bars, factors };
  }

  it('rebalance-1 and rebalance-21 results agree within ~5pp/yr for the same real factor -- the predecessor\'s exact bug (wrong benchmark) made these diverge by ~35pp/yr', () => {
    // rebalance-21 only gets one independent sample every 21 sessions, so
    // this needs enough history for that to be a stable estimate (~25+
    // periods) -- a short synthetic window is exactly the "dramatic number
    // from a small sample" trap measurement.md warns about, not a real
    // benchmark bug.
    const { bars, factors } = buildRebalanceInvariantUniverse(30, 600);
    const returns1 = computeForwardReturns(bars, 1);
    const returns21 = computeForwardReturns(bars, 21);
    const r1 = computeAnnualizedExcessReturn(factors, returns1, 1, 10);
    const r21 = computeAnnualizedExcessReturn(factors, returns21, 21, 10);
    expect(r1.annualizedExcessReturnPct).not.toBeNull();
    expect(r21.annualizedExcessReturnPct).not.toBeNull();
    const diff = Math.abs(r1.annualizedExcessReturnPct! - r21.annualizedExcessReturnPct!);
    expect(diff).toBeLessThan(5);
  });
});

describe('computeNetAnnualizedExcessReturn -- Task 5.0.1 cost/turnover negative control', () => {
  const K = 10;
  const N_SYMBOLS = 2 * K;
  const N_SESSIONS = 100;
  const REBALANCE = 5;
  const COST_BPS = 25;

  // Every rebalance period, factor value flips WHICH half of the universe
  // scores highest -- guarantees the top-K set has zero overlap with the
  // previous period's top-K, i.e. exactly 100% one-way turnover.
  function build100PctTurnoverUniverse(): { bars: OpenPriceRow[]; factors: FactorPoint[] } {
    const bars: OpenPriceRow[] = [];
    const factors: FactorPoint[] = [];
    for (let d = 0; d < N_SESSIONS; d++) {
      const sessionDate = `D${String(d + 1).padStart(5, '0')}`;
      const periodIndex = Math.floor(d / REBALANCE);
      for (let s = 0; s < N_SYMBOLS; s++) {
        const symbol = `SYM${s}`;
        bars.push(bar(symbol, sessionDate, 100)); // flat price -> ~0 gross return always
        const highHalf = (s + periodIndex) % 2 === 0;
        factors.push({ symbol, sessionDate, value: highHalf ? 1 : 0 });
      }
    }
    return { bars, factors };
  }

  // Factor value is a fixed, never-changing symbol index -- same top-K
  // every single rebalance, i.e. 0% turnover after the first period.
  function build0PctTurnoverUniverse(): { bars: OpenPriceRow[]; factors: FactorPoint[] } {
    const bars: OpenPriceRow[] = [];
    const factors: FactorPoint[] = [];
    for (let d = 0; d < N_SESSIONS; d++) {
      const sessionDate = `D${String(d + 1).padStart(5, '0')}`;
      for (let s = 0; s < N_SYMBOLS; s++) {
        const symbol = `SYM${s}`;
        bars.push(bar(symbol, sessionDate, 100));
        factors.push({ symbol, sessionDate, value: s }); // fixed rank, forever
      }
    }
    return { bars, factors };
  }

  it('100% turnover: net excess collapses toward gross - costBps/10000 every period', () => {
    const { bars, factors } = build100PctTurnoverUniverse();
    const returns = computeForwardReturns(bars, REBALANCE);
    const result = computeNetAnnualizedExcessReturn(factors, returns, REBALANCE, K, COST_BPS);
    expect(result.meanTurnover).not.toBeNull();
    expect(result.meanTurnover!).toBeCloseTo(1.0, 5);
    expect(result.meanExcessReturnPerPeriod).not.toBeNull();
    expect(result.meanNetExcessReturnPerPeriod).not.toBeNull();
    const expectedNet = result.meanExcessReturnPerPeriod! - (COST_BPS / 10_000) * 1.0;
    expect(result.meanNetExcessReturnPerPeriod!).toBeCloseTo(expectedNet, 6);
  });

  it('0% turnover: net excess is (almost) unchanged from gross -- no cost is deducted for a portfolio that never trades', () => {
    const { bars, factors } = build0PctTurnoverUniverse();
    const returns = computeForwardReturns(bars, REBALANCE);
    const result = computeNetAnnualizedExcessReturn(factors, returns, REBALANCE, K, COST_BPS);
    expect(result.meanTurnover).not.toBeNull();
    expect(result.meanTurnover!).toBeCloseTo(0, 5);
    expect(result.meanNetExcessReturnPerPeriod!).toBeCloseTo(result.meanExcessReturnPerPeriod!, 6);
  });

  it('negative control: the cost model is actually subtracted, not silently ignored -- net must be strictly worse than gross whenever turnover > 0', () => {
    const { bars, factors } = build100PctTurnoverUniverse();
    const returns = computeForwardReturns(bars, REBALANCE);
    const result = computeNetAnnualizedExcessReturn(factors, returns, REBALANCE, K, COST_BPS);
    expect(result.meanNetExcessReturnPerPeriod!).toBeLessThan(result.meanExcessReturnPerPeriod!);
  });
});
