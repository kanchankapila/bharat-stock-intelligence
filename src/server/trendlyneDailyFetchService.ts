import { Queue } from 'bullmq';
import { getAllStocks } from './stockMapping';
import { fetchTrendlyneStockMetrics } from './trendlyneService';
import { dbAll } from './dbAsync';

const DEFAULT_WINDOW_HOURS = 12;
const MAX_WINDOW_HOURS = 24;

// Pre-warms fetchTrendlyneStockMetrics()'s 12h cache (see getTrendlyneStockMetrics in
// trendlyne.router.ts, the on-demand caller sharing the same cache key) so a stock-detail
// "Stock Metrics" popup loads fast on first click. No DB persistence happens here — this is
// pure cache-warming. Was the full ~2,000-symbol universe (getAllStocks()), spread over a
// 10 AM-10 PM window that overlaps market hours and the intraday Trendlyne scan/checklist
// cycle's own request load, to warm a popup most of those symbols would never actually have
// opened. Restricted 2026-08-04 (job-timing audit) to the top-N by market cap — the segment
// actually likely to be viewed.
const TOP_N_BY_MARKET_CAP = 500;

export async function getTrendlyneMetricSymbols(limit = TOP_N_BY_MARKET_CAP): Promise<string[]> {
  try {
    const rows = await dbAll<{ symbol: string }>(
      `SELECT symbol FROM nse_stocks WHERE market_cap IS NOT NULL AND status = 'ACTIVE'
       ORDER BY market_cap DESC LIMIT ?`,
      [limit],
    );
    if (rows.length > 0) return rows.map(r => r.symbol.toUpperCase());
  } catch (err) {
    console.warn('[TRENDLYNE DAILY FETCH] market-cap ranked query failed, falling back to full universe:', (err as Error).message);
  }
  // Fallback (nse_stocks not yet populated, or the query failed): full universe, same as before.
  return getAllStocks().map((stock) => stock.symbol.toUpperCase());
}

export function randomDelayMs(windowHours = DEFAULT_WINDOW_HOURS): number {
  const hrs = Math.max(0, Math.min(windowHours, MAX_WINDOW_HOURS));
  return Math.floor(Math.random() * hrs * 60 * 60 * 1000);
}

export async function enqueueTrendlyneMetricsFetchJobs(
  queue: Queue,
  symbols: string[],
  windowHours = DEFAULT_WINDOW_HOURS,
): Promise<void> {
  const maxDelayMs = Math.max(0, Math.min(windowHours, MAX_WINDOW_HOURS)) * 60 * 60 * 1000;

  for (const symbol of symbols) {
    const delay = Math.floor(Math.random() * maxDelayMs);

    await queue.add(
      'trendlyne-metrics-fetch',
      { symbol },
      {
        delay,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 3,
      },
    );
  }
}

export async function runTrendlyneMetricsFetch(symbol: string): Promise<boolean> {
  try {
    const data = await fetchTrendlyneStockMetrics(symbol);
    return data !== null && data !== undefined;
  } catch (error) {
    console.error(`[TRENDLYNE DAILY FETCH] Failed for ${symbol}:`, (error as Error).message);
    return false;
  }
}
