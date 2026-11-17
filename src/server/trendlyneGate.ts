/**
 * One Trendlyne script at a time across bharat-server (AF-20261117-18).
 *
 * trendlyne.com rations a cumulative request allowance shared by every caller on this IP. On
 * Tuesday 2026-11-17 at 20:00 IST three schedules fired together: trendlyne-midweek (adv-tech,
 * then price-analysis), the 20:00 catch-up slice (overview) and ml-daily-ops' parallel block
 * (option chain, F&O activity, market insight). The burst was refused and the one-request
 * market-insight step failed the whole chain. Every scheduled Trendlyne Python step now runs
 * through this queue; the catch-up slice gives up its turn instead of waiting.
 *
 * Scope: an in-process FIFO. Every scheduled caller lives in bharat-server; a manual script run
 * from a shell is not covered (recorded in AF-20261118-01).
 */
let tail: Promise<void> = Promise.resolve();
let pending = 0;

/** Scripts holding or waiting for the slot. */
export function trendlynePending(): number {
  return pending;
}

export async function withTrendlyneSlot<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  const prev = tail;
  let release!: () => void;
  tail = new Promise<void>(r => { release = r; });
  try {
    await prev;
    return await fn();
  } finally {
    pending -= 1;
    release();
  }
}
