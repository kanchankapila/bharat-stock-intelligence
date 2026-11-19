import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AF-20261119: the learning loop only learns if it runs every trading day; the freshness DQ checks catch a
// stopped step at runtime, this keeps a refactor from dropping one. The gate must run after the scorecard it reads.
const SRC = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');

describe('learning loop stays scheduled in ml-daily-ops', () => {
  it('runs attribution and the gate with --persist after the scorecard, and reports failures', () => {
    const score = SRC.indexOf("runPython('accuracy_scorecard.py', ['--persist']");
    const att = SRC.indexOf("runPython('call_attribution.py', ['--persist']");
    const gate = SRC.indexOf("runPython('ranker_challenger_gate.py', ['--persist']");
    expect(score).toBeGreaterThan(-1);
    expect(att).toBeGreaterThan(score);
    expect(gate).toBeGreaterThan(score);
    expect(SRC).toContain("T.fail('call_attribution'");
    expect(SRC).toContain("T.fail('ranker_challenger_gate'");
    expect(SRC).toContain('await sendLearningReview();');
  });
});
