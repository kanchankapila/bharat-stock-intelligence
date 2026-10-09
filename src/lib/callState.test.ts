import { describe, expect, it } from 'vitest';
import { deriveCallState, calendarBlockedUntil } from './callState';

const report = (verdict: string, horizon = '5') => ({
  protocol_hash: 'abc',
  generated_at: '2026-10-08T21:27:09',
  blocks: { forward: { since: '2026-10-06', calls: 10, sessions: 2, tiers: {
    [horizon]: [
      { tier: 0.01, verdict: 'EDGE', eff_dates: 30 },
      { tier: 'published', verdict, eff_dates: 0.4 },
    ],
  } } },
});

describe('deriveCallState', () => {
  it('is UNPROVEN when neither the forward test nor the scorecard exists', () => {
    const s = deriveCallState(null, null);
    expect(s.state).toBe('UNPROVEN');
    expect(s.message).toMatch(/watch-list/i);
  });

  it('is UNPROVEN when the published tier is LOW-DATA, even if a narrow tier says EDGE', () => {
    expect(deriveCallState(report('LOW-DATA'), null).state).toBe('UNPROVEN');
  });

  it('is UNPROVEN when the scorecard is LOW-DATA although the forward test reads EDGE', () => {
    expect(deriveCallState(report('EDGE'), { verdict: 'LOW-DATA' }).state).toBe('UNPROVEN');
  });

  it('is NO_CALL when the published tier shows no edge or a negative one', () => {
    expect(deriveCallState(report('NO EDGE'), null).state).toBe('NO_CALL');
    expect(deriveCallState(report('NEGATIVE'), null).state).toBe('NO_CALL');
  });

  it('is EDGE only when the published 5d tier verdict is EDGE', () => {
    const s = deriveCallState(report('EDGE'), null);
    expect(s.state).toBe('EDGE');
    expect(s.message).toMatch(/rank/i);
  });

  it('is UNPROVEN when the report has no 5d published row', () => {
    expect(deriveCallState(report('EDGE', '10'), null).state).toBe('UNPROVEN');
  });
});

describe('calendarBlockedUntil', () => {
  it('counts weekdays: 20 windows x 5 sessions from a Tuesday start', () => {
    // 100 weekdays after Tue 2026-10-06 is Tue 2027-02-23 (exchange holidays push it later)
    expect(calendarBlockedUntil('2026-10-06', 5, 20)).toBe('2027-02-23');
  });
  it('returns null for a missing start date', () => {
    expect(calendarBlockedUntil(null, 5, 20)).toBeNull();
  });
});
