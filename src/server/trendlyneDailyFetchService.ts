import { Queue } from 'bullmq';
import { getAllStocks } from './stockMapping';
import { fetchTrendlyneStockMetrics } from './trendlyneService';
import { dbAll, dbRun } from './dbAsync';

const DEFAULT_WINDOW_HOURS = 12;
const MAX_WINDOW_HOURS = 24;

// Pre-warms fetchTrendlyneStockMetrics()'s 12h cache (see getTrendlyneStockMetrics in
// trendlyne.router.ts, the on-demand caller sharing the same cache key) so a stock-detail
// "Stock Metrics" popup loads fast on first click. Was the full ~2,000-symbol universe
// (getAllStocks()), spread over a 10 AM-10 PM window that overlaps market hours and the
// intraday Trendlyne scan/checklist cycle's own request load, to warm a popup most of those
// symbols would never actually have opened. Restricted 2026-08-04 (job-timing audit) to the
// top-N by market cap — the segment actually likely to be viewed.
const TOP_N_BY_MARKET_CAP = 500;

// Maps this endpoint's Trendlyne `unique_name` keys -> trendlyne_stock_metrics_history columns
// (migration 1787060000000). Was pure cache-warming until 2026-08-15: every fetched value was
// discarded after the 12h TTL, including PEG_TTM/PBV_A/INSTIHOLD, which live-verified 2026-08-15
// exist NOWHERE else in this schema. Persisting costs nothing extra -- the HTTP call already
// happens daily for these symbols regardless.
//
// NOT wired to scoring_engine.py / ml_ensemble.py / feature_store, and that is deliberate, not
// an oversight to fix later. measurement.md already measured the closest analogue to
// institutional-holding data on this platform (`ticket_size`) as significantly INVERTED
// (t=-2.36), and flagged the other (`smart_money`) as "never backtested for edge magnitude --
// unmeasured, not proven." Wiring INSTIHOLD straight into a score would be a third instance of
// exactly that mistake. This table exists so the data stops being thrown away and CAN be
// measured once enough history accumulates -- not so it can be assumed useful today. Several of
// these 16 fields also duplicate columns already in feature_store (piotroski_f, roe, op_margins)
// that measurement.md's own sweep already found not significant -- kept anyway; curating at
// persist time would just be re-deciding what's already been decided, badly.
const METRIC_COLUMNS: Record<string, string> = {
  MCAP_Q: 'mcap_q',
  PE_TTM: 'pe_ttm',
  PEG_TTM: 'peg_ttm',
  PBV_A: 'pbv_a',
  INSTIHOLD: 'instihold_pct',
  REV4Q_Q: 'rev_growth_qtr_yoy_pct',
  SR_TTM_GROWTH: 'rev_growth_ttm_pct',
  NP_Q_GROWTH: 'np_growth_qtr_yoy_pct',
  NP_TTM_GROWTH: 'np_growth_ttm_pct',
  OPMPCT_Q: 'op_margin_qtr_pct',
  OPMPCT_TTM: 'op_margin_ttm_pct',
  PITROSKI_F: 'piotroski_f',
  relp_nifty50_qtrChangeP: 'relp_nifty50_qtr_change_pct',
  relp_sector_qtrChangeP: 'relp_sector_qtr_change_pct',
  ROE_A: 'roe_a',
  ROA_A: 'roa_a',
};

/** Extracts each known parameter's numeric `.value` from a fetchTrendlyneStockMetrics() response
 * body. Missing/non-numeric params come back null (the honest "not returned" marker), never 0 --
 * same reasoning as this repo's NaN/null convention elsewhere: a coerced 0 next to real values
 * is a lie a reader can't detect. */
export function extractMetricValues(body: Record<string, any> | null | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [srcKey, col] of Object.entries(METRIC_COLUMNS)) {
    const raw = body?.[srcKey]?.value;
    out[col] = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
  return out;
}

/** Upserts one symbol's parsed metrics for today. Exported for the live test to call directly,
 * same convention as saveScreenerStocksToDB. */
export async function saveStockMetricsToDB(symbol: string, date: string, body: Record<string, any>): Promise<void> {
  const values = extractMetricValues(body);
  const cols = Object.values(METRIC_COLUMNS);
  const placeholders = cols.map(() => '?').join(', ');
  const updateSet = cols.map(c => `${c} = excluded.${c}`).join(', ');
  await dbRun(
    `INSERT INTO trendlyne_stock_metrics_history (symbol, date, ${cols.join(', ')}, fetched_at)
     VALUES (?, ?, ${placeholders}, CURRENT_TIMESTAMP)
     ON CONFLICT(symbol, date) DO UPDATE SET ${updateSet}, fetched_at = excluded.fetched_at`,
    [symbol, date, ...cols.map(c => values[c])],
  );
}

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
    if (!data?.body) return data !== null && data !== undefined;

    // Persist alongside the existing cache-warm (2026-08-15) -- this job's own window (10 AM -
    // 10 PM, randomDelayMs above) never crosses midnight, so a plain calendar date is a safe
    // write-anchor here; no logical-trading-date rollover risk like the post-close jobs
    // recurring-bugs.md warns about.
    try {
      const today = new Date().toISOString().slice(0, 10);
      await saveStockMetricsToDB(symbol, today, data.body);
    } catch (persistErr) {
      // Persistence failing must not fail the fetch/cache-warm itself -- this call's original
      // contract (a boolean success/failure signal for the caller) predates persistence and
      // several callers key retry/backoff off it.
      console.warn(`[TRENDLYNE DAILY FETCH] Metrics fetched but DB persist failed for ${symbol}:`, (persistErr as Error).message);
    }
    return true;
  } catch (error) {
    console.error(`[TRENDLYNE DAILY FETCH] Failed for ${symbol}:`, (error as Error).message);
    return false;
  }
}
