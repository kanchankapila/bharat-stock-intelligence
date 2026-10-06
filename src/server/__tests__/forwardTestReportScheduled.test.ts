import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The forward test is only worth anything if it runs every trading day (AF-20261006-03). A scan that finds the
// step in queues.ts keeps a refactor from silently dropping it; the freshness DQ check catches it at runtime.
const SRC = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');

describe('forward_test_report stays scheduled', () => {
  it('ml-daily-ops runs it with --persist and reports a failure', () => {
    expect(SRC).toMatch(/runPython\(\s*'forward_test_report\.py',\s*\['--persist'\]/);
    expect(SRC).toContain("T.fail('forward_test_report'");
  });
  it('non-vacuity: the surrounding chain is the one that runs news-symbol-link', () => {
    expect(SRC).toContain("'data_integrity_repair.py', ['--news-link']");
  });
});
