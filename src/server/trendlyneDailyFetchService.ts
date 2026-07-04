import { Queue } from 'bullmq';
import { getAllStocks } from './stockMapping';
import { fetchTrendlyneStockMetrics } from './trendlyneService';

const DEFAULT_WINDOW_HOURS = 12;
const MAX_WINDOW_HOURS = 24;

export function getTrendlyneMetricSymbols(): string[] {
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
