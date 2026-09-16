import { describe, it, expect } from 'vitest';
import { resolveSignalOutcome } from '../signals';

/**
 * unified_signals has never had ONE signal_type vocabulary:
 *   technical_analysis_engine.py       -> 'Bullish' / 'Bearish' / 'Neutral'
 *   screener_signal_generator.py       -> 'SCREENER_ENTRY' / 'SECTOR_SCREENER_CONFLUENCE'
 *   everything else                    -> 'BUY' / 'SELL'
 *
 * updateSignalAccuracy used `if (signal_type === 'BUY') ... else if (=== 'SELL')`, so every
 * other spelling fell through with status untouched. Measured live 2026-08-16: signal_source
 * 'technical' was 24,442 rows / 100% ACTIVE with 0 COMPLETED and 0 FAILED, and
 * SCREENER_SURFACING another 1,243, while AI / technical_scan / screener all resolved normally.
 *
 * resolveSignalOutcome reads DIRECTION FROM GEOMETRY (target above or below stop) so it needs
 * no vocabulary list at all -- a hand-enumerated allowlist "only guards what someone remembered
 * to list", and this column has grown a new spelling twice already.
 *
 * Negative control (run 2026-08-16): with the old BUY/SELL string branches restored, the
 * "long-style geometry" and "short-style geometry" cases below still resolve (they were the
 * BUY/SELL cases), but any caller passing a Bullish/Bearish row resolved to null forever --
 * which is the bug. The tests that pin the fix are the ones asserting a resolution for rows
 * whose signal_type is NOT BUY/SELL; those are unreachable through the old code path.
 */
describe('resolveSignalOutcome', () => {
  // Long: target above entry, stop below (what a 'BUY' and a 'Bullish' row both carry).
  const LONG = { target: 110, stop: 90 };
  // Short: target below, stop above ('SELL', 'Bearish').
  const SHORT = { target: 90, stop: 110 };

  it('long geometry completes when price reaches the target', () => {
    expect(resolveSignalOutcome(110, LONG.target, LONG.stop)).toBe('COMPLETED');
    expect(resolveSignalOutcome(115, LONG.target, LONG.stop)).toBe('COMPLETED');
  });

  it('long geometry fails when price hits the stop', () => {
    expect(resolveSignalOutcome(90, LONG.target, LONG.stop)).toBe('FAILED');
    expect(resolveSignalOutcome(85, LONG.target, LONG.stop)).toBe('FAILED');
  });

  it('short geometry inverts both tests', () => {
    expect(resolveSignalOutcome(90, SHORT.target, SHORT.stop)).toBe('COMPLETED');
    expect(resolveSignalOutcome(110, SHORT.target, SHORT.stop)).toBe('FAILED');
  });

  it('stays open between the levels, in both directions', () => {
    expect(resolveSignalOutcome(100, LONG.target, LONG.stop)).toBeNull();
    expect(resolveSignalOutcome(100, SHORT.target, SHORT.stop)).toBeNull();
  });

  it('resolves a row regardless of which signal_type vocabulary produced it', () => {
    // The whole point: these are the geometry a 'Bullish' and a 'Bearish' row carry (see
    // technical_analysis_engine.py's compute_atr_barriers 'long'/'short' branches). The old
    // string-matching code returned nothing for them no matter the price.
    expect(resolveSignalOutcome(120, 110, 90)).toBe('COMPLETED');   // 'Bullish'
    expect(resolveSignalOutcome(80, 90, 110)).toBe('COMPLETED');    // 'Bearish'
    expect(resolveSignalOutcome(120, 130, 95)).toBeNull();          // 'SCREENER_ENTRY', still open
  });

  it('refuses to guess when levels are missing or give no direction', () => {
    // SECTOR_SCREENER_CONFLUENCE rows carry neither level — they must stay unresolved rather
    // than be coerced into a direction.
    expect(resolveSignalOutcome(100, null, null)).toBeNull();
    expect(resolveSignalOutcome(100, 110, null)).toBeNull();
    expect(resolveSignalOutcome(100, null, 90)).toBeNull();
    expect(resolveSignalOutcome(100, 100, 100)).toBeNull();
  });

  it('does not resolve on a non-finite price or level', () => {
    expect(resolveSignalOutcome(NaN, 110, 90)).toBeNull();
    expect(resolveSignalOutcome(100, NaN, 90)).toBeNull();
    expect(resolveSignalOutcome(100, 110, NaN)).toBeNull();
  });
});
