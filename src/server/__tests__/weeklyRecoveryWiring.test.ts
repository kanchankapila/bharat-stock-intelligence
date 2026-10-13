import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const queues = fs.readFileSync(path.join(root, 'src/server/queues.ts'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'scripts/run_single_weekly_job.mjs'), 'utf8');

describe('weekly recovery wiring', () => {
  it('gives the measured mover study 45 minutes within its 75-minute lock', () => {
    expect(queues).toContain("runPython('reverse_engineering_study.py', ['--days', '250'], 2_700_000)");
    expect(queues).toContain('lockDuration: 75 * 60 * 1000');
  });

  it('persists parent heartbeat status for the NSE archive worker', () => {
    expect(queues).toContain("nseBulkBlockWorker.on('completed'");
    expect(queues).toContain("recordHeartbeat('nse-bulk-block', 'success'");
    expect(queues).toContain("nseBulkBlockWorker.on('failed'");
    expect(queues).toContain("recordHeartbeat('nse-bulk-block', 'failed'");
  });

  it('can trigger the NSE archive with its distinct queue job and monitor names', () => {
    expect(runner).toContain("'nse-bulk-block-daily'");
    expect(runner).toContain("monitorName: 'nse-bulk-block'");
  });
});
