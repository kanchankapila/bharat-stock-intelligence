import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ml-promotion-gate-review, 2026-08-19: cs_ranker.py/exit_policy.py/online_learner.py each write
// a promotion decision to model_registry, but their runPython() calls were bare
// `.catch(e => console.warn(...))` instead of T.run(...) -- the same steps' siblings
// (ml-ensemble-train, strategy-optimizer, densify-feature-matrix, event-triggers) had already
// been upgraded to T.run for exactly this reason (queues.ts's own comment: "so their monitor
// state reflects the REAL outcome ... not the blanket 'success' the completed handler used to
// stamp"). A source scan, not a call-through test, because these are BullMQ processor functions
// with heavy real I/O -- pinning the wiring is what regresses if someone reverts to a bare
// .catch, which is the actual failure mode this closes.
describe('promotion-gate training steps are tracked by StepTracker, not a bare .catch', () => {
  const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');

  it.each([
    ['exit-policy-train', "runPython('exit_policy.py', ['--train']"],
    ['breakout-classifier-train', "runPython('breakout_classifier.py', ['--train', '--score']"],
    ['movement-predictor-train', "runPython('movement_predictor.py', ['--train', '--score']"],
  ])('%s wraps its runPython call in T.run(...)', (stepName, callSnippet) => {
    const idx = src.indexOf(callSnippet);
    expect(idx, `${callSnippet} not found in queues.ts`).toBeGreaterThan(-1);
    // The call snippet must sit inside a `T.run('<stepName>', () => ...)` on the same statement.
    const lineStart = src.lastIndexOf('\n', idx);
    const statement = src.slice(lineStart, idx);
    expect(statement).toContain(`T.run('${stepName}'`);
  });
});
