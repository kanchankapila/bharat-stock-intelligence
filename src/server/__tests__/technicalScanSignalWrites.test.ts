import { describe, it, expect } from 'vitest';
import { scanSignalWrites } from '../technicalSignalsService';
import type { SignalResult, TechSignal } from '../technicalSignalsService';

// AF-20261001-10/-11. Live Sept 2026: 3,699/3,699 technical_scan unified_signals rows had no
// target (the mirror passed a literal null), 68/76 recommendation_log rows had stop_loss = NaN
// (parseFloat('₹60.33')), every target_1 was truncated to whole rupees, and the label was a
// hardcoded 'BUY' even when inferSetupDirection() built short geometry.

const sig = (type: TechSignal['type']): TechSignal => ({ type, strength: 'MEDIUM', detail: '' });

const result = (over: Partial<SignalResult>): SignalResult => ({
  symbol: 'X', cmp: 65, changePct: 0, rsi: 50, sma50: 0, sma200: 0, macd: 0, macdSignal: 0,
  bbWidth: 0, volumeRatio: 1, aboveSma200: true, adx: 20, niftyRegime: 'BULL',
  signals: [sig('GOLDEN_CROSS')], signalScore: 6, ...over,
});

describe('scanSignalWrites', () => {
  it('long setup: BUY with the computed target and stop, same numbers in both tables', () => {
    const w = scanSignalWrites(result({ stopLoss: '₹60.33', targets: '₹70.55' }));
    expect(w.signalType).toBe('BUY');
    expect(w.entry).toBe(65);
    expect(w.target).toBe(70.55);
    expect(w.stop).toBe(60.33);
    expect(w.recLog).toEqual({ stop: 60.33, t1: 70.55, t2: 76.1, t3: 81.65 });
  });

  it('thousands separator survives', () => {
    const w = scanSignalWrites(result({ cmp: 1250, stopLoss: '₹1,212.50', targets: '₹1,312.75' }));
    expect(w.target).toBe(1312.75);
    expect(w.recLog?.stop).toBe(1212.5);
  });

  it('short setup is labelled SELL with short geometry and kept out of long-only recommendation_log', () => {
    const w = scanSignalWrites(result({
      signals: [sig('DEATH_CROSS'), sig('DISTRIBUTION_DAY'), sig('GOLDEN_CROSS')],
      stopLoss: '₹68.90', targets: '₹59.15',
    }));
    expect(w.signalType).toBe('SELL');
    expect(w.target!).toBeLessThan(w.entry!);
    expect(w.stop!).toBeGreaterThan(w.entry!);
    expect(w.recLog).toBeNull();
  });

  it('no setup computed: geometry is null, never NaN', () => {
    const w = scanSignalWrites(result({}));
    expect(w.target).toBeNull();
    expect(w.stop).toBeNull();
    expect(w.recLog).toEqual({ stop: null, t1: null, t2: null, t3: null });
  });

  // The mirror that writes these rows to unified_signals must treat "has levels" as the definition
  // of actionable. Expressed against the same predicate the writer uses so the two cannot drift:
  // a positive score with no target/stop is a ranking, and publishing it as a BUY creates a row no
  // resolver can ever close (measured 2026-10-01: 7,223 such technical_scan BUYs sat ACTIVE, the
  // newest written that same day).
  describe('actionable geometry gate', () => {
    const isActionable = (w: ReturnType<typeof scanSignalWrites>) => w.target != null && w.stop != null;

    it('rejects a positive score whose setup has no levels', () => {
      const w = scanSignalWrites(result({ signalScore: 6 }));
      expect(w.signalType).toBe('BUY');
      expect(isActionable(w)).toBe(false);
    });

    it('accepts the same score once target and stop exist', () => {
      const w = scanSignalWrites(result({ signalScore: 6, stopLoss: '₹60.33', targets: '₹70.55' }));
      expect(isActionable(w)).toBe(true);
    });

    it('rejects a half-plan: a target without a stop is not actionable', () => {
      // The AF-20261001-07 failure shape on the writing side — one level is not a trade plan.
      const targetOnly = scanSignalWrites(result({ signalScore: 6, targets: '₹70.55' }));
      expect(targetOnly.target).not.toBeNull();
      expect(isActionable(targetOnly)).toBe(false);
      const stopOnly = scanSignalWrites(result({ signalScore: 6, stopLoss: '₹60.33' }));
      expect(stopOnly.stop).not.toBeNull();
      expect(isActionable(stopOnly)).toBe(false);
    });

    it('accepts short geometry, so the gate does not quietly become long-only', () => {
      const w = scanSignalWrites(result({
        signalScore: 6,
        signals: [sig('DEATH_CROSS'), sig('DISTRIBUTION_DAY'), sig('GOLDEN_CROSS')],
        stopLoss: '₹68.90', targets: '₹59.15',
      }));
      expect(w.signalType).toBe('SELL');
      expect(isActionable(w)).toBe(true);
    });
  });
});
