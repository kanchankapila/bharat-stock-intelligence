import { describe, it, expect } from 'vitest';
import { atrBarriers, wilderATR } from '../atrBarriers';

describe('atrBarriers', () => {
  it('places long target above and stop below, 2.5:1.5 ATR', () => {
    // price 100, atr 4 → atrFrac 0.04; target 2.5*0.04=10% (within 3-15%),
    // stop 1.5*0.04=6% (within 2-8%)
    const b = atrBarriers(100, 4, 'long');
    expect(b.targetPrice).toBe(110);
    expect(b.stopLoss).toBe(94);
  });

  it('inverts levels for a short', () => {
    const b = atrBarriers(100, 4, 'short');
    expect(b.targetPrice).toBe(90);
    expect(b.stopLoss).toBe(106);
  });

  it('clamps a high-vol name to the target/stop caps (15% / 8%)', () => {
    // atr 20 on price 100 → raw target 50%, stop 30% → clamped to caps
    const b = atrBarriers(100, 20, 'long');
    expect(b.targetPrice).toBe(115);
    expect(b.stopLoss).toBe(92);
  });

  it('clamps a low-vol name to the target/stop floors (3% / 2%)', () => {
    // atr 0.1 on price 100 → raw target 0.25%, stop 0.15% → clamped to floors
    const b = atrBarriers(100, 0.1, 'long');
    expect(b.targetPrice).toBe(103);
    expect(b.stopLoss).toBe(98);
  });

  it('falls back to floors when ATR is missing (never degenerate)', () => {
    const b = atrBarriers(100, 0, 'long');
    expect(b.targetPrice).toBe(103);
    expect(b.stopLoss).toBe(98);
  });

  it('returns zeros for a non-positive price', () => {
    expect(atrBarriers(0, 4, 'long')).toEqual({ targetPrice: 0, stopLoss: 0 });
  });

  it('keeps a favourable reward:risk (>1) at every volatility level', () => {
    for (const atr of [0.1, 1, 4, 8, 20]) {
      const b = atrBarriers(100, atr, 'long');
      const reward = b.targetPrice - 100;
      const risk = 100 - b.stopLoss;
      expect(reward / risk).toBeGreaterThan(1);
    }
  });
});

describe('wilderATR', () => {
  it('returns 0 when history is shorter than period+1', () => {
    const bars = Array.from({ length: 10 }, () => ({ high: 2, low: 1, close: 1.5 }));
    expect(wilderATR(bars, 14)).toBe(0);
  });

  it('computes a constant ATR for a constant true range', () => {
    // Every bar has high-low = 2, and closes equal so TR = 2 each bar → ATR = 2
    const bars = Array.from({ length: 20 }, () => ({ high: 12, low: 10, close: 11 }));
    expect(wilderATR(bars, 14)).toBeCloseTo(2, 6);
  });

  it('reflects a widening range via Wilder smoothing', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({
      high: 100 + i, low: 100 + i - 1, close: 100 + i - 0.5,
    }));
    const atr = wilderATR(bars, 14);
    expect(atr).toBeGreaterThan(0);
    expect(atr).toBeLessThan(5); // gap+range stays modest
  });
});
