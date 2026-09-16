import { describe, it, expect, beforeEach } from 'vitest';
import {
  scriptWeightMb,
  isHeavyScript,
  acquireHeavySlot,
  releaseHeavySlot,
  resetHeavySlot,
  getHeavySlotState,
} from '../pythonRunner';

/**
 * Regression guard for AF-20260912-13.
 *
 * On 2026-09-12 strategy_optimizer.py (16,870MB peak commit) and dl_trainer.py (13,820MB) ran
 * concurrently on a 23.5GB host: commit reached 94.3% of the 82GB limit, available memory fell
 * to 339MB and the box paged at 102,856 pages/sec. Neither of the two existing limits could
 * catch it -- MAX_PYTHON_CONCURRENT is a COUNT (5) and PY_CHILD_MEM_LIMIT_MB is PER PROCESS
 * TREE (20GB), so both jobs were individually legal and jointly fatal.
 *
 * The fix is the exclusive heavy slot in pythonRunner.ts. These tests pin the two halves that
 * can silently rot:
 *   1. CLASSIFICATION -- the two scripts that caused the incident must still be classified heavy.
 *      A weight edited down, or a renamed script falling through to the default, re-opens the bug
 *      with no other symptom.
 *   2. MUTUAL EXCLUSION -- a second heavy job must actually block until the first releases.
 *
 * Negative-controlled: verified 2026-09-12 that setting PY_HEAVY_THRESHOLD_MB above
 * strategy_optimizer's weight fails the classification tests, and that making acquireHeavySlot
 * resolve unconditionally fails 'a second heavy job waits'.
 */
describe('pythonRunner exclusive heavy slot (AF-20260912-13)', () => {
  beforeEach(() => {
    delete process.env.PY_HEAVY_THRESHOLD_MB;
    resetHeavySlot();
  });

  describe('weights are measured, and cover the incident scripts', () => {
    it('carries the measured peak for each known heavy script', () => {
      // Live Win32_Process PeakPageFileUsage / logged peakMemMb, 2026-09-12.
      expect(scriptWeightMb('strategy_optimizer.py')).toBe(16870);
      expect(scriptWeightMb('dl_trainer.py')).toBe(13820);
    });

    it('resolves a full path, not just a bare name', () => {
      // runPython passes whatever the caller wrote; queues.ts uses bare names but the DL
      // registrations pass 'dl_trainer.py --trigger scheduled'-shaped strings elsewhere.
      expect(scriptWeightMb('D:/repo/src/server/dl_trainer.py')).toBe(13820);
      expect(scriptWeightMb('src\\server\\dl_trainer.py')).toBe(13820);
    });

    it('gives an unknown script a non-zero default so it cannot weigh nothing', () => {
      expect(scriptWeightMb('some_new_fetcher_nobody_measured.py')).toBe(600);
    });

    it('classifies BOTH scripts from the incident as heavy', () => {
      expect(isHeavyScript('strategy_optimizer.py')).toBe(true);
      expect(isHeavyScript('dl_trainer.py')).toBe(true);
    });

    it('does NOT classify the next-largest script as heavy (the threshold still discriminates)', () => {
      // A guard that flagged everything would serialise the whole platform and would be
      // indistinguishable from a broken threshold -- the "monitor that fires on every run
      // carries no information" rule, applied to an admission gate.
      expect(scriptWeightMb('ml_ensemble.py')).toBeLessThan(8192);
      expect(isHeavyScript('ml_ensemble.py')).toBe(false);
      expect(isHeavyScript('mc_pricefeed_fetcher.py')).toBe(false);
    });

    it('honours PY_HEAVY_THRESHOLD_MB=0 as "disabled"', () => {
      process.env.PY_HEAVY_THRESHOLD_MB = '0';
      expect(isHeavyScript('dl_trainer.py')).toBe(false);
    });
  });

  describe('mutual exclusion', () => {
    it('admits the first heavy job immediately', async () => {
      await acquireHeavySlot('dl_trainer.py');
      expect(getHeavySlotState().running).toBe('dl_trainer.py');
      expect(getHeavySlotState().queued).toBe(0);
    });

    it('a second heavy job waits until the first releases', async () => {
      await acquireHeavySlot('dl_trainer.py');

      let admitted = false;
      const second = acquireHeavySlot('strategy_optimizer.py').then(() => { admitted = true; });

      // Yield the microtask queue: if the slot were not exclusive, `second` would already
      // have resolved by now. This is the assertion the bug would fail.
      await Promise.resolve();
      await Promise.resolve();
      expect(admitted).toBe(false);
      expect(getHeavySlotState().queued).toBe(1);
      expect(getHeavySlotState().running).toBe('dl_trainer.py');

      releaseHeavySlot();
      await second;
      expect(admitted).toBe(true);
      expect(getHeavySlotState().running).toBe('strategy_optimizer.py');
      expect(getHeavySlotState().queued).toBe(0);
    });

    it('releasing an empty slot is a no-op, not a negative-state leak', () => {
      releaseHeavySlot();
      releaseHeavySlot();
      expect(getHeavySlotState().running).toBeNull();
      expect(getHeavySlotState().queued).toBe(0);
    });

    it('hands the slot to waiters in FIFO order', async () => {
      await acquireHeavySlot('a.py');
      const order: string[] = [];
      const w1 = acquireHeavySlot('b.py').then(() => { order.push('b'); });
      const w2 = acquireHeavySlot('c.py').then(() => { order.push('c'); });

      releaseHeavySlot();
      await w1;
      releaseHeavySlot();
      await w2;
      expect(order).toEqual(['b', 'c']);
    });
  });
});
