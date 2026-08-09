import { describe, it, expect } from 'vitest';
import { gateOnQuant, DEFAULT_AI_SIGNAL_MIN_WIN_PROB } from '../signals';

describe('gateOnQuant (LLM demotion — quant-endorsement gate)', () => {
  const FLOOR = 0.40;

  it('persists when the quant win_probability clears the floor', () => {
    expect(gateOnQuant(0.73, FLOOR)).toEqual({ persist: true, reason: 'ok' });
    expect(gateOnQuant(0.40, FLOOR)).toEqual({ persist: true, reason: 'ok' });
  });

  it('drops when win_probability is below the floor', () => {
    expect(gateOnQuant(0.39, FLOOR)).toEqual({ persist: false, reason: 'low_win_prob' });
  });

  it('drops when the quant model did not score the stock (no win_probability)', () => {
    expect(gateOnQuant(null, FLOOR)).toEqual({ persist: false, reason: 'no_quant' });
    expect(gateOnQuant(undefined, FLOOR)).toEqual({ persist: false, reason: 'no_quant' });
    expect(gateOnQuant(NaN, FLOOR)).toEqual({ persist: false, reason: 'no_quant' });
  });
});

describe('DEFAULT_AI_SIGNAL_MIN_WIN_PROB (regression: 2026-08-06 alert-spam incident)', () => {
  it('is set above the known degenerate calibration plateau (~0.4064), not at/below it', () => {
    // 0.40 sits ON the plateau most of the universe's calibrated_win_probability collapses to
    // (see signals.ts's comment) -- at that floor, gateOnQuant lets ~95% of the universe
    // through instead of a selective handful/day. Pinning this here so the default can never
    // silently drift back down to 0.40 (or anything <= the plateau) without a test failing.
    expect(DEFAULT_AI_SIGNAL_MIN_WIN_PROB).toBeGreaterThan(0.4064);
  });

  it('reproduces the incident: the plateau value passes at the old 0.40 floor but not the fixed default', () => {
    const PLATEAU_WIN_PROB = 0.4064;
    expect(gateOnQuant(PLATEAU_WIN_PROB, 0.40).persist).toBe(true); // the bug
    expect(gateOnQuant(PLATEAU_WIN_PROB, DEFAULT_AI_SIGNAL_MIN_WIN_PROB).persist).toBe(false); // the fix
  });
});
