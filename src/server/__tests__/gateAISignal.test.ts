import { describe, it, expect } from 'vitest';
import { gateAISignal } from '../signals';

describe('gateAISignal', () => {
  const THRESHOLD = 65;

  it('persists an actionable BUY above the confidence floor', () => {
    const r = gateAISignal({ signal: 'BUY', confidence: 80 }, THRESHOLD);
    expect(r).toEqual({ persist: true, signalType: 'BUY', reason: 'ok' });
  });

  it('persists an actionable SELL above the confidence floor', () => {
    const r = gateAISignal({ signal: 'SELL', confidence: 70 }, THRESHOLD);
    expect(r).toEqual({ persist: true, signalType: 'SELL', reason: 'ok' });
  });

  it('skips a BUY below the confidence floor', () => {
    const r = gateAISignal({ signal: 'BUY', confidence: 50 }, THRESHOLD);
    expect(r).toEqual({ persist: false, signalType: 'BUY', reason: 'low_confidence' });
  });

  it('skips HOLD regardless of confidence', () => {
    const r = gateAISignal({ signal: 'HOLD', confidence: 90 }, THRESHOLD);
    expect(r).toEqual({ persist: false, signalType: 'HOLD', reason: 'hold' });
  });

  it('treats a missing verdict as HOLD and skips (no phantom BUY)', () => {
    const r = gateAISignal({ confidence: 90 } as any, THRESHOLD);
    expect(r).toEqual({ persist: false, signalType: 'HOLD', reason: 'hold' });
  });

  it('skips when confidence is null/undefined (treated as 0)', () => {
    const r = gateAISignal({ signal: 'BUY', confidence: null } as any, THRESHOLD);
    expect(r).toEqual({ persist: false, signalType: 'BUY', reason: 'low_confidence' });
  });

  it('persists at the inclusive boundary (confidence === threshold)', () => {
    const r = gateAISignal({ signal: 'BUY', confidence: 65 }, THRESHOLD);
    expect(r).toEqual({ persist: true, signalType: 'BUY', reason: 'ok' });
  });

  it('normalizes lowercase and whitespace in the verdict', () => {
    const r = gateAISignal({ signal: '  buy  ', confidence: 70 } as any, THRESHOLD);
    expect(r).toEqual({ persist: true, signalType: 'BUY', reason: 'ok' });
  });
});
