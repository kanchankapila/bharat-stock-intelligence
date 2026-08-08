import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the 2026-08-07 dead-column fix: corporate_actions.ratio had a real,
 * working writer (ohlcv_quality.py's ingest_corporate_actions(), live-verified: real split
 * ratios like HDFCBANK 2025 1:2, WIPRO 2024 1:2, RELIANCE 2024 1:2) that was NEVER scheduled
 * with ingest enabled -- both existing ohlcv_quality.py calls pass --no-ingest for the daily
 * bad-bar-flagging run's performance. corporate_actions.ratio was 0/389 rows before this.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'jobs', 'sync.jobs.ts'), 'utf8');

describe('corporate-actions-ingest-weekly wiring', () => {
  it('calls ohlcv_quality.py WITHOUT --no-ingest (the whole point -- ingest must run)', () => {
    // Checks the actual runPython() call's args array is empty, not just "no --no-ingest
    // string anywhere in the function" -- the function's own explanatory comment legitimately
    // mentions --no-ingest (describing why the OTHER two call sites use it), so a bare
    // string-absence check would false-fail on that comment.
    const callMatch = SOURCE.match(/runPython\('ohlcv_quality\.py',\s*(\[[^\]]*\]),/);
    expect(callMatch).not.toBeNull();
    expect(callMatch![1]).toBe('[]');
  });

  it('is registered as its own weekly repeatable job', () => {
    expect(SOURCE).toMatch(/queueName: QUEUE_CORPORATE_ACTIONS_INGEST/);
    expect(SOURCE).toMatch(/jobName: 'corporate-actions-ingest-weekly'/);
  });

  it('does not collide with tickertape-scorecard-weekly or nse-sync-weekly on the same minute', () => {
    // tickertape-scorecard-weekly: '0 13 * * 6'; nse-sync-weekly: '0 2 * * 0'
    const ingestMatch = SOURCE.match(/jobName: 'corporate-actions-ingest-weekly'[\s\S]*?repeat: \{ pattern: '([^']+)' \}/);
    expect(ingestMatch).not.toBeNull();
    expect(ingestMatch![1]).not.toBe('0 13 * * 6');
    expect(ingestMatch![1]).not.toBe('0 2 * * 0');
  });

  it('lockDuration is generously wider than the runPython timeout it wraps', () => {
    const ingestIdx = SOURCE.indexOf('queueName: QUEUE_CORPORATE_ACTIONS_INGEST');
    expect(ingestIdx).toBeGreaterThan(-1);
    const block = SOURCE.slice(ingestIdx, ingestIdx + 900);
    const lockMatch = block.match(/lockDuration:\s*([\d.]+)\s*\*\s*60_000/);
    expect(lockMatch).not.toBeNull();
    const lockMinutes = Number(lockMatch![1]);

    const fnMatch = SOURCE.match(/runPython\('ohlcv_quality\.py', \[\],\s*([\d.]+)\s*\*\s*60_000\)/);
    expect(fnMatch).not.toBeNull();
    const timeoutMinutes = Number(fnMatch![1]);
    expect(lockMinutes).toBeGreaterThan(timeoutMinutes);
  });
});
