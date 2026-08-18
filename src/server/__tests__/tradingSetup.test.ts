import { describe, it, expect } from 'vitest';
import {
  inferSetupDirection, deriveSetupQuality, deriveTimeHorizon, parseMoneyToNumber,
} from '../technicalSignalsService';
import type { TechSignal } from '../technicalSignalsService';

// 2026-08-13: replaces getAIInsight (LLM-guessed entry_zone/stop_loss/targets, silently
// never ran since ANTHROPIC_API_KEY has been empty since inception -- 0/69,459 rows ever
// populated) with these deterministic helpers + atrBarriers.ts's already-measured engine.

const sig = (type: TechSignal['type'], strength: TechSignal['strength'] = 'MEDIUM'): TechSignal =>
  ({ type, strength, detail: '' });

describe('inferSetupDirection', () => {
  it('defaults long with no signals', () => {
    expect(inferSetupDirection([])).toBe('long');
  });

  it('stays long when bullish signals dominate', () => {
    const signals = [sig('GOLDEN_CROSS'), sig('WEEK_52_BREAKOUT'), sig('DEATH_CROSS')];
    expect(inferSetupDirection(signals)).toBe('long');
  });

  it('flips short when bearish signals are the majority', () => {
    const signals = [sig('DEATH_CROSS'), sig('RSI_BEARISH_DIVERGENCE'), sig('GOLDEN_CROSS')];
    expect(inferSetupDirection(signals)).toBe('short');
  });

  it('stays long on an exact tie (bearishCount > half is strict)', () => {
    const signals = [sig('DEATH_CROSS'), sig('GOLDEN_CROSS')];
    expect(inferSetupDirection(signals)).toBe('long');
  });
});

describe('deriveSetupQuality', () => {
  it('High when any signal is HIGH strength, regardless of others', () => {
    const signals = [sig('RSI_DIVERGENCE', 'WATCH'), sig('GOLDEN_CROSS', 'HIGH')];
    expect(deriveSetupQuality(signals)).toBe('High');
  });

  it('Medium when the strongest present is MEDIUM', () => {
    const signals = [sig('RSI_DIVERGENCE', 'WATCH'), sig('MACD_CROSSOVER', 'MEDIUM')];
    expect(deriveSetupQuality(signals)).toBe('Medium');
  });

  it('Low when nothing exceeds WATCH', () => {
    expect(deriveSetupQuality([sig('NR7_COMPRESSION', 'WATCH')])).toBe('Low');
  });
});

describe('deriveTimeHorizon', () => {
  it('Positional when a trend/structural signal fired', () => {
    expect(deriveTimeHorizon([sig('GOLDEN_CROSS')])).toBe('Positional (2-4W)');
    expect(deriveTimeHorizon([sig('WEEK_52_BREAKOUT')])).toBe('Positional (2-4W)');
  });

  it('Swing when only momentum/volatility triggers fired', () => {
    expect(deriveTimeHorizon([sig('BB_COMPRESSION'), sig('MACD_CROSSOVER')])).toBe('Swing (3-7D)');
  });
});

describe('parseMoneyToNumber', () => {
  // getTradingSetup() formats stopLoss/targets as "₹1239.39" for the Telegram digest, but
  // technical_signals.stop_loss is read back as a NUMBER by outcome_resolver.py's
  // CAST(... AS REAL) and the frontend's Number(pick.stop_loss) -- writing the ₹-formatted
  // string straight into the DB broke both (SQL cast error live-caught 2026-08-18: `invalid
  // input syntax for type double precision: "₹60.33"`; frontend rendered "SL ₹NaN").
  it('extracts the number out of a money-formatted string', () => {
    expect(parseMoneyToNumber('₹1239.39')).toBe(1239.39);
  });

  it('handles thousands separators', () => {
    expect(parseMoneyToNumber('₹12,345.67')).toBe(12345.67);
  });

  it('returns null for empty/undefined/null input', () => {
    expect(parseMoneyToNumber('')).toBeNull();
    expect(parseMoneyToNumber(undefined)).toBeNull();
    expect(parseMoneyToNumber(null)).toBeNull();
  });

  it('passes through an already-bare number string unchanged', () => {
    expect(parseMoneyToNumber('60.33')).toBe(60.33);
  });
});
