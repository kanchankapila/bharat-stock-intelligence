import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('documentation inventory without a database', () => {
  it('checks filesystem counts without treating unavailable database counts as stale', () => {
    const output = execFileSync(process.execPath, ['scripts/docNumbers.mjs', '--check', '--offline'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
    });
    expect(output).toContain('unavailable (no DB)');
    expect(output).toContain('All checked doc numbers match');
  });
});
