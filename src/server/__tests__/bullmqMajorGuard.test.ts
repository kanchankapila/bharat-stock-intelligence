import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AF-20261004-05: every scheduled job here is registered through BullMQ's legacy repeatable-job
// APIs (repeat: { pattern } and the matching remove calls). That is accepted debt, not a defect, as
// long as BullMQ stays on major 5. A v6 upgrade must first migrate the registrations to
// stable-ID Job Schedulers (upsertJobScheduler) behind parity tests, so this fails the day
// package.json or the installed package reaches major 6 and sends whoever upgrades to that row.
const ROOT = join(__dirname, '..', '..', '..');
const major = (v: string) => Number(/(\d+)\./.exec(v.replace(/^[^\d]*/, ''))?.[1]);

describe('bullmq stays on major 5 until the Job Scheduler migration lands', () => {
  it('package.json does not allow major 6 or later', () => {
    const range = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies.bullmq as string;
    expect(range, 'bullmq missing from dependencies').toBeTruthy();
    expect(range, 'an open-ended range (>=, *, latest) would let a v6 in').toMatch(/^[\^~]?5\./);
  });

  it('the installed package is major 5', () => {
    const installed = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'bullmq', 'package.json'), 'utf8')).version as string;
    expect(major(installed), `installed bullmq ${installed}: migrate to upsertJobScheduler first (AF-20261004-05)`).toBe(5);
  });

  it('the helper reads a major from a range or a version', () => {
    expect(major('^5.76.7')).toBe(5);
    expect(major('6.0.1')).toBe(6);
    expect(major('~5.1.0')).toBe(5);
  });
});
