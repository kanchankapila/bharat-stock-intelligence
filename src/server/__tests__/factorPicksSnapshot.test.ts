import { describe, expect, it } from 'vitest';
import { parseFactorPicksSnapshot } from '../routers/screeners.router';

describe('parseFactorPicksSnapshot', () => {
  it('accepts the validated paper-screen payload', () => {
    const result = parseFactorPicksSnapshot(JSON.stringify({
      factor: 'momentum_12_1',
      asOf: '2026-08-10',
      generatedAt: '2026-08-10T12:00:00Z',
      validatedTopKMin: 50,
      evidence: 'paper_trade_candidate',
      caveat: 'Research screen only.',
      picks: [{ symbol: 'RELIANCE', date: '2026-08-10T00:00:00', score: 1.25, close: 1400 }],
    }));
    expect(result?.picks[0].symbol).toBe('RELIANCE');
  });

  it.each([undefined, '', '{bad json', JSON.stringify({ factor: 'momentum_21d', picks: [] })])(
    'fails closed for missing or malformed snapshots',
    (value) => expect(parseFactorPicksSnapshot(value)).toBeNull(),
  );
});