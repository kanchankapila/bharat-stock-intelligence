import { describe, expect, it, vi } from 'vitest';

const dbAll = vi.fn();
vi.mock('../dbAsync', () => ({ dbAll: (...a: unknown[]) => dbAll(...a) }));

import { buildPlanEvents, fetchPlanEvents, istDay } from '../planEvents';

describe('buildPlanEvents (AF-20261117-14)', () => {
  const plans = [
    { symbol: 'DIV', validUntil: '2026-11-28T09:59:59.000Z' },
    { symbol: 'FNO', validUntil: '2026-11-21' },
    { symbol: 'NOPLAN', validUntil: null },
  ];
  const actions = [
    { symbol: 'DIV', action_type: 'dividend', event_date: '2026-11-24' },
    { symbol: 'DIV', action_type: 'split', event_date: '2026-12-15' },   // after the plan expires
    { symbol: 'DIV', action_type: 'bonus', event_date: '2026-11-10' },   // already past
    { symbol: 'NOPLAN', action_type: 'dividend', event_date: '2026-11-20' },
  ];

  it('tags only events between today and the plan expiry, in date order', () => {
    const out = buildPlanEvents(plans, actions, new Set(['DIV', 'FNO']), '2026-11-18', '2026-11-25');
    expect(out.get('DIV')).toEqual(['Ex-dividend 24 Nov', 'F&O expiry 25 Nov']);
    expect(out.has('FNO')).toBe(false);      // expiry 25 Nov is after its 21 Nov expiry
    expect(out.has('NOPLAN')).toBe(false);   // no valid_until, nothing to bound the window
  });

  it('reads valid_until on the IST calendar day', () => {
    expect(istDay('2026-11-28T20:00:00Z')).toBe('2026-11-29');
    expect(istDay(new Date('2026-11-28T10:00:00Z'))).toBe('2026-11-28');
    expect(istDay('garbage')).toBeNull();
  });
});

describe('fetchPlanEvents reads the daily corporate-action calendars (AF-20261119-20)', () => {
  it('tags an ex-date the weekly history has not crawled yet, once per event', async () => {
    dbAll.mockReset();
    dbAll.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('fno_eligible')) return [];
      // Declared Monday, ex Thursday: only the two daily calendars have it, both report it.
      expect(sql).toContain('FROM corporate_actions');
      expect(sql).toContain('FROM nse_filed_corporate_actions');
      expect(params.filter((p) => p === 'DIV')).toHaveLength(3);
      return [
        { symbol: 'DIV', action_type: 'dividend', event_date: '2026-11-26' },
        { symbol: 'DIV', action_type: 'dividend', event_date: '2026-11-26' },
      ];
    });
    const out = await fetchPlanEvents([{ symbol: 'DIV', validUntil: '2026-11-28' }], new Date('2026-11-23T04:00:00Z'));
    expect(out.get('DIV')).toEqual(['Ex-dividend 26 Nov']);
  });
});

