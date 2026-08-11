/**
 * Data-quality contract testing
 * =============================
 * jobHeartbeat.ts / jobWatchdog.ts answer "did the job run and exit 0?" — this module
 * answers the harder question: "did it write *correct, complete* data?" Every entry in
 * docs/FETCHER_HEALTH_TRACKER.md (a stub silently returning null for every stock, an
 * empty fetch treated as success, a column collapsing to ~1-3% coverage for three weeks
 * unnoticed) was a job that reported success while its output was wrong or missing. That
 * class of bug is invisible to "did it run" monitoring and was only ever caught by manual
 * one-time audits. These checks make it visible continuously instead.
 *
 * Each check is one cheap read-only aggregate query + a pure evaluate() function, so the
 * evaluation logic (the part worth unit-testing) never touches the DB — see
 * __tests__/dataQualityChecks.test.ts.
 *
 * Results are upserted into data_quality_results (one row per check_id, latest result only
 * — same shape as job_heartbeat) and folded into the existing Telegram watchdog/daily
 * digest in jobWatchdog.ts rather than introducing a second alerting path.
 */
import { dbGet, dbAll, dbRun, dbExec } from './dbAsync';

export type DataQualityStatus = 'pass' | 'warn' | 'fail' | 'error';

export interface DataQualityCheck {
  id: string;
  label: string;
  category:
    | 'ohlcv' | 'signals' | 'ml' | 'scoring' | 'fundamentals'
    | 'options' | 'flows' | 'outcomes' | 'reference' | 'macro';
  critical: boolean;
  sql: string;
  params?: unknown[];
  evaluate: (row: Record<string, any> | undefined, now: Date) => { status: DataQualityStatus; detail: string };
}

export interface DataQualityResult {
  id: string;
  label: string;
  category: string;
  critical: boolean;
  status: DataQualityStatus;
  detail: string;
}

// ─── Pure helpers (unit-tested directly) ──────────────────────────────────────

/** Days between `now` and a date/timestamp value from a DB row. Returns null if unparseable/absent
 *  — callers must treat null as "no evidence" (usually itself a failure), never as "0 days stale". */
export function daysStale(value: unknown, now: Date): number | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / 86_400_000;
}

/** Like daysStale(), but subtracts weekend (Sat/Sun) calendar days that fall strictly between
 *  the value's date and `now` — for tables that only update on trading days, a flat calendar-day
 *  threshold false-positives every Monday morning purely from the Sat/Sun gap, even though
 *  Friday's data landed correctly and Monday's own pipeline simply hasn't run yet (found
 *  2026-08-03: ohlcv-freshness-coverage/fii-dii-flow-freshness/market-regimes-freshness all
 *  warned "3+ days stale" on a Monday morning check that runs at 08:40 IST, hours before that
 *  day's own stock-refresh/fii-dii-fetcher/regime-detector jobs even fire). Deliberately not a
 *  full NSE holiday calendar — this module's own header explicitly avoids that dependency for
 *  simplicity — just removes the two weekend days baked into any post-weekend check; a real
 *  multi-weekday outage still accumulates past the threshold undiminished. */
export function tradingDaysStale(value: unknown, now: Date): number | null {
  const raw = daysStale(value, now);
  if (raw == null) return raw;
  const then = value instanceof Date ? value : new Date(String(value));
  let weekendDays = 0;
  const cursor = new Date(Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate()));
  const nowMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (cursor < nowMidnight) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow === 0 || dow === 6) weekendDays++;
  }
  return Math.max(0, raw - weekendDays);
}

/** Safe ratio; undefined denominator/zero denominator reads as "no data" (0), not divide-by-zero. */
export function safeRatio(numerator: unknown, denominator: unknown): number {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  return n / d;
}

function fmtDays(d: number | null): string {
  if (d == null) return 'unknown';
  return `${d.toFixed(1)}d`;
}

// ─── Registry ──────────────────────────────────────────────────────────────
// Thresholds are deliberately loose (generous grace for weekends/holidays, no NSE
// calendar dependency) — the goal is to catch multi-day silent breakage, not to be a
// precise SLA monitor (jobHeartbeat/JOB_REGISTRY already do cron-aware lateness).

// ─── Generic freshness-check factory ──────────────────────────────────────────
// MANDATE (see CLAUDE.md "General Rules"): every live datasource fetcher writes to a table
// with its own date/timestamp column — adding one entry to TABLE_FRESHNESS_CHECKS below is the
// required way to get that table monitored. This exists because dataQualityChecks.ts started
// with ~25 hand-written checks covering only a fraction of the ~140 DB-writing Python fetchers
// in this codebase (found 2026-08-03, in response to a user request to cover "all live
// datasources") — most fetchers had NO freshness monitoring at all, so a silently-broken one
// (see mf_sector_allocation below, found empty by this very audit) looked identical to a
// healthy one in every dashboard. A declarative registry + one factory function means adding
// a check for a new datasource is a single config object, not a hand-rolled SQL+evaluate()
// block — the friction that made this mandate hard to honor before.
interface TableFreshnessConfig {
  id: string;
  label: string;
  category: DataQualityCheck['category'];
  critical: boolean;
  table: string;
  /** Column holding the row's own date/timestamp. */
  dateColumn: string;
  /** Set true when dateColumn is a native Postgres DATE (not TEXT) — needs a ::text cast to
   *  compare against the JS-computed staleness value the same way stock_ohlcv/feature_store do. */
  nativeDateColumn?: boolean;
  /** Use tradingDaysStale() (subtracts weekends) instead of plain daysStale() — appropriate for
   *  any table that only updates on NSE trading days. Default true; set false for tables fed by
   *  a genuinely 24/7 cadence (e.g. confluence_signals' 30-min-everyMs job). */
  tradingDayAware?: boolean;
  warnDays: number;
  /** Omit for a "sparse by nature" table (matches insider-trades-recency/bulk-deals-recency's
   *  existing style): only ever warns past warnDays, never fails, since the data itself is
   *  naturally episodic (insider filings, IPOs, bulk deals) rather than daily. */
  failDays?: number;
  /** Replaces the bare "<table> is empty" text when the table has no rows at all. Use it when the
   *  reason is already known and understood, so the daily report says what is actually blocked
   *  instead of restating "empty" every morning -- an alert that repeats an already-triaged fact
   *  is the kind people learn to skim past, which is how a real one gets missed. */
  emptyDetail?: string;
}

function makeFreshnessCheck(cfg: TableFreshnessConfig): DataQualityCheck {
  const col = cfg.nativeDateColumn ? `${cfg.dateColumn}::text` : cfg.dateColumn;
  const useTradingDays = cfg.tradingDayAware !== false;
  return {
    id: cfg.id,
    label: cfg.label,
    category: cfg.category,
    critical: cfg.critical,
    sql: `SELECT MAX(${col}) AS last_date FROM ${cfg.table}`,
    evaluate: (row, now) => {
      const stale = (useTradingDays ? tradingDaysStale : daysStale)(row?.last_date, now);
      if (stale == null) return { status: cfg.critical ? 'fail' : 'warn', detail: cfg.emptyDetail ?? `${cfg.table} is empty` };
      if (cfg.failDays == null) {
        if (stale > cfg.warnDays) {
          return { status: 'warn', detail: `Latest ${cfg.table} row is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
        }
        return { status: 'pass', detail: `Latest ${cfg.table} row ${fmtDays(stale)} old` };
      }
      if (stale > cfg.failDays) return { status: 'fail', detail: `Latest ${cfg.table} row is ${fmtDays(stale)} old` };
      if (stale > cfg.warnDays) return { status: 'warn', detail: `Latest ${cfg.table} row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `Latest ${cfg.table} row ${fmtDays(stale)} old` };
    },
  };
}

// Every entry here is a genuine external-data landing table (a live datasource per CLAUDE.md's
// "Adding a New Data Source" mandate) found via a full sweep of runPython() call sites across
// queues.ts + jobs/*.jobs.ts, cross-referenced against each script's own INSERT/CREATE TABLE
// targets (2026-08-03). Deliberately excludes pure-internal/derived-only tables (model
// registries, RL Q-tables, weight-history bookkeeping, backtest run logs) — those are ML
// state, not datasources, and adding freshness checks for them would dilute what this file is
// for. One check per logically-distinct table; where several sibling fetchers share one table
// (e.g. macro_asset_prices, fed by ~8 different scripts) there is one check, not one per script.
const TABLE_FRESHNESS_CHECKS: TableFreshnessConfig[] = [
  // ohlcv
  { id: 'nse-universe-history-freshness', label: 'nse_universe_history (survivorship-free PIT universe)',
    category: 'ohlcv', critical: true, table: 'nse_universe_history', dateColumn: 'date', warnDays: 3, failDays: 5 },

  // options
  { id: 'so-option-chain-freshness', label: 'so_option_chain (Trendlyne live options chain)',
    category: 'options', critical: false, table: 'so_option_chain', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'index-option-oi-freshness', label: 'index_option_oi (MC index OI/max-pain)',
    category: 'options', critical: false, table: 'index_option_oi', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'nt-index-pcr-ts-freshness', label: 'nt_index_pcr_ts (NiftyTrader PCR/VIX)',
    category: 'options', critical: false, table: 'nt_index_pcr_ts', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'stock-option-features-freshness', label: 'stock_option_features (per-stock option chain features)',
    category: 'options', critical: false, table: 'stock_option_features', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // 2026-08-07 urls.txt follow-up (docs/url_explorer) -- see ndtv_fno_basis_fetcher.py.
  { id: 'ndtv-fno-basis-freshness', label: 'ndtv_fno_basis (NDTV futures basis/roll-spread cross-check)',
    category: 'options', critical: false, table: 'ndtv_fno_basis', dateColumn: 'date', warnDays: 3, failDays: 5 },

  // flows
  { id: 'insider-transactions-recency', label: 'insider_transactions (NSE PIT filings)',
    category: 'flows', critical: false, table: 'insider_transactions', dateColumn: 'transaction_date', warnDays: 14 },
  { id: 'bulk-block-deals-recency', label: 'bulk_block_deals (delivery-trend NSE bulk/block feed)',
    category: 'flows', critical: false, table: 'bulk_block_deals', dateColumn: 'deal_date', warnDays: 14 },
  { id: 'stock-delivery-volume-freshness', label: 'stock_delivery_volume (MTO delivery %)',
    category: 'flows', critical: false, table: 'stock_delivery_volume', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'mf-stock-holdings-recency', label: 'mf_stock_holdings (per-stock MF ownership, monthly disclosure)',
    category: 'flows', critical: false, table: 'mf_stock_holdings', dateColumn: 'as_of_date', warnDays: 45 },
  // Empty because the UPSTREAM SOURCE IS DEAD, not because the fetcher is broken. AMFI's
  // DownloadSchemeData_Po.aspx?mf=0&tp=1 returns HTTP 200 with a 4MB CSV that is the scheme
  // MASTER list (AMC, Code, Scheme Name, ...) -- no ISINs, no market values -- so
  // mf_sector_flow_fetcher.py's _parse_amfi() correctly finds 0 holding rows and run() exits 1
  // rather than writing a fabricated month. Re-confirmed live 2026-08-11. test_live_datasource_
  // mf_sector_flow.py already asserts this exact shape and will notice if AMFI restores it.
  { id: 'mf-sector-allocation-recency', label: 'mf_sector_allocation (MF sector flow)',
    category: 'flows', critical: false, table: 'mf_sector_allocation', dateColumn: 'month', warnDays: 45,
    emptyDetail: 'mf_sector_allocation is empty — AMFI\'s portfolio-disclosure endpoint now returns the scheme master list instead of holdings (upstream, not a fetcher bug; see mf_sector_flow_fetcher.py). Blocked until AMFI restores it or a replacement source is chosen.' },
  // 2026-08-06 urls.txt data analysis (docs/url_explorer) -- see institutional_deals_fetcher.py.
  { id: 'institutional-deal-signals-recency', label: 'institutional_deal_signals (MC ranked topInvestor buy/sell)',
    category: 'flows', critical: false, table: 'institutional_deal_signals', dateColumn: 'deal_date', warnDays: 5, failDays: 10 },

  // fundamentals
  { id: 'tl-financial-quality-freshness', label: 'tl_financial_quality (weekly ET ratios)',
    category: 'fundamentals', critical: false, table: 'tl_financial_quality', dateColumn: 'as_of_date', warnDays: 10, failDays: 16 },
  // 2026-08-07: warnDays/failDays were 3/5, but the only writer (trendlyne_fundamentals_
  // fetcher.py) runs weekly (Sunday, inside ml-weekly-retrain) -- flat-out false-alarmed FAIL
  // every Thu/Fri/Sat/Sun-morning, every single week. Matched to tl-financial-quality-
  // freshness's own weekly-cadence values right above (10/16 days) rather than a tighter
  // number, since both are weekly Trendlyne-family checks with the same real cadence.
  { id: 'trendlyne-dvm-scores-freshness', label: 'trendlyne_dvm_scores',
    category: 'fundamentals', critical: false, table: 'trendlyne_dvm_scores', dateColumn: 'date', warnDays: 10, failDays: 16 },
  { id: 'proprietary-scores-history-freshness', label: 'proprietary_scores_history (Altman/Ohlson/Graham/DuPont)',
    category: 'fundamentals', critical: false, table: 'proprietary_scores_history', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'working-capital-history-recency', label: 'working_capital_history (monthly cash-conversion-cycle)',
    category: 'fundamentals', critical: false, table: 'working_capital_history', dateColumn: 'fetched_at', warnDays: 45 },
  // 2026-08-11: marketsmojo_financials_fetcher.py -- MarketsMojo's get-financials (qtype=qoq,
  // paginated) returns ~34 quarters of consolidated+standalone P&L line items, confirmed live
  // and backfilled. dateColumn is fetched_at (crawl recency), not a period column, matching
  // working-capital-history-recency's own pattern right above -- the underlying quarterly
  // figures themselves only change when a company reports, so this checks "is the crawl still
  // running," same reasoning as mc-swot-history-freshness/working-capital-history-recency.
  { id: 'marketsmojo-financials-history-recency', label: 'marketsmojo_financials_history (quarterly P&L line items, consolidated+standalone)',
    category: 'fundamentals', critical: false, table: 'marketsmojo_financials_history', dateColumn: 'fetched_at', warnDays: 45 },
  // 2026-08-11: marketsmojo_fintrend_fetcher.py -- MarketsMojo's finTrendGraph returns the
  // HISTORY of the financial-trend score (previously only ever captured as a single latest
  // value via marketsmojo_header_info's ext_mojo_financial_pts), confirmed live and
  // backfilled. Same fetched_at-based crawl-recency check as the two entries above -- the
  // score itself only moves on ~quarterly earnings cadence.
  { id: 'marketsmojo-fintrend-history-recency', label: 'marketsmojo_fintrend_history (quarterly financial-trend score)',
    category: 'fundamentals', critical: false, table: 'marketsmojo_fintrend_history', dateColumn: 'fetched_at', warnDays: 45 },
  // 2026-08-11: marketsmojo_shareholding_fetcher.py -- MarketsMojo's shareholding_graphs gives
  // real per-quarter ownership-% history (Promoter/FII/MF/Insurance/Other-DII/NII, plus
  // Promoter pledged %), confirmed live and backfilled. This is the first source on the
  // platform with real historical depth for ownership data -- measurement.md flags every
  // existing ownership table as stuck at ~30 dates since 2026-06-30. Same fetched_at-based
  // crawl-recency check as the other marketsmojo_* fundamentals tables above.
  { id: 'marketsmojo-shareholding-history-recency', label: 'marketsmojo_shareholding_history (quarterly Promoter/FII/MF/Insurance/DII/NII holding %)',
    category: 'fundamentals', critical: false, table: 'marketsmojo_shareholding_history', dateColumn: 'fetched_at', warnDays: 45 },
  { id: 'stock-earnings-beats-recency', label: 'stock_earnings_beats',
    category: 'fundamentals', critical: false, table: 'stock_earnings_beats', dateColumn: 'fetched_at', warnDays: 10 },
  { id: 'eps-surprise-history-recency', label: 'eps_surprise_history',
    category: 'fundamentals', critical: false, table: 'eps_surprise_history', dateColumn: 'fetched_at', warnDays: 10 },
  // Written at request time (MCStockInfoPanel opens, see persistMcConsolidatedMetrics() in
  // mcApiService.ts) alongside mc_general_metrics' source_api=mc_consolidated rows above --
  // same "sparse by nature, no fixed schedule" reasoning, but this is its own dedicated table
  // (not shared with another writer), so the generic factory's bare MAX(fetched_at) is safe
  // here unlike mc_general_metrics, which needed the hand-rolled WHERE filter.
  { id: 'mc-swot-history-freshness', label: 'mc_swot_history (per-stock strengths/weaknesses/opportunities/threats)',
    category: 'fundamentals', critical: false, table: 'mc_swot_history', dateColumn: 'fetched_at', warnDays: 10 },
  // 2026-08-06 urls.txt data analysis (docs/url_explorer) -- see investsights_concall_fetcher.py.
  // Sparse by nature: the source's own "recent" window only has content when companies are
  // actively holding earnings calls, so a quiet week outside results season is not a failure.
  { id: 'concall-takeaways-recency', label: 'concall_takeaways (AI concall tone/takeaway)',
    category: 'fundamentals', critical: false, table: 'concall_takeaways', dateColumn: 'announcement_date', warnDays: 14 },
  // 2026-08-07 urls.txt open-source sourcing pass -- see mc_corporate_actions_fetcher.py /
  // investsights_corporate_actions_fetcher.py. Both feed ohlcv_adjust.py's cross-validation
  // (cross_validate_with_mc_actions) as well as the frontend corporate-action panels below.
  // dateColumn is fetched_at, not the event date, matching stock-earnings-beats/eps-surprise-
  // history's own pattern -- a stock's most recent real dividend/bonus/split can genuinely be
  // months old with no staleness implied; what matters is whether the crawl itself is current.
  { id: 'stock-corporate-action-history-freshness', label: 'stock_corporate_action_history (MC per-stock dividends/bonus/splits/rights)',
    category: 'fundamentals', critical: false, table: 'stock_corporate_action_history', dateColumn: 'fetched_at', warnDays: 10, failDays: 16 },
  { id: 'nse-filed-corporate-actions-freshness', label: 'nse_filed_corporate_actions (InvestSights, sourced from real NSE filings)',
    category: 'fundamentals', critical: false, table: 'nse_filed_corporate_actions', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },

  // macro
  { id: 'macro-asset-prices-freshness', label: 'macro_asset_prices (VIX/FII-DII/global indices/PCR-GEX/MMI)',
    category: 'macro', critical: true, table: 'macro_asset_prices', dateColumn: 'date', nativeDateColumn: true, warnDays: 3, failDays: 5 },
  // 2026-08-11: marketsmojo_index_fetcher.py -- fills the gap macro_asset_prices leaves for
  // Indian domestic indices (SENSEX, BSE-family, NSE sectoral indices beyond NIFTY50 itself),
  // confirmed live and backfilled. Not critical (macro_asset_prices above already covers the
  // one index -- NIFTY50 -- other engines depend on; this is supplementary breadth).
  { id: 'marketsmojo-index-history-freshness', label: 'marketsmojo_index_history (SENSEX/BSE-family/NSE sectoral index daily prices)',
    category: 'macro', critical: false, table: 'marketsmojo_index_history', dateColumn: 'date', nativeDateColumn: true, warnDays: 3, failDays: 5 },
  { id: 'eco-calendar-recency', label: 'eco_calendar (MC economic calendar)',
    category: 'macro', critical: false, table: 'eco_calendar', dateColumn: 'fetched_at', warnDays: 14 },
  { id: 'index-valuation-freshness', label: 'index_valuation (Nifty/Sensex PE-PB)',
    category: 'macro', critical: false, table: 'index_valuation', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'mc-global-snapshot-freshness', label: 'mc_global_snapshot (global indices/currencies/ADRs/commodities)',
    category: 'macro', critical: false, table: 'mc_global_snapshot', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'sector-global-corr-freshness', label: 'sector_global_corr',
    category: 'macro', critical: false, table: 'sector_global_corr', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // 2026-08-06 urls.txt data analysis (docs/url_explorer) -- see investsights_sector_intel_fetcher.py.
  { id: 'sector-rrg-history-freshness', label: 'sector_rrg_history (InvestSights Relative Rotation Graph)',
    category: 'macro', critical: false, table: 'sector_rrg_history', dateColumn: 'week_date', warnDays: 3, failDays: 5 },
  { id: 'sector-correlation-summary-freshness', label: 'sector_correlation_summary (InvestSights sector x sector matrix)',
    category: 'macro', critical: false, table: 'sector_correlation_summary', dateColumn: 'data_date', warnDays: 3, failDays: 5 },
  { id: 'historical-fno-sentiment-freshness', label: 'historical_fno_sentiment (index-level PCR/GEX)',
    category: 'macro', critical: false, table: 'historical_fno_sentiment', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'sector-fo-sentiment-freshness', label: 'sector_fo_sentiment',
    category: 'macro', critical: false, table: 'sector_fo_sentiment', dateColumn: 'date', nativeDateColumn: true, warnDays: 3, failDays: 5 },
  { id: 'nse-ipo-calendar-recency', label: 'nse_ipo_calendar',
    category: 'macro', critical: false, table: 'nse_ipo_calendar', dateColumn: 'fetched_at', warnDays: 14 },

  // signals / scoring
  // 2026-08-07: was warnDays/failDays 0.1/0.25 (2.4h/6h) -- but confluence.jobs.ts's
  // processConfluenceCompute() deliberately skips ALL real writes outside a ~9h window
  // (isMarketOpen() 9:15am-3:30pm PLUS isConfluenceComputeWindow()'s further 8am-9:15am/
  // 3:30pm-5pm skip -- see that file's own docstring: "Outside these hours (~00:00-06:00,
  // ~08:00-17:00 IST...)"), so this check false-alarmed WARN then CRITICAL FAIL every single
  // trading day from ~2.4h and ~6h after the ~8am pre-open write, hours before the legitimate
  // 5pm resume -- live-caught mid-warn via `npm run dq:check` at 10am IST. monitorScripts.ts's
  // sibling 'confluence-compute' entry already carries the correct fix (staleLimitHours: 10,
  // "generously above the real ~6h15m gap" per its own comment -- actually ~9h once
  // isConfluenceComputeWindow's wider skip is counted, but 10h safely covers either estimate);
  // this registry was never updated to match when that one was fixed. Matched to the same 10h
  // ceiling here (9/12 = 0.375/0.5 days) rather than re-deriving a tighter number, so both
  // registries agree on what "stale" means for the same underlying table.
  { id: 'confluence-signals-freshness', label: 'confluence_signals (canonical confluence engine)',
    category: 'scoring', critical: true, table: 'confluence_signals', dateColumn: 'computed_at',
    tradingDayAware: false, warnDays: 0.375, failDays: 0.5 },
  { id: 'unified-signals-freshness', label: 'unified_signals',
    category: 'signals', critical: false, table: 'unified_signals', dateColumn: 'signal_date', warnDays: 3, failDays: 5 },
  { id: 'screener-appearances-freshness', label: 'screener_appearances (feeds screener_momentum_score)',
    category: 'signals', critical: true, table: 'screener_appearances', dateColumn: 'appeared_date', warnDays: 3, failDays: 5 },
  { id: 'stock-event-triggers-freshness', label: 'stock_event_triggers (screener exit/tenure + news attention)',
    category: 'signals', critical: false, table: 'stock_event_triggers', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'screener-sector-rotation-freshness', label: 'screener_sector_rotation',
    category: 'signals', critical: false, table: 'screener_sector_rotation', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'intraday-recommendations-freshness', label: 'intraday_recommendations',
    category: 'signals', critical: false, table: 'intraday_recommendations', dateColumn: 'computed_at', warnDays: 3, failDays: 5 },
  // 2026-08-11: marketsmojo_technical_fetcher.py -- MarketsMojo's getCardInfo returns a full
  // ~3-year dated series (not just the current value) for weekly/monthly MACD/RSI/BB/KST/MA/
  // Dow/OBV + IndiGraph score, confirmed live and backfilled. dateColumn is the indicator's own
  // `date`, not fetched_at, so this reads whether the series is actually being kept current --
  // same cadence expectation as OHLCV since these are computed off daily bars.
  { id: 'marketsmojo-technical-history-freshness', label: 'marketsmojo_technical_history (MACD/RSI/BB/KST/MA/Dow/OBV/IndiGraph series)',
    category: 'signals', critical: false, table: 'marketsmojo_technical_history', dateColumn: 'date', warnDays: 3, failDays: 5 },

  // reference
  { id: 'mc-broker-reco-freshness', label: 'mc_broker_reco',
    category: 'reference', critical: false, table: 'mc_broker_reco', dateColumn: 'fetched_at', warnDays: 5, failDays: 10 },
  { id: 'mc-chart-patterns-freshness', label: 'mc_chart_patterns',
    category: 'reference', critical: false, table: 'mc_chart_patterns', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'market-breadth-freshness', label: 'market_breadth (advance/decline)',
    category: 'reference', critical: false, table: 'market_breadth', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'preopen-snapshot-freshness', label: 'preopen_snapshot',
    category: 'reference', critical: false, table: 'preopen_snapshot', dateColumn: 'snapshot_date', warnDays: 3, failDays: 5 },
  { id: 'nt-fno-dashboard-freshness', label: 'nt_fno_dashboard (NiftyTrader F&O dashboard)',
    category: 'reference', critical: false, table: 'nt_fno_dashboard', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'trendlyne-fno-activity-freshness', label: 'trendlyne_fno_activity',
    category: 'reference', critical: false, table: 'trendlyne_fno_activity', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'mc-pricefeed-daily-freshness', label: 'mc_pricefeed_daily (IND_PE/CAGR/consensus/delivery)',
    category: 'reference', critical: false, table: 'mc_pricefeed_daily', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'extra-endpoint-responses-recency', label: 'extra_endpoint_responses',
    category: 'reference', critical: false, table: 'extra_endpoint_responses', dateColumn: 'updated_at', warnDays: 10 },
  // news_sentiment_items -- a TS-side (not Python) live datasource, so it fell outside the
  // 2026-08-03 runPython()-call-site sweep above; genuinely never had a freshness check
  // despite being written by 4 sources (market-wide RSS, per-company Google News, BSE
  // announcements, and now GNews). tradingDayAware:false -- news happens on weekends/holidays
  // too, unlike the NSE-trading-day-gated tables above. warnDays kept tight since the
  // fastest of its writers (market-wide RSS) runs every 15 min.
  { id: 'news-sentiment-freshness', label: 'news_sentiment_items (RSS + Google News + BSE + GNews)',
    category: 'reference', critical: false, table: 'news_sentiment_items', dateColumn: 'fetched_at',
    tradingDayAware: false, warnDays: 1, failDays: 3 },
];

export const DATA_QUALITY_CHECKS: DataQualityCheck[] = [
  // ── OHLCV ──────────────────────────────────────────────────────────────
  {
    id: 'ohlcv-freshness-coverage',
    label: 'OHLCV freshness & universe coverage',
    category: 'ohlcv',
    critical: true,
    // stock_ohlcv.date is a native Postgres DATE column (unlike most other date columns in
    // this file, which are TEXT) — cast it to ::text so it compares against date('now',...)'s
    // text output (see sqlTranslate.ts); ::text is stripped on the SQLite path by stripPgCasts.
    sql: `SELECT MAX(date) AS last_date, COUNT(DISTINCT symbol) AS symbols
          FROM stock_ohlcv WHERE date::text >= date('now','-10 days')`,
    evaluate: (row, now) => {
      const stale = tradingDaysStale(row?.last_date, now);
      const symbols = Number(row?.symbols) || 0;
      if (stale == null) return { status: 'fail', detail: 'No stock_ohlcv rows in the last 10 days' };
      if (symbols < 300) return { status: 'fail', detail: `Only ${symbols} distinct symbols refreshed in 10d (expected 300+)` };
      if (stale > 5) return { status: 'fail', detail: `Latest bar is ${fmtDays(stale)} old, ${symbols} symbols` };
      if (stale > 3) return { status: 'warn', detail: `Latest bar is ${fmtDays(stale)} old, ${symbols} symbols` };
      return { status: 'pass', detail: `${symbols} symbols, latest bar ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'ohlcv-bar-plausibility',
    label: 'OHLCV bar plausibility (high>=low, close>0)',
    category: 'ohlcv',
    critical: true,
    sql: `SELECT
            (SELECT COUNT(*) FROM stock_ohlcv WHERE date::text >= date('now','-5 days')
               AND (close <= 0 OR high < low OR is_suspect = 1)) AS bad,
            (SELECT COUNT(*) FROM stock_ohlcv WHERE date::text >= date('now','-5 days')) AS total`,
    evaluate: (row) => {
      const ratio = safeRatio(row?.bad, row?.total);
      const total = Number(row?.total) || 0;
      if (total === 0) return { status: 'fail', detail: 'No bars in the last 5 days to evaluate' };
      if (ratio > 0.05) return { status: 'fail', detail: `${(ratio * 100).toFixed(1)}% of recent bars are malformed/suspect` };
      if (ratio > 0.01) return { status: 'warn', detail: `${(ratio * 100).toFixed(1)}% of recent bars are malformed/suspect` };
      return { status: 'pass', detail: `${(ratio * 100).toFixed(2)}% malformed (${row?.bad}/${total})` };
    },
  },

  // ── Technical signals / ML ────────────────────────────────────────────
  {
    id: 'technical-signals-freshness-coverage',
    label: 'technical_signals freshness & win_probability coverage',
    category: 'signals',
    critical: true,
    sql: `SELECT COUNT(*) AS total, COUNT(win_probability) AS scored, MAX(date) AS last_date
          FROM technical_signals WHERE date >= date('now','-3 days')`,
    evaluate: (row, now) => {
      // technical-signals-daily only runs 8:30am-4pm IST on NSE trading days (queues.ts), so a
      // plain calendar-day gap false-fails every Monday morning purely from the Sat/Sun gap --
      // the exact class already fixed for ohlcv/fii-dii/market-regimes freshness on 2026-08-03,
      // just never migrated to this hand-rolled check. tradingDaysStale() subtracts the weekend.
      const stale = tradingDaysStale(row?.last_date, now);
      const total = Number(row?.total) || 0;
      const coverage = safeRatio(row?.scored, row?.total);
      if (stale == null || total === 0) return { status: 'fail', detail: 'No technical_signals rows in the last 3 days' };
      if (stale > 3) return { status: 'fail', detail: `Latest scan is ${fmtDays(stale)} old` };
      // The exact regression class noted in CLAUDE.md: a filter bug silently collapsed
      // win_probability coverage to ~1-3% for weeks while the job kept exiting 0.
      if (coverage < 0.5) return { status: 'fail', detail: `win_probability coverage only ${(coverage * 100).toFixed(1)}% of ${total} rows (last 3d)` };
      if (coverage < 0.8) return { status: 'warn', detail: `win_probability coverage ${(coverage * 100).toFixed(1)}% of ${total} rows (last 3d)` };
      return { status: 'pass', detail: `${(coverage * 100).toFixed(1)}% coverage, ${total} rows, latest ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'technical-signals-range-bounds',
    label: 'technical_signals value-range invariants (RSI 0-100, win-prob 0-1)',
    category: 'signals',
    critical: true,
    sql: `SELECT COUNT(*) AS bad FROM technical_signals
          WHERE date >= date('now','-3 days') AND (
            (rsi IS NOT NULL AND (rsi < 0 OR rsi > 100)) OR
            (win_probability IS NOT NULL AND (win_probability < 0 OR win_probability > 1)) OR
            (calibrated_win_probability IS NOT NULL AND (calibrated_win_probability < 0 OR calibrated_win_probability > 1))
          )`,
    evaluate: (row) => {
      const bad = Number(row?.bad) || 0;
      if (bad > 0) return { status: 'fail', detail: `${bad} rows violate RSI/win-probability bounds (last 3d)` };
      return { status: 'pass', detail: 'No bound violations in the last 3 days' };
    },
  },
  {
    id: 'technical-signals-stuck-value',
    label: 'technical_signals signal_score variance (catches a stuck default)',
    category: 'signals',
    critical: false,
    sql: `SELECT COUNT(DISTINCT signal_score) AS distinct_scores, COUNT(*) AS total
          FROM technical_signals WHERE date >= date('now','-3 days')`,
    evaluate: (row) => {
      const total = Number(row?.total) || 0;
      const distinct = Number(row?.distinct_scores) || 0;
      if (total === 0) return { status: 'fail', detail: 'No rows in the last 3 days' };
      if (distinct <= 1) return { status: 'fail', detail: `signal_score is identical across all ${total} rows — looks stuck at a default` };
      return { status: 'pass', detail: `${distinct} distinct signal_score values across ${total} rows` };
    },
  },
  {
    id: 'model-registry-active-ensemble',
    label: 'Active ensemble model exists and was retrained recently',
    category: 'ml',
    critical: false,
    sql: `SELECT trained_at, cv_roc_auc FROM model_registry
          WHERE model_name = 'ensemble' AND is_active = 1 ORDER BY trained_at DESC LIMIT 1`,
    evaluate: (row, now) => {
      if (!row) return { status: 'fail', detail: 'No active ensemble model in model_registry' };
      const stale = daysStale(row.trained_at, now);
      if (stale != null && stale > 45) return { status: 'warn', detail: `Active ensemble last retrained ${fmtDays(stale)} ago (AUC ${row.cv_roc_auc ?? 'n/a'})` };
      return { status: 'pass', detail: `Active ensemble retrained ${fmtDays(stale)} ago, AUC ${row.cv_roc_auc ?? 'n/a'}` };
    },
  },
  {
    id: 'feature-store-freshness',
    label: 'feature_store freshness',
    category: 'ml',
    critical: false,
    // feature_store.date is also a native Postgres DATE column — see the stock_ohlcv note above.
    sql: `SELECT MAX(date) AS last_date, COUNT(DISTINCT symbol) AS symbols
          FROM feature_store WHERE date::text >= date('now','-10 days')`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'fail', detail: 'No feature_store rows in the last 10 days' };
      if (stale > 5) return { status: 'warn', detail: `Latest feature row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `${row?.symbols ?? 0} symbols, latest ${fmtDays(stale)} old` };
    },
  },

  // ── Composite scoring ─────────────────────────────────────────────────
  {
    id: 'stock-scores-freshness-coverage',
    label: 'stock_scores freshness & coverage',
    category: 'scoring',
    critical: true,
    // 'long_term' is the canonical timeframe read by getTopRatedStocks/unified_ranker.py's
    // own join (verified: scoringService.ts:129 default param, unified_ranker.py:432) — the
    // schema also allows 'intraday'/'short' (misc.router.ts:295) but nothing ever writes/reads
    // a 'swing' timeframe; an earlier version of this check used that guessed value and would
    // have always seen 0 rows, alarming as a permanent critical failure.
    sql: `SELECT COUNT(*) AS total,
                 (SELECT COUNT(*) FROM nse_stocks) AS universe,
                 MAX(last_updated) AS last_updated
          FROM stock_scores WHERE timeframe = 'long_term'`,
    evaluate: (row, now) => {
      const total = Number(row?.total) || 0;
      const universe = Number(row?.universe) || 0;
      const stale = daysStale(row?.last_updated, now);
      if (total === 0) return { status: 'fail', detail: 'stock_scores (long_term) is empty' };
      if (universe > 0 && total < universe * 0.2) {
        return { status: 'fail', detail: `Only ${total}/${universe} NSE stocks have a long_term score` };
      }
      if (stale != null && stale > 3) return { status: 'warn', detail: `Newest stock_scores row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `${total} stocks scored (of ${universe} in universe)` };
    },
  },
  {
    id: 'unified-recommendations-freshness-coverage',
    label: 'unified_recommendations (canonical ranker) freshness & coverage',
    category: 'scoring',
    critical: true,
    sql: `SELECT computed_at, COUNT(*) AS row_count
          FROM unified_recommendations
          WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
          GROUP BY computed_at`,
    evaluate: (row, now) => {
      if (!row) return { status: 'fail', detail: 'unified_recommendations is empty' };
      const stale = daysStale(row.computed_at, now);
      const rowCount = Number(row.row_count) || 0;
      if (rowCount < 30) return { status: 'fail', detail: `Latest unified_ranker run only produced ${rowCount} rows` };
      if (stale != null && stale > 4) return { status: 'fail', detail: `Latest unified_ranker run is ${fmtDays(stale)} old` };
      if (stale != null && stale > 2) return { status: 'warn', detail: `Latest unified_ranker run is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `${rowCount} rows, computed ${fmtDays(stale)} ago` };
    },
  },
  {
    id: 'unified-recommendations-conviction-enum',
    label: 'unified_recommendations.conviction_level enum integrity',
    category: 'scoring',
    critical: false,
    sql: `SELECT COUNT(*) AS bad FROM unified_recommendations
          WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
          AND conviction_level NOT IN ('S_ELITE','A_HIGH','B_MEDIUM','C_LOW','D_MARGINAL')`,
    evaluate: (row) => {
      const bad = Number(row?.bad) || 0;
      if (bad > 0) return { status: 'fail', detail: `${bad} rows have an unrecognized conviction_level` };
      return { status: 'pass', detail: 'All conviction_level values are within the known enum' };
    },
  },
  // ── Regression guards for the four defects the 2026-08-11 audit found live ──────────
  // Every one of these was invisible for weeks because nothing compared the canonical table
  // against the price universe it is supposed to describe. Freshness checks cannot catch any
  // of them: the table was fresh and full the whole time, just full of the wrong rows.
  {
    id: 'unified-recommendations-ghost-symbols',
    label: 'unified_recommendations symbols with no price history anywhere',
    category: 'scoring',
    critical: true,
    // 29,014 rows across 2,500 symbols absent from stock_ohlcv on EVERY date were found on
    // 2026-08-11, 3,774 carrying an actionable Buy/Sell. Source was fixed 2026-07-31
    // (_restrict_to_tradeable_universe) but the historical rows survived, because run() purges
    // only the computed_at it is writing. A ghost can never be graded or traded, and it
    // silently biases every measurement taken over the table.
    sql: `SELECT COUNT(*) AS ghosts
          FROM unified_recommendations u
          WHERE NOT EXISTS (SELECT 1 FROM stock_ohlcv s WHERE s.symbol = u.symbol)`,
    evaluate: (row) => {
      const ghosts = Number(row?.ghosts) || 0;
      if (ghosts > 0) return {
        status: 'fail',
        detail: `${ghosts} rows name a symbol with no stock_ohlcv history at all — ` +
                `run: python data_integrity_repair.py --ghost-recommendations`,
      };
      return { status: 'pass', detail: 'Every ranked symbol has price history' };
    },
  },
  {
    id: 'unified-recommendations-trading-day',
    label: 'unified_recommendations snapshots dated to a real trading day',
    category: 'scoring',
    critical: true,
    // 9,096 rows sat on 2026-07-05/07-12/07-25/08-09 -- Saturdays and Sundays -- because run()
    // took date.today() while the pipeline deliberately runs early on closed days. Such a
    // snapshot is unreachable to any consumer joining on a trading date. Fixed at source by
    // as_of.logical_session_date(); this catches a regression or a new writer repeating it.
    sql: `SELECT COUNT(DISTINCT u.computed_at) AS bad_days
          FROM unified_recommendations u
          WHERE NOT EXISTS (
            SELECT 1 FROM stock_ohlcv s WHERE s.date = u.computed_at::date
          )`,
    evaluate: (row) => {
      const bad = Number(row?.bad_days) || 0;
      if (bad > 0) return {
        status: 'fail',
        detail: `${bad} snapshot date(s) are not trading days — check as_of.logical_session_date(), ` +
                `then: python data_integrity_repair.py --weekend-recommendations`,
      };
      return { status: 'pass', detail: 'All snapshots are dated to real sessions' };
    },
  },
  {
    id: 'unified-recommendations-liquid-coverage',
    label: 'unified_recommendations coverage of the liquid (>=Rs 1cr ADT) universe',
    category: 'scoring',
    critical: true,
    // Coverage ran 0.3%-0.5% on seven dates in July 2026 while the table still held 800-2,300
    // rows -- it was ranking a universe almost disjoint from the tradeable one, and row count
    // alone (the existing freshness check) read healthy throughout. Post-fix it runs 59%-92%.
    sql: `WITH liq AS (
            SELECT s.symbol
            FROM stock_ohlcv s
            WHERE s.date = (SELECT MAX(date) FROM stock_ohlcv)
              AND COALESCE(s.is_suspect, 0) = 0
              AND s.close * s.volume >= 10000000
          )
          SELECT (SELECT COUNT(*) FROM liq) AS liquid,
                 (SELECT COUNT(*) FROM liq
                  WHERE EXISTS (
                    SELECT 1 FROM unified_recommendations u
                    WHERE u.symbol = liq.symbol
                      AND u.computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
                  )) AS covered`,
    evaluate: (row) => {
      const liquid = Number(row?.liquid) || 0;
      const covered = Number(row?.covered) || 0;
      if (liquid === 0) return { status: 'warn', detail: 'No liquid universe on the latest session' };
      const pct = (100 * covered) / liquid;
      const d = `${covered}/${liquid} liquid names ranked (${pct.toFixed(1)}%)`;
      if (pct < 25) return { status: 'fail', detail: `${d} — the ranker's universe has diverged from the tradeable one` };
      if (pct < 50) return { status: 'warn', detail: d };
      return { status: 'pass', detail: d };
    },
  },
  {
    id: 'stock-delivery-trades-not-duplicated',
    label: 'stock_delivery_data.trades is a trade count, not a copy of delivery_qty',
    category: 'ohlcv',   // bhavcopy-derived, same feed as the price bars
    critical: false,
    // deliveryFetcher.ts read NO_OF_TRADES positionally as cols[len-2]; sec_bhavdata_full ends
    // ... NO_OF_TRADES, DELIV_QTY, DELIV_PER, so it captured DELIV_QTY in 100% of 664,006 rows.
    // Fixed to header.indexOf('NO_OF_TRADES'); this catches the column silently drifting again.
    // Compared as a SHARE of populated rows, not a raw count: `trades = delivery_qty` is
    // legitimately true for a genuinely illiquid name, and firing on a bare count > 0 makes this
    // check cry wolf on real data. Live example 2026-08-11: ASTAR on 2026-08-10 traded 4 shares
    // in 4 trades with 100% delivery -- 4 = 4, correct on every column, and it alone flipped the
    // whole check to 'fail'. The defect this guards is not subtle (it was 100% of 664,006 rows,
    // because a positional read captured DELIV_QTY instead of NO_OF_TRADES), so a 5% floor
    // catches any real recurrence with enormous margin while ignoring arithmetic coincidence.
    sql: `SELECT COUNT(*) FILTER (WHERE trades = delivery_qty) AS dupes,
                 COUNT(*) AS populated
          FROM stock_delivery_data
          WHERE trades IS NOT NULL`,
    evaluate: (row) => {
      const dupes = Number(row?.dupes) || 0;
      const populated = Number(row?.populated) || 0;
      if (populated === 0) return { status: 'warn', detail: 'stock_delivery_data.trades is entirely NULL — the fetcher is not populating it' };
      const pct = (100 * dupes) / populated;
      if (pct >= 5) return {
        status: 'fail',
        detail: `${dupes}/${populated} rows (${pct.toFixed(1)}%) have trades = delivery_qty — the NSE column index has drifted again; ` +
                `then: python data_integrity_repair.py --delivery-trades`,
      };
      const tail = dupes > 0 ? ` (${dupes}/${populated} coincidental matches on illiquid names, below the 5% drift floor)` : '';
      return { status: 'pass', detail: `trades is distinct from delivery_qty${tail}` };
    },
  },
  {
    id: 'quant-scores-freshness-coverage',
    label: 'quant_scores freshness & coverage',
    category: 'scoring',
    critical: true,
    sql: `SELECT COUNT(*) AS total, MAX(last_computed) AS last_computed FROM quant_scores`,
    evaluate: (row, now) => {
      const total = Number(row?.total) || 0;
      const stale = daysStale(row?.last_computed, now);
      if (total < 300) return { status: 'fail', detail: `quant_scores only has ${total} rows` };
      if (stale != null && stale > 4) return { status: 'warn', detail: `quant_scores last computed ${fmtDays(stale)} ago` };
      return { status: 'pass', detail: `${total} rows, last computed ${fmtDays(stale)} ago` };
    },
  },

  // ── Fundamentals ───────────────────────────────────────────────────────
  {
    id: 'stock-fundamentals-null-rate',
    label: 'stock_fundamentals core-field null rate',
    category: 'fundamentals',
    critical: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(trailing_pe) AS has_pe,
                 COUNT(market_cap) AS has_mcap
          FROM stock_fundamentals`,
    evaluate: (row) => {
      const total = Number(row?.total) || 0;
      if (total === 0) return { status: 'fail', detail: 'stock_fundamentals is empty' };
      const mcapCoverage = safeRatio(row?.has_mcap, row?.total);
      if (mcapCoverage < 0.5) return { status: 'fail', detail: `market_cap populated for only ${(mcapCoverage * 100).toFixed(1)}% of ${total} rows` };
      if (mcapCoverage < 0.8) return { status: 'warn', detail: `market_cap populated for ${(mcapCoverage * 100).toFixed(1)}% of ${total} rows` };
      return { status: 'pass', detail: `${total} rows, market_cap coverage ${(mcapCoverage * 100).toFixed(1)}%` };
    },
  },
  {
    id: 'fundamentals-history-freshness',
    label: 'fundamentals_history point-in-time snapshot freshness',
    category: 'fundamentals',
    critical: false,
    sql: `SELECT MAX(as_of_date) AS last_snapshot, COUNT(DISTINCT symbol) AS symbols
          FROM fundamentals_history WHERE as_of_date >= date('now','-10 days')`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_snapshot, now);
      if (stale == null) return { status: 'warn', detail: 'No fundamentals_history snapshot in the last 10 days' };
      if (stale > 5) return { status: 'warn', detail: `Latest snapshot is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `${row?.symbols ?? 0} symbols snapshotted, latest ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'analyst-estimates-freshness',
    label: 'analyst_estimates_history freshness',
    category: 'fundamentals',
    critical: false,
    sql: `SELECT MAX(as_of_date) AS last_snapshot, COUNT(DISTINCT symbol) AS symbols
          FROM analyst_estimates_history WHERE as_of_date >= date('now','-14 days')`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_snapshot, now);
      if (stale == null) return { status: 'warn', detail: 'No analyst_estimates_history snapshot in the last 14 days' };
      if (stale > 10) return { status: 'warn', detail: `Latest snapshot is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `${row?.symbols ?? 0} symbols, latest ${fmtDays(stale)} old` };
    },
  },

  // ── Options / F&O ──────────────────────────────────────────────────────
  {
    id: 'stock-options-oi-freshness-iv-coverage',
    label: 'stock_options_oi freshness & ATM-IV coverage',
    category: 'options',
    critical: true,
    sql: `SELECT COUNT(*) AS total, COUNT(atm_iv) AS has_iv, MAX(date) AS last_date
          FROM stock_options_oi WHERE date >= date('now','-5 days')`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
      const total = Number(row?.total) || 0;
      if (stale == null || total === 0) return { status: 'fail', detail: 'stock_options_oi has no rows in the last 5 days' };
      const ivCoverage = safeRatio(row?.has_iv, row?.total);
      if (ivCoverage < 0.3) return { status: 'warn', detail: `atm_iv populated for only ${(ivCoverage * 100).toFixed(1)}% of ${total} recent rows` };
      return { status: 'pass', detail: `${total} rows, IV coverage ${(ivCoverage * 100).toFixed(1)}%, latest ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'stock-options-oi-pcr-bounds',
    label: 'stock_options_oi PCR sanity bounds',
    category: 'options',
    critical: false,
    sql: `SELECT COUNT(*) AS bad FROM stock_options_oi
          WHERE date >= date('now','-5 days') AND pcr IS NOT NULL AND (pcr < 0 OR pcr > 50)`,
    evaluate: (row) => {
      const bad = Number(row?.bad) || 0;
      if (bad > 0) return { status: 'warn', detail: `${bad} rows have a PCR outside [0, 50] (last 5d) — check for a divide-by-zero` };
      return { status: 'pass', detail: 'No PCR outliers in the last 5 days' };
    },
  },

  // ── Flows / institutional ──────────────────────────────────────────────
  {
    id: 'fii-dii-flow-freshness',
    label: 'fii_dii_flow freshness',
    category: 'flows',
    critical: true,
    sql: `SELECT MAX(date) AS last_date FROM fii_dii_flow WHERE fii_net IS NOT NULL`,
    evaluate: (row, now) => {
      const stale = tradingDaysStale(row?.last_date, now);
      if (stale == null) return { status: 'fail', detail: 'No fii_dii_flow rows with a non-null fii_net' };
      if (stale > 5) return { status: 'fail', detail: `Latest FII/DII row is ${fmtDays(stale)} old` };
      if (stale > 3) return { status: 'warn', detail: `Latest FII/DII row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `Latest FII/DII row ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'insider-trades-recency',
    label: 'insider_trades recency',
    category: 'flows',
    critical: false,
    // insider_trades.date is NSE's raw display text ("22 May, 2026"), not sortable lexically --
    // MAX(date) returned "31 Oct, 2025" (an alphabetically-late month name) while the real
    // latest row was 2026-07-31, a 276-day false "stale" reading (found 2026-08-03). date_iso
    // is the parsed, ISO, actually-sortable column added for exactly this reason (see CLAUDE.md's
    // 2026-08-01 midnight-crossing/date_iso session) and has had 100% coverage since; use it.
    sql: `SELECT MAX(date_iso) AS last_date FROM insider_trades`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'insider_trades is empty' };
      if (stale > 14) return { status: 'warn', detail: `Latest insider trade is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Latest insider trade ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'bulk-deals-recency',
    label: 'bulk/block deals recency',
    category: 'flows',
    critical: false,
    // `bulk_deals` was fed by a feature merged 2026-05-19 and reverted 2026-05-21 -- its last
    // real row IS 2026-05-19, so its "76 days stale" reading was correct, not a bug, but it was
    // monitoring a table nothing has written to in 2.5 months. `block_deals` (tickertape_deals_
    // fetcher.py, wired into ml-daily-ops since 2026-07-31, carries pctTransacted/% of float) is
    // the live replacement -- point the check at the table that's actually fed (found 2026-08-03).
    sql: `SELECT MAX(date) AS last_date FROM block_deals`,
    evaluate: (row, now) => {
      const stale = tradingDaysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'block_deals is empty' };
      if (stale > 14) return { status: 'warn', detail: `Latest bulk/block deal is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Latest bulk/block deal ${fmtDays(stale)} old` };
    },
  },

  // ── Outcomes / feedback loop ────────────────────────────────────────────
  {
    id: 'signal-outcomes-resolution-rate',
    label: 'signal_outcomes pending-resolution rate (outcome-resolver liveness)',
    category: 'outcomes',
    critical: true,
    sql: `SELECT COUNT(*) AS total, COUNT(CASE WHEN outcome = 'PENDING' THEN 1 END) AS pending
          FROM signal_outcomes WHERE horizon_days = 15 AND signal_date <= date('now','-20 days')
            AND signal_source = 'technical'`,
    evaluate: (row) => {
      const total = Number(row?.total) || 0;
      if (total === 0) return { status: 'warn', detail: 'No 15d-horizon signals old enough to expect resolution yet' };
      const pendingRatio = safeRatio(row?.pending, row?.total);
      // These rows are already >20 calendar days past their signal_date with a 15-day
      // horizon — they should have resolved. A high PENDING rate here means the
      // outcome-resolver loop stopped writing, even if the job itself reports success.
      if (pendingRatio > 0.5) return { status: 'fail', detail: `${(pendingRatio * 100).toFixed(1)}% of ${total} resolvable signals are still PENDING` };
      if (pendingRatio > 0.2) return { status: 'warn', detail: `${(pendingRatio * 100).toFixed(1)}% of ${total} resolvable signals are still PENDING` };
      return { status: 'pass', detail: `${(pendingRatio * 100).toFixed(1)}% pending of ${total} resolvable signals` };
    },
  },
  {
    id: 'market-regimes-freshness',
    label: 'market_regimes (regime detector) freshness',
    category: 'outcomes',
    critical: true,
    sql: `SELECT MAX(date) AS last_date FROM market_regimes`,
    evaluate: (row, now) => {
      const stale = tradingDaysStale(row?.last_date, now);
      if (stale == null) return { status: 'fail', detail: 'market_regimes is empty' };
      if (stale > 4) return { status: 'fail', detail: `Latest regime row is ${fmtDays(stale)} old` };
      if (stale > 2) return { status: 'warn', detail: `Latest regime row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `Latest regime row ${fmtDays(stale)} old` };
    },
  },

  // ── Reference / surveillance data ──────────────────────────────────────
  {
    id: 'nse-stocks-universe-size',
    label: 'nse_stocks master list size',
    category: 'reference',
    critical: false,
    sql: `SELECT COUNT(*) AS total FROM nse_stocks WHERE status = 'ACTIVE'`,
    evaluate: (row) => {
      const total = Number(row?.total) || 0;
      if (total < 1000) return { status: 'warn', detail: `Only ${total} ACTIVE nse_stocks rows (expected 1000+)` };
      return { status: 'pass', detail: `${total} ACTIVE stocks in the master list` };
    },
  },
  {
    id: 'corporate-actions-recency',
    label: 'corporate_actions ingestion recency',
    category: 'reference',
    critical: false,
    sql: `SELECT MAX(ingested_at) AS last_ingested FROM corporate_actions`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_ingested, now);
      if (stale == null) return { status: 'warn', detail: 'corporate_actions is empty' };
      if (stale > 14) return { status: 'warn', detail: `Last corporate_actions ingest was ${fmtDays(stale)} ago` };
      return { status: 'pass', detail: `Last ingested ${fmtDays(stale)} ago` };
    },
  },
  {
    id: 'credit-rating-events-recency',
    label: 'credit_rating_events fetch recency',
    category: 'reference',
    critical: false,
    sql: `SELECT MAX(fetched_at) AS last_fetched FROM credit_rating_events`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_fetched, now);
      if (stale == null) return { status: 'warn', detail: 'credit_rating_events is empty' };
      if (stale > 14) return { status: 'warn', detail: `Last fetch was ${fmtDays(stale)} ago (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Last fetched ${fmtDays(stale)} ago` };
    },
  },

  // ── Macro ────────────────────────────────────────────────────────────
  {
    id: 'macro-indicators-freshness',
    label: 'macro_indicators freshness',
    category: 'macro',
    critical: false,
    sql: `SELECT MAX(date) AS last_date, COUNT(DISTINCT indicator_name) AS indicators
          FROM macro_indicators WHERE date >= date('now','-10 days')`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'No macro_indicators rows in the last 10 days' };
      if (stale > 5) return { status: 'warn', detail: `Latest macro indicator is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `${row?.indicators ?? 0} indicators, latest ${fmtDays(stale)} old` };
    },
  },

  // ── ML state (hand-rolled — not a datasource, so not in TABLE_FRESHNESS_CHECKS) ─────────
  {
    // 2026-08-05: converts a "worth re-checking after any material regime shift, not just
    // trusting it's handled" review note into an actual automated check, rather than leaving
    // it as something a human has to remember to look at. ml_calibration.py's
    // edge_adjusted_probability() only shrinks a regime's win_probability toward neutral once
    // that regime's LIVE discrimination decays below AUC_TRUST_FLOOR (0.55) -- this surfaces
    // the moment that happens in the daily digest instead of relying on someone re-running
    // scripts/diff_edge_adjustment.py by hand.
    id: 'regime-edge-trust-floor',
    label: 'ML win-probability regime edge status',
    category: 'ml',
    critical: false,
    sql: `SELECT
            SUM(CASE WHEN ready = 1 AND auc < 0.55 THEN 1 ELSE 0 END) AS breached_count,
            SUM(CASE WHEN ready = 1 THEN 1 ELSE 0 END) AS ready_count,
            MAX(computed_at) AS latest_computed_at
          FROM regime_edge_status`,
    evaluate: (row, now) => {
      const readyCount = Number(row?.ready_count ?? 0);
      const breachedCount = Number(row?.breached_count ?? 0);
      if (readyCount === 0) {
        return { status: 'pass', detail: 'No regime has accumulated enough history yet to evaluate live win-probability edge — expected while history builds.' };
      }
      const stale = daysStale(row?.latest_computed_at, now);
      if (stale != null && stale > 3) {
        return { status: 'warn', detail: `regime_edge_status hasn't refreshed in ${fmtDays(stale)} — ml_calibration.py's nightly snapshot may not be running.` };
      }
      if (breachedCount > 0) {
        // Not critical: this doesn't mean anything is broken, just that a regime's live
        // discrimination has decayed — edge_adjusted_probability() (if app_settings.
        // edge_adjustment_enabled='true') will start shrinking that regime's win_probability
        // toward neutral, which is the intended self-correction, not a failure to fix here.
        return { status: 'warn', detail: `${breachedCount} of ${readyCount} regime(s) with sufficient history now sit below the 0.55 live-edge trust floor.` };
      }
      return { status: 'pass', detail: `All ${readyCount} regime(s) with sufficient history clear the live-edge trust floor.` };
    },
  },

  // mc_general_metrics is a shared multi-source table (also written by ET Marketstats' daily
  // sync) -- the TABLE_FRESHNESS_CHECKS factory only supports a bare MAX(dateColumn), which
  // would report "fresh" off et_marketstats' own writes even if this source_api stopped
  // writing entirely, so this needs the WHERE filter a hand-rolled check can express.
  // mc_consolidated is written at request time (MCStockInfoPanel opens, see
  // persistMcConsolidatedMetrics() in mcApiService.ts), not on a fixed schedule, so a quiet
  // day with zero panel opens is expected -- soft-warn only, matching insider-trades-recency's
  // "sparse by nature" style rather than failing.
  {
    id: 'mc-consolidated-metrics-freshness',
    label: 'mc_general_metrics (source_api=mc_consolidated, per-stock MC scores)',
    category: 'fundamentals',
    critical: false,
    sql: `SELECT MAX(fetched_at) AS last_date FROM mc_general_metrics WHERE source_api = 'mc_consolidated'`,
    evaluate: (row, now) => {
      const stale = tradingDaysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'No mc_consolidated rows written yet — expected until a stock panel has been opened at least once.' };
      if (stale > 10) return { status: 'warn', detail: `Latest mc_consolidated metric row is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Latest mc_consolidated metric row ${fmtDays(stale)} old` };
    },
  },

  // screener-appearances-freshness above probes the whole table, so it reads "fresh" off the
  // ~900 healthy Trendlyne screeners while an individual screener is permanently dead. Measured
  // live 2026-08-11: 96 of 1003 registered Trendlyne screeners (9.6%) have never held a single
  // constituent, and they are the highest-signal ones -- Buys/Sells by Superstar Investors, all
  // four Red Flag screeners, every business-group/thematic list, the pivot R1-R3/S1-S3 breakouts.
  // Verified against the live API rather than assumed: those screenpks return head.status=0 with
  // a correct NSEcode header and tableData=[], with and without groupName, i.e. gated upstream on
  // the broker-webview endpoint -- not a parser bug and not fixable from this side.
  //
  // So 9.6% is the accepted baseline, not the alert. What this catches is that share GROWING,
  // which is the shape a real regression takes: extract_screener_info() skips stock extraction
  // outright when no header matches nsecode/symbol (the 2026-07-23 fix that replaced the blind
  // "column 0" fallback), so if Trendlyne renames `unique_name` again every screener silently
  // goes empty at once and this jumps toward 100%. Thresholds are a SHARE against a floor sized
  // well clear of the real defect, per the "bare count > 0 fires on correct data" rule.
  {
    id: 'trendlyne-screener-constituent-coverage',
    label: 'trendlyne_screeners with zero constituents (per-screener, not aggregate)',
    category: 'signals',
    critical: false,
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN NOT EXISTS (
                       SELECT 1 FROM trendlyne_screener_stocks ss
                       WHERE ss.screener_id = s.screener_id
                     ) THEN 1 ELSE 0 END) AS empty_count
          FROM trendlyne_screeners s`,
    evaluate: (row) => {
      const total = Number(row?.total ?? 0);
      const empty = Number(row?.empty_count ?? 0);
      if (total === 0) return { status: 'fail', detail: 'No Trendlyne screeners registered at all — discovery has never run.' };
      const share = safeRatio(empty, total);
      const pct = (share * 100).toFixed(1);
      if (share > 0.25) return { status: 'fail', detail: `${empty}/${total} (${pct}%) Trendlyne screeners hold zero constituents — well above the ~10% gated-upstream baseline. Check that tableHeaders still expose a 'NSEcode' unique_name.` };
      if (share > 0.15) return { status: 'warn', detail: `${empty}/${total} (${pct}%) Trendlyne screeners hold zero constituents, up from the ~10% gated-upstream baseline.` };
      return { status: 'pass', detail: `${empty}/${total} (${pct}%) Trendlyne screeners hold zero constituents — consistent with the subscription-gated baseline.` };
    },
  },

  // ── Generated from TABLE_FRESHNESS_CHECKS (see the factory + mandate comment above) ──────
  ...TABLE_FRESHNESS_CHECKS.map(makeFreshnessCheck),
];

// Fail fast on a duplicate id — two checks silently overwriting the same
// data_quality_results row would hide one of them from the digest forever.
{
  const seen = new Set<string>();
  for (const c of DATA_QUALITY_CHECKS) {
    if (seen.has(c.id)) throw new Error(`Duplicate DATA_QUALITY_CHECKS id: ${c.id}`);
    seen.add(c.id);
  }
}

// ─── Persistence (self-creating table, same pattern as job_heartbeat) ─────────

const DDL = `CREATE TABLE IF NOT EXISTS data_quality_results (
  check_id   TEXT PRIMARY KEY,
  label      TEXT,
  category   TEXT,
  critical   INTEGER,
  status     TEXT,
  detail     TEXT,
  checked_at BIGINT
)`;

let _tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!_tableReady) {
    _tableReady = dbExec(DDL).catch(() => { /* already exists / DB not ready */ });
  }
  return _tableReady;
}

async function persistResult(check: DataQualityCheck, result: { status: DataQualityStatus; detail: string }): Promise<void> {
  try {
    await dbRun(
      `INSERT INTO data_quality_results (check_id, label, category, critical, status, detail, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(check_id) DO UPDATE SET
         label = ?, category = ?, critical = ?, status = ?, detail = ?, checked_at = ?`,
      [
        check.id, check.label, check.category, check.critical ? 1 : 0, result.status, result.detail, Date.now(),
        check.label, check.category, check.critical ? 1 : 0, result.status, result.detail, Date.now(),
      ],
    );
  } catch {
    // Persistence must never break the check run itself.
  }
}

/** Runs every registered check and persists the latest result per check_id. Each check is
 *  isolated — a query error becomes an 'error' status for that one check, not a thrown
 *  exception that skips the rest. */
export async function runDataQualityChecks(now: Date = new Date()): Promise<DataQualityResult[]> {
  await ensureTable();
  const results: DataQualityResult[] = [];
  for (const check of DATA_QUALITY_CHECKS) {
    let outcome: { status: DataQualityStatus; detail: string };
    try {
      const row = await dbGet<Record<string, any>>(check.sql, check.params ?? []);
      outcome = check.evaluate(row, now);
    } catch (err) {
      outcome = { status: 'error', detail: (err as Error).message.slice(0, 300) };
    }
    results.push({ id: check.id, label: check.label, category: check.category, critical: check.critical, ...outcome });
    await persistResult(check, outcome);
  }
  return results;
}

/** Reads the latest persisted result per check_id (written by the most recent
 *  runDataQualityChecks() call, at most 15 minutes stale — the watchdog poll interval)
 *  without re-running any query. Use this for reporting (e.g. the daily digest); use
 *  runDataQualityChecks() only where you need a fresh, synchronous evaluation. */
export async function getLatestDataQualityResults(): Promise<DataQualityResult[]> {
  await ensureTable();
  try {
    const rows = await dbAll<{ check_id: string; label: string; category: string; critical: number; status: DataQualityStatus; detail: string }>(
      'SELECT check_id, label, category, critical, status, detail FROM data_quality_results',
    );
    return rows.map(r => ({ id: r.check_id, label: r.label, category: r.category, critical: !!r.critical, status: r.status, detail: r.detail }));
  } catch {
    return [];
  }
}
