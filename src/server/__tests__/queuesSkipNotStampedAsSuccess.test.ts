import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AF-20261002-04: a worker whose processor can return { skipped: true } must not have its
// 'completed' handler stamp a success heartbeat unconditionally. jobHeartbeat.ts records the
// design ("a skip is deliberately NOT stamped as a success") and forgives the idle occurrence in
// the lateness math instead. On 2026-10-02 (an NSE holiday) the unified-ranker's 22:30 slot
// returned { skipped: true } and its handler stamped `success` with duration 0 s, overwriting the
// morning closed-day run's real verdict; the news-sentiment worker does the same for its three
// "-hot" results-season variants. check_recurring_bugs.py's skip-not-success check cannot see this
// layout (processor and handler are separate closures on one worker), hence a source-derived scan.

export function scanSkipStamping(src: string): { skippers: string[]; offenders: string[] } {
  const skippers: string[] = [];
  const offenders: string[] = [];
  const handler = /(\w+)\.on\('completed',\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g;
  for (let m: RegExpExecArray | null; (m = handler.exec(src)); ) {
    const worker = m[1];
    const before = src.slice(0, m.index);
    const decl = new RegExp(`\\b${worker}\\s*=\\s*new Worker\\(`, 'g');
    let declAt = -1;
    for (let d: RegExpExecArray | null; (d = decl.exec(before)); ) declAt = d.index;
    if (declAt < 0) continue;
    if (!/skipped:\s*true/.test(before.slice(declAt))) continue; // this worker's processor never skips
    skippers.push(worker);
    const rest = src.slice(m.index + m[0].length);
    const end = rest.search(/\n\s*\}\);/);
    const body = end === -1 ? rest.slice(0, 600) : rest.slice(0, end);
    if (/recordHeartbeat\([^)]*'success'/.test(body) && !/skipped|returnvalue/.test(body)) offenders.push(worker);
  }
  return { skippers, offenders };
}

describe('queues.ts: a skipped run is not stamped as a success', () => {
  const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
  const { skippers, offenders } = scanSkipStamping(src);

  it('the scan is not vacuous: it finds the workers whose processors can skip', () => {
    expect(skippers).toEqual(expect.arrayContaining(['unifiedRankerWorkerInstance', 'newsSentimentWorker']));
  });

  it('no skip-capable worker stamps success without looking at the result', () => {
    expect(offenders).toEqual([]);
  });

  it('the scan does flag the pre-fix shape', () => {
    const preFix = `
      const w = new Worker('q', async () => { return { skipped: true }; }, {});
      w.on('completed', (job) => {
        recordHeartbeat('j', 'success', undefined, 1);
      });`;
    expect(scanSkipStamping(preFix).offenders).toEqual(['w']);
  });

  it('mover capture has one success writer: the completed handler', () => {
    // AF-20261005: processMoverCapture stamped success after runPython and moverWorker's
    // completed handler stamped it again 81 ms later. That made one real run look like two.
    const processorAt = src.indexOf('async function processMoverCapture');
    const processorEnd = src.indexOf('/**\n * Overall execution budget', processorAt);
    expect(processorAt).toBeGreaterThanOrEqual(0);
    expect(processorEnd).toBeGreaterThan(processorAt);
    expect(src.slice(processorAt, processorEnd)).not.toContain("recordHeartbeat('mover-screener-capture', 'success'");

    const workerAt = src.indexOf('moverWorker = new Worker');
    const workerEnd = src.indexOf('Mover INTRADAY slot capture', workerAt);
    const workerBlock = src.slice(workerAt, workerEnd);
    expect(workerBlock.match(/recordHeartbeat\('mover-screener-capture', 'success'/g)).toHaveLength(1);
  });
});
