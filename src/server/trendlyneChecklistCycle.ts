import { dbGet, dbAll, dbRun } from './dbAsync';
import type { TrendlyneChecklistResult } from './trendlyneChecklistParser';

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

export interface CycleState {
  cycleStartedAt: number | null;
  cycleCompletedAt: number | null;
}

const STARTED_KEY = 'trendlyne_checklist_cycle_started_at';
const COMPLETED_KEY = 'trendlyne_checklist_cycle_completed_at';

export async function getCycleState(): Promise<CycleState> {
  const startRow = await dbGet<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?', [STARTED_KEY],
  );
  const completeRow = await dbGet<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?', [COMPLETED_KEY],
  );
  return {
    cycleStartedAt: startRow?.value ? Number(startRow.value) : null,
    cycleCompletedAt: completeRow?.value ? Number(completeRow.value) : null,
  };
}

async function upsertAppSetting(key: string, value: string): Promise<void> {
  await dbRun(
    'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, value],
  );
}

export async function startNewCycle(now: number): Promise<void> {
  await upsertAppSetting(STARTED_KEY, String(now));
  await upsertAppSetting(COMPLETED_KEY, '');
}

export async function completeCycle(now: number): Promise<void> {
  await upsertAppSetting(COMPLETED_KEY, String(now));
}

export interface PendingStock {
  symbol: string;
  tlid: string;
}

export async function getPendingStocksForCycle(cycleStartedAt: number): Promise<PendingStock[]> {
  return dbAll<PendingStock>(
    `SELECT n.symbol, n.tlid FROM nse_stocks n
     WHERE n.tlid IS NOT NULL AND trim(n.tlid) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM trendlyne_checklist c
         WHERE c.symbol = n.symbol AND c.fetched_at >= ?
       )`,
    [new Date(cycleStartedAt).toISOString()],
  );
}

export async function upsertChecklistResult(
  symbol: string,
  result: TrendlyneChecklistResult,
  fetchedAt: number,
): Promise<void> {
  await dbRun(
    `INSERT INTO trendlyne_checklist (symbol, score, total, yes_count, insight, checklist_data, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       score = excluded.score, total = excluded.total, yes_count = excluded.yes_count,
       insight = excluded.insight, checklist_data = excluded.checklist_data, fetched_at = excluded.fetched_at`,
    [
      symbol,
      result.score,
      result.total,
      result.yesCount,
      result.insight ?? null,
      JSON.stringify(result.checklistData),
      new Date(fetchedAt).toISOString(),
    ],
  );
}

/** Records that a checklist fetch was attempted for `symbol`, regardless of
 *  outcome, so it drops out of "pending" for the current cycle. Never
 *  overwrites previously-fetched good data on a later transient failure. */
export async function markChecklistAttempted(symbol: string, fetchedAt: number): Promise<void> {
  await dbRun(
    `INSERT INTO trendlyne_checklist (symbol, score, total, yes_count, insight, checklist_data, fetched_at)
     VALUES (?, NULL, 0, 0, NULL, NULL, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       fetched_at = excluded.fetched_at`,
    [symbol, new Date(fetchedAt).toISOString()],
  );
}
