import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// AF-20261112-10: ml-daily-ops ran 213 min against a 210 min budget and the per-step log lines
// carried no duration, so the 39 min of growth could not be attributed to a step. Every
// "[PY] <script> execution completed" line must say how long the child ran.
const src = readFileSync(new URL('../pythonRunner.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('runPython step duration logging', () => {
  it('the completion log line carries the child run time', () => {
    const at = src.indexOf('execution completed');
    expect(at, 'completion log line not found').toBeGreaterThan(0);
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/durationMs/);
  });

  it('every runner log line for a finished child carries the same run time, not only the one with stdout', () => {
    const at = src.indexOf('const durationMs = Date.now() - runStartedAt');
    expect(at, 'duration must be computed once before the log lines').toBeGreaterThan(0);
    const tail = src.slice(at, at + 3500);
    for (const marker of ['execution completed', '] ${script} completed`', 'encountered an error', 'const meta = {']) {
      const i = tail.indexOf(marker);
      expect(i, `log line "${marker}" not found`).toBeGreaterThan(0);
      expect(tail.slice(i, i + 260), `${marker} must carry durationMs`).toMatch(/durationMs/);
    }
  });

  it('the duration is measured from after the slots are acquired, not from the call', () => {
    const slots = src.indexOf('await acquirePythonSlot(script)');
    const start = src.indexOf('const runStartedAt = Date.now()');
    expect(start, 'run start stamp missing').toBeGreaterThan(slots);
  });
});
