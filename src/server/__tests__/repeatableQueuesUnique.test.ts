/**
 * No two registerRepeatableJob() calls may share a queue.
 *
 * registerRepeatableJob removes EVERY repeatable on its queue before adding its own, so a second
 * registration on the same queue silently deletes the first one's schedule on every boot.
 * Live 2026-09-11: digests.jobs.ts registered job-digest-daily and job-digest-morning on the one
 * 'job-digest' queue; Redis held only the morning schedule, and the nightly 22:50 digest had not
 * fired on its cron since the morning one was added on 2026-09-02 -- it only ran as a boot-time
 * catch-up at whatever hour the server happened to restart.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER_DIR = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['__tests__', 'tests', 'node_modules'].includes(e.name) ? [] : sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('repeatable job registrations', () => {
  it('each registerRepeatableJob() call uses its own queue', () => {
    const files = sourceFiles(SERVER_DIR).map(f => ({ f, src: fs.readFileSync(f, 'utf8') }));

    const constants = new Map<string, string>();
    for (const { src } of files) {
      for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']+)'/g)) constants.set(m[1], m[2]);
    }

    const byQueue = new Map<string, string[]>();
    const unparsed: string[] = [];
    for (const { f, src } of files) {
      for (const call of src.matchAll(/registerRepeatableJob\(\s*\{/g)) {
        const where = `${path.relative(SERVER_DIR, f)}:${src.slice(0, call.index).split('\n').length}`;
        const body = src.slice(call.index!, call.index! + 600);
        const q = body.match(/queueName:\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*))/);
        const name = q && (q[1] ?? constants.get(q[2]));
        if (!name) { unparsed.push(where); continue; }
        byQueue.set(name, [...(byQueue.get(name) ?? []), where]);
      }
    }

    // A registration this scan cannot resolve is one it cannot check -- fail rather than skip it.
    expect(unparsed).toEqual([]);
    // Non-vacuity: the scan must actually find the platform's registrations.
    expect(byQueue.size).toBeGreaterThan(20);
    const shared = [...byQueue].filter(([, sites]) => sites.length > 1);
    expect(shared).toEqual([]);
  });
});
