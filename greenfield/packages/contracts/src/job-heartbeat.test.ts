// Task 1.3 Verify: "a test proving a skipped result leaves last_success_at
// unchanged." Negative-controlled by hand during development -- see
// docs/session-log.md for the actual revert-confirm-restore run.
import { expect, test } from 'vitest';
import { lastSuccessAt, type RunRecord } from './job-heartbeat.js';

test('lastSuccessAt ignores a later skipped run', () => {
  const runs: RunRecord[] = [
    { status: 'succeeded', startedAt: '2026-08-12T14:00:00Z' },
    { status: 'skipped', startedAt: '2026-08-13T14:00:00Z' },
  ];
  expect(lastSuccessAt(runs)).toBe('2026-08-12T14:00:00Z');
});

test('lastSuccessAt ignores a later degraded or failed run too', () => {
  const runs: RunRecord[] = [
    { status: 'succeeded', startedAt: '2026-08-11T14:00:00Z' },
    { status: 'degraded', startedAt: '2026-08-12T14:00:00Z' },
    { status: 'failed', startedAt: '2026-08-13T14:00:00Z' },
  ];
  expect(lastSuccessAt(runs)).toBe('2026-08-11T14:00:00Z');
});

test('lastSuccessAt returns null when there has never been a success', () => {
  const runs: RunRecord[] = [
    { status: 'skipped', startedAt: '2026-08-12T14:00:00Z' },
    { status: 'failed', startedAt: '2026-08-13T14:00:00Z' },
  ];
  expect(lastSuccessAt(runs)).toBeNull();
});

test('lastSuccessAt picks the MOST RECENT success, not the first', () => {
  const runs: RunRecord[] = [
    { status: 'succeeded', startedAt: '2026-08-10T14:00:00Z' },
    { status: 'failed', startedAt: '2026-08-11T14:00:00Z' },
    { status: 'succeeded', startedAt: '2026-08-12T14:00:00Z' },
  ];
  expect(lastSuccessAt(runs)).toBe('2026-08-12T14:00:00Z');
});
