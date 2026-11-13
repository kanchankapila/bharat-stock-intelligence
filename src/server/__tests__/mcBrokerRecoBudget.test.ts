import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// AF-20260924-01: mc_broker_reco_fetcher.py pages a throttled vendor up to 15 times with ~93 s
// of backoff per page, so its ml-daily-ops step needs a measured, explicit budget (15 min, about
// 3.9x the slower standalone run). A default (5 min) or a lower number puts the step back on the
// edge that failed it, so pin the call's third argument.
const src = readFileSync(new URL('../queues.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('mc_broker_reco_fetcher budget', () => {
  it('runs with an explicit 15 minute timeout', () => {
    const at = src.indexOf("runPython('mc_broker_reco_fetcher.py'");
    expect(at, 'call not found').toBeGreaterThan(0);
    const call = src.slice(at, src.indexOf(')', at + 60) + 1);
    expect(call).toMatch(/\['--days', '7'\],\s*15 \* 60_000\)/);
  });
});
