/**
 * Regression test for the Python subprocess slot-counter leak in pythonRunner.ts.
 * Bug: releasePythonSlot() handed a finished slot to a queued waiter via entry()
 * (which does _runningPython++) without ever decrementing for the holder that
 * just finished -- every handoff under queue contention leaked +1 permanently.
 * Run with: npx tsx src/server/tests/test_python_runner_slots.ts
 */

import {
  acquirePythonSlot,
  releasePythonSlot,
  getPythonSlotState,
  resetPythonSlots,
} from '../pythonRunner';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

async function testNoDriftUnderQueueContention() {
  resetPythonSlots();
  const MAX = getPythonSlotState().max; // 5

  // Saturate all slots, then queue extra waiters behind them -- this is the
  // contention pattern that triggered the leak (queue non-empty on release).
  const holders = MAX + 4; // 9 total: 5 run immediately, 4 queue
  const acquired: Promise<void>[] = [];
  for (let i = 0; i < holders; i++) {
    acquired.push(acquirePythonSlot());
  }

  // Let the first MAX resolve synchronously; queued ones resolve as slots free up.
  await new Promise((r) => setTimeout(r, 10));
  assertEqual(getPythonSlotState().running, MAX, 'all slots occupied, none queued yet resolved');

  // Release all slots one at a time, in FIFO order, letting queued waiters take over.
  for (let i = 0; i < holders; i++) {
    releasePythonSlot();
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(acquired);

  // Every acquire was matched by a release -- counter must return to exactly 0,
  // not drift upward the way it did pre-fix (each handoff used to leak +1).
  assertEqual(getPythonSlotState().running, 0, 'slot counter returns to 0 after equal acquire/release under contention');
}

async function testRepeatedContentionDoesNotAccumulate() {
  resetPythonSlots();
  const MAX = getPythonSlotState().max;

  // Simulate many bursty rounds like the 40+ jobs in queues.ts firing every
  // few minutes -- this is what made the pre-fix bug drift past MAX within
  // minutes of every watchdog reset instead of staying bounded.
  for (let round = 0; round < 20; round++) {
    const n = MAX + 2;
    const acquired: Promise<void>[] = [];
    for (let i = 0; i < n; i++) acquired.push(acquirePythonSlot());
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < n; i++) {
      releasePythonSlot();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all(acquired);
  }

  assertEqual(getPythonSlotState().running, 0, 'counter stays bounded at 0 after 20 rounds of contention, no cumulative drift');
}

const tests: Array<[string, () => Promise<void>]> = [
  ['no drift when releasing under queue contention', testNoDriftUnderQueueContention],
  ['repeated contention rounds do not accumulate drift', testRepeatedContentionDoesNotAccumulate],
];

let passed = 0;
let failed = 0;

async function main() {
  console.log('\nRunning pythonRunner slot-counter tests...\n');
  for (const [name, fn] of tests) {
    try {
      console.log(`[TEST] ${name}`);
      await fn();
      passed++;
    } catch (err: any) {
      console.error(`  FAIL: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
