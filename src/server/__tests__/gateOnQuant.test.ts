import { describe, it, expect } from 'vitest';
import { gateOnQuant } from '../signals';

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
