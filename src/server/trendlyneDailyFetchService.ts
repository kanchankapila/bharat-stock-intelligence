import { dbAll, dbRun } from './dbAsync';

// One anonymous custom-query sweep replaces the old 500-child logged-in fan-out
// (getStockMetricParameterList per symbol, ~500 requests/day of the shared Trendlyne allowance,
// dead whenever the account was). Live-probed 2026-11-19 (AF-20261119-03): the kayal
// broker-webview screener accepts `columns=` with these same unique_names for 100 stocks per
// page, no login; 97-stock parity against the per-symbol rows was within 1.5-2.4% median
// (1-8 day old rows). The trendlyne.com host for the same path answers with a login page.
export const BULK_METRICS_URL = 'https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/';
// groupType=all is NSE + BSE; page 40 still had isNextPage on 2026-11-19. Reaching this cap
// with isNextPage still set throws rather than silently truncating.
const BULK_MAX_PAGES = 120;
const BULK_PAGE_DELAY_MS = 1500;

// Maps Trendlyne `unique_name` keys -> trendlyne_stock_metrics_history columns
// (migration 1787060000000).
//
// NOT wired to scoring_engine.py / ml_ensemble.py / feature_store, and that is deliberate, not
// an oversight to fix later. measurement.md already measured the closest analogue to
// institutional-holding data on this platform (`ticket_size`) as significantly INVERTED
// (t=-2.36), and flagged the other (`smart_money`) as "never backtested for edge magnitude --
// unmeasured, not proven." Wiring INSTIHOLD straight into a score would be a third instance of
// exactly that mistake. This table exists so the data CAN be measured once enough history
// accumulates -- not so it can be assumed useful today.
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

export function bulkMetricsUrl(pageNumber: number): string {
  const params = new URLSearchParams({
    perPageCount: '100',
    pageNumber: String(pageNumber),
    query: 'MCAP_Q > 0',
    columns: Object.keys(METRIC_COLUMNS).join(','),
    groupType: 'all',
    groupName: '',
    sortBy: 'MCAP_Q',
    order: 'DESC',
  });
  return `${BULK_METRICS_URL}?${params.toString()}`;
}

/** An unknown column comes back as '' rather than an error, so anything non-numeric is null
 * (never 0: a coerced 0 next to real values is a lie a reader can't detect). */
function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function saveStockMetricsToDB(symbol: string, date: string, values: Record<string, number | null>): Promise<void> {
  const cols = Object.values(METRIC_COLUMNS);
  const placeholders = cols.map(() => '?').join(', ');
  const updateSet = cols.map(c => `${c} = excluded.${c}`).join(', ');
  await dbRun(
    `INSERT INTO trendlyne_stock_metrics_history (symbol, date, ${cols.join(', ')}, fetched_at)
     VALUES (?, ?, ${placeholders}, CURRENT_TIMESTAMP)
     ON CONFLICT(symbol, date) DO UPDATE SET ${updateSet}, fetched_at = excluded.fetched_at`,
    [symbol, date, ...cols.map(c => values[c] ?? null)],
  );
}

/** Parses one page into {symbol -> column values}, keyed by the NSE symbol the row carries. */
export function parseBulkMetricsPage(json: any): { rows: Map<string, Record<string, number | null>>; isNextPage: boolean } {
  const headers: string[] = (json?.body?.tableHeaders ?? []).map((h: any) => h?.unique_name);
  const nseIdx = headers.indexOf('NSEcode');
  if (json?.head?.status !== '0' || nseIdx < 0) {
    throw new Error(`unexpected bulk metrics payload (head.status=${JSON.stringify(json?.head?.status)}, NSEcode column ${nseIdx < 0 ? 'missing' : 'present'})`);
  }
  const rows = new Map<string, Record<string, number | null>>();
  for (const row of json.body.tableData ?? []) {
    const symbol = String(row[nseIdx] ?? '').trim().toUpperCase();
    if (!symbol) continue; // BSE-only listing
    const values: Record<string, number | null> = {};
    for (const [key, col] of Object.entries(METRIC_COLUMNS)) {
      const i = headers.indexOf(key);
      values[col] = i < 0 ? null : num(row[i]);
    }
    rows.set(symbol, values);
  }
  return { rows, isNextPage: json.body.isNextPage === true || json.head?.isNextPage === true };
}

export async function runTrendlyneMetricsBulkFetch(
  { fetchFn = fetch, pageDelayMs = BULK_PAGE_DELAY_MS }: { fetchFn?: typeof fetch; pageDelayMs?: number } = {},
): Promise<{ pages: number; persisted: number }> {
  const universe = new Set(
    (await dbAll<{ symbol: string }>(`SELECT symbol FROM nse_stocks WHERE status = 'ACTIVE'`))
      .map(r => r.symbol.toUpperCase()),
  );
  // Record the observation's IST calendar date; a manual run can cross midnight.
  const today = new Date(Date.now() + 5.5 * 60 * 60_000).toISOString().slice(0, 10);
  let persisted = 0;
  for (let page = 0; page < BULK_MAX_PAGES; page++) {
    if (page > 0 && pageDelayMs > 0) await new Promise(r => setTimeout(r, pageDelayMs));
    const res = await fetchFn(bulkMetricsUrl(page), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://kayal.trendlyne.com/',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`bulk metrics page ${page} returned HTTP ${res.status} after ${persisted} symbols persisted`);
    const { rows, isNextPage } = parseBulkMetricsPage(await res.json());
    for (const [symbol, values] of rows) {
      if (!universe.has(symbol)) continue;
      await saveStockMetricsToDB(symbol, today, values);
      persisted++;
    }
    if (!isNextPage) {
      if (persisted === 0) throw new Error(`bulk metrics sweep matched 0 universe symbols over ${page + 1} pages`);
      return { pages: page + 1, persisted };
    }
  }
  throw new Error(`bulk metrics sweep still had isNextPage after ${BULK_MAX_PAGES} pages (${persisted} persisted); raise BULK_MAX_PAGES`);
}
