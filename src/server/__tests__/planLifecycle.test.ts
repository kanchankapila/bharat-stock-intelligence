import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planStatus } from '../planLifecycle';

// AF-20261008-06 item 4: ranker rows carry valid_until but no lifecycle status, and the picks the
// UI reads showed stop/target with nothing saying the plan had lapsed. The state is DERIVED from
// valid_until (no fifth signal table, no new column).
describe('planStatus', () => {
  const now = new Date('2026-10-08T10:00:00Z');

  it('is ACTIVE while valid_until is in the future', () => {
    expect(planStatus('2026-10-08T10:00:01Z', now)).toBe('ACTIVE');
    expect(planStatus(new Date('2026-10-09T10:00:00Z'), now)).toBe('ACTIVE');
  });

  it('is EXPIRED at and after valid_until', () => {
    expect(planStatus('2026-10-08T10:00:00Z', now)).toBe('EXPIRED');
    expect(planStatus('2026-10-07T10:00:00Z', now)).toBe('EXPIRED');
  });

  it('is UNKNOWN when no window was stamped or it cannot be parsed', () => {
    expect(planStatus(null, now)).toBe('UNKNOWN');
    expect(planStatus(undefined, now)).toBe('UNKNOWN');
    expect(planStatus('not-a-date', now)).toBe('UNKNOWN');
  });
});

describe('the plan readers actually use it', () => {
  const src = readFileSync(join(__dirname, '..', 'routers', 'commandCenter.router.ts'), 'utf8');

  it('both pick readers select valid_until and attach planStatus', () => {
    expect((src.match(/valid_until/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/planStatus\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
