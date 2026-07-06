export const CYCLE_PAUSE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DORMANT_RECHECK_MS = 24 * 60 * 60 * 1000;  // 1 day

/** True while the 30-day pause after a completed cycle hasn't elapsed yet. */
export function isDormant(now: number, cycleCompletedAt: number | null): boolean {
  return cycleCompletedAt !== null && now < cycleCompletedAt + CYCLE_PAUSE_MS;
}

/** True when a fresh 7-day cycle should begin: never started, or the previous
 *  cycle's 30-day pause has fully elapsed. */
export function shouldStartNewCycle(
  cycleStartedAt: number | null,
  cycleCompletedAt: number | null,
  now: number,
): boolean {
  if (cycleStartedAt === null) return true;
  if (cycleCompletedAt !== null && now >= cycleCompletedAt + CYCLE_PAUSE_MS) return true;
  return false;
}

/** Random contiguous-order-independent sample sized between minSize and maxSize
 *  (clamped to the input length). Used to pick this run's stock batch. */
export function pickRandomBatch<T>(items: T[], minSize: number, maxSize: number): T[] {
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  const size = Math.min(
    items.length,
    minSize + Math.floor(Math.random() * (maxSize - minSize + 1)),
  );
  return shuffled.slice(0, size);
}

/** Random delay in ms, uniformly distributed between minMinutes and maxMinutes. */
export function randomDelayMs(minMinutes: number, maxMinutes: number): number {
  const minutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
  return Math.round(minutes * 60 * 1000);
}
