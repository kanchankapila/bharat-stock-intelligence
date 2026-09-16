import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * registerJob() calls cfg.monitorFn(name, status, detail, durationMs). An inline wrapper that
 * declares only (_name, status, detail) silently drops the duration, so job_run_history.duration_ms
 * stayed NULL on every run of dl-engine-infer, dl-trainer and regime-detector (AF-20260913-06) --
 * which is how a dl-trainer run came to look like it took ~0 minutes.
 */
const SERVER = join(__dirname, '..');
const files = [
  join(SERVER, 'queues.ts'),
  ...readdirSync(join(SERVER, 'jobs')).filter((f) => f.endsWith('.ts')).map((f) => join(SERVER, 'jobs', f)),
];

describe('monitorFn wrappers forward durationMs', () => {
  const wrappers: { file: string; params: string[]; text: string }[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/monitorFn:\s*\(([^)]*)\)\s*=>([^\n]*)/g)) {
      wrappers.push({ file, params: m[1].split(',').map((p) => p.trim()).filter(Boolean), text: m[0] });
    }
  }

  it('finds the inline wrappers (non-vacuity)', () => {
    expect(wrappers.length).toBeGreaterThanOrEqual(3);
  });

  it('every inline wrapper accepts and passes the 4th (duration) argument', () => {
    const bad = wrappers.filter((w) => w.params.length < 4 || !w.text.includes(w.params[3].split(':')[0].trim()));
    expect(bad.map((w) => w.text)).toEqual([]);
  });
});
