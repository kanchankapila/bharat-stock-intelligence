import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// AF-20261113-03: jobWatchdog.checkAndAlertStaleScripts skips a script whose freshness probe failed
// (test: jobWatchdog.test.ts). That only works if getSystemStatus actually sets the flag, so pin
// the producer: a probe error must come back as probeFailed, and every status must carry it.
const src = readFileSync(new URL('../routers/monitor.router.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('monitor router probeFailed flag', () => {
  it('getLastRunAt reports a probe error as probeFailed instead of a bare null', () => {
    const at = src.indexOf('async function getLastRunAt');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, at + 1800);
    expect(body).toMatch(/catch \(err: unknown\)[\s\S]*probeFailed: true/);
    expect(body).toMatch(/probeFailed: false/);
  });

  it('every non-disabled status carries the probe flag', () => {
    expect(src).toMatch(/probeFailed: lastRunProbe\.probeFailed/);
  });
});
