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
    | 'options' | 'flows' | 'outcomes' | 'reference' | 'macro'
    // 'meta' = checks ABOUT the check suite itself (new-failure transitions, unvarying
    // verdicts) rather than about a data table. Added 2026-08-15 with dq-new-failures.
    | 'meta'
    // 'infra' = platform survivability rather than data correctness (backups, disk, deploy
    // drift). Distinct from 'meta' because these are real operational facts, not statements
    // about the checks. Added 2026-08-19 with pg-backup-recency.
    | 'infra';
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
  // Found 2026-08-13 (fetcher-accuracy-review full-project sweep): intraday_ohlcv had ZERO
  // freshness coverage despite feeding the Intraday Edge tab and live_capitulation_screener.py
  // (the tier-1 'todayCapitulation' combo above) -- a dead intraday_fetcher.py would be
  // invisible to every monitor. datetime is TIMESTAMPTZ in Postgres (confirmed via
  // information_schema.columns, not assumed from db.ts's SQLite schema-of-record --
  // recurring-bugs.md's "column type assumed from db.ts" trap). Matched to
  // live-screener-runs-freshness's 1/2-day thresholds: same market-hours-gated cadence.
  { id: 'intraday-ohlcv-freshness', label: 'intraday_ohlcv (15m bars, feeds Intraday Edge + todayCapitulation)',
    category: 'ohlcv', critical: true, table: 'intraday_ohlcv', dateColumn: 'datetime',
    nativeDateColumn: true, warnDays: 1, failDays: 2 },

  // options
  { id: 'so-option-chain-freshness', label: 'so_option_chain (Trendlyne live options chain)',
    category: 'options', critical: false, table: 'so_option_chain', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'index-option-oi-freshness', label: 'index_option_oi (MC index OI/max-pain)',
    category: 'options', critical: false, table: 'index_option_oi', dateColumn: 'date', warnDays: 1, failDays: 3 },
  { id: 'nt-index-pcr-ts-freshness', label: 'nt_index_pcr_ts (NiftyTrader PCR/VIX)',
    category: 'options', critical: false, table: 'nt_index_pcr_ts', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'stock-option-features-freshness', label: 'stock_option_features (per-stock option chain features)',
    category: 'options', critical: false, table: 'stock_option_features', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // 2026-08-07 urls.txt follow-up (docs/url_explorer) -- see ndtv_fno_basis_fetcher.py.
  { id: 'ndtv-fno-basis-freshness', label: 'ndtv_fno_basis (NDTV futures basis/roll-spread cross-check)',
    category: 'options', critical: false, table: 'ndtv_fno_basis', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // Found 2026-08-13 (fetcher-accuracy-review full-project sweep, batch 2). All five below run
  // daily inside the same ml-daily-ops/queues.ts chain as the checked entries above, so matched
  // to the same 3/5-day daily thresholds rather than re-deriving one per fetcher.
  { id: 'fno-rollover-freshness', label: 'fno_rollover (near/next-expiry OI rollover %)',
    category: 'options', critical: false, table: 'fno_rollover', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // Written by BOTH mc_index_oi_fetcher.py and nt_oi_snapshot_fetcher.py -- one check per
  // table, not one per writer, matching this file's own stated convention (see the comment
  // above TABLE_FRESHNESS_CHECKS).
  { id: 'index-max-pain-freshness', label: 'index_max_pain (MC + NiftyTrader index max-pain/PCR)',
    category: 'options', critical: false, table: 'index_max_pain', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'nt-index-oi-eod-freshness', label: 'nt_index_oi_eod (NiftyTrader EOD strike-wise index OI)',
    category: 'options', critical: false, table: 'nt_index_oi_eod', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'nt-index-change-oi-freshness', label: 'nt_index_change_oi (NiftyTrader index OI buildup/unwinding)',
    category: 'options', critical: false, table: 'nt_index_change_oi', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'so-stock-oi-summary-freshness', label: 'so_stock_oi_summary (Trendlyne per-stock max-pain/MWPL/PCR)',
    category: 'options', critical: false, table: 'so_stock_oi_summary', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // Per-stock FUTURES OI/positioning (mc_stock_futures_oi_fetcher.py, added 2026-08-21). Distinct
  // from so_stock_oi_summary above, which is Trendlyne OPTIONS data and whose fut_oi column has
  // been 100% NULL for its entire life -- this table is what actually captures long/short buildup,
  // rollover and basis, the family measurement.md had recorded as "needs a new data source".
  // Trading-day aware (default): stock futures only trade on NSE sessions.
  { id: 'stock-futures-oi-freshness', label: 'stock_futures_oi_history (MC per-stock futures OI/buildup/rollover)',
    category: 'options', critical: false, table: 'stock_futures_oi_history', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // engine_composite.py's equal-weight blend of the 6 raw engines. Research-only (measured
  // "no edge" -- real IC, AUC short of 0.55), but it must keep accumulating or it can never be
  // re-graded, and a silently-dead producer would look identical to one that is simply flat.
  { id: 'engine-composite-freshness', label: 'engine_composite_scores (equal-weight raw-engine composite, research)',
    category: 'ml', critical: false, table: 'engine_composite_scores', dateColumn: 'date', warnDays: 3, failDays: 5 },

  // flows
  // Watches insider_trades (Tickertape), NOT insider_transactions (NSE corporates-pit).
  // insider_transactions is superseded and NO consumer reads it: factor_backtest.py's
  // insider_net factor and insider_features.py both read insider_trades.date_iso. Its NSE
  // source is also broken upstream -- live-probed 2026-08-17, corporates-pit ignores its own
  // from/to params entirely (four different windows, including "2024 only", return byte-identical
  // rows) and serves a stale most-recent-20 page per symbol, so the table has been frozen at
  // 2026-05-02 while this check warned every run for 114 runs. That is a monitor guarding an
  // abandoned table, which reads as a real gap forever. date_iso, NOT date: insider_trades.date
  // is TEXT holding the vendor's display format ('31 Oct, 2025') -- see insider_features.py:40.
  { id: 'insider-transactions-recency', label: 'insider_trades (Tickertape insider filings)',
    category: 'flows', critical: false, table: 'insider_trades', dateColumn: 'date_iso', warnDays: 14 },
  { id: 'bulk-block-deals-recency', label: 'bulk_block_deals (delivery-trend NSE bulk/block feed)',
    category: 'flows', critical: false, table: 'bulk_block_deals', dateColumn: 'deal_date', warnDays: 14 },
  // Tightened from 3/5 to 1/3 on 2026-08-25: this table froze at 2026-08-21 through three
  // consecutive "successful" runs (mc_index_oi-style backdated upserts on the TS side are
  // impossible here, but a fetcher can still exit 0 without advancing THIS table -- NSE
  // publishes the MTO file late and deliveryFetcher.ts returns an empty map silently when
  // it isn't there yet) while the generic 3/5-day threshold stayed green the whole time.
  // One trading day of silence IS the defect signature for a table that lands daily.
  { id: 'stock-delivery-volume-freshness', label: 'stock_delivery_volume (MTO delivery %)',
    category: 'flows', critical: false, table: 'stock_delivery_volume', dateColumn: 'date',
    emptyDetail: 'stock_delivery_volume is empty — NSE MTO fetch has never written a row',
    warnDays: 1, failDays: 3 },
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
  // 2026-08-15 registry-archive-only backlog closure -- see stockedge_high_delivery_fetcher.py.
  // A daily top-5 alert list, not sparse-by-nature, so the same tight thresholds as its
  // sibling ranked-deal feed above.
  { id: 'stockedge-high-delivery-alerts-recency', label: 'stockedge_high_delivery_alerts (StockEdge top-5 delivery-spike alerts)',
    category: 'flows', critical: false, table: 'stockedge_high_delivery_alerts', dateColumn: 'alert_date', warnDays: 5, failDays: 10 },
  // 2026-08-15 registry-archive-only backlog closure -- see trading80_call_alerts_fetcher.py.
  // No native date column (fetched_at is the only timestamp on this vendor-calls table), so
  // nativeDateColumn stays false (the default) and tradingDayAware handles the weekend gap.
  { id: 'trading80-call-alerts-recency', label: 'trading80_call_alerts (Trading80 vendor buy/sell calls)',
    category: 'flows', critical: false, table: 'trading80_call_alerts', dateColumn: 'fetched_at', warnDays: 5, failDays: 10 },
  // 2026-08-15 registry-archive-only backlog closure -- see marketsmojo_stock_picks_fetcher.py.
  // Sparse by nature (2-3 total picks on a normal day, not one per stock per day), so no
  // failDays -- matches insider-trades-recency's existing warn-only style for thin feeds.
  { id: 'marketsmojo-stock-picks-recency', label: 'marketsmojo_stock_picks (MarketsMojo vendor model-portfolio picks)',
    category: 'flows', critical: false, table: 'marketsmojo_stock_picks', dateColumn: 'fetched_at', warnDays: 10 },
  // 2026-08-15 -- see trendlyne_market_insight_fetcher.py. event_time is corporate-event
  // driven (order wins, results, deals), not a fixed daily cadence, so a short warn window.
  { id: 'trendlyne-market-insights-recency', label: 'trendlyne_market_insights (pre-classified corporate-event feed)',
    category: 'flows', critical: false, table: 'trendlyne_market_insights', dateColumn: 'event_time', warnDays: 3, failDays: 7 },
  // Found 2026-08-13 (fetcher-accuracy-review sweep, batch 2).
  { id: 'stock-block-deal-daily-recency', label: 'stock_block_deal_daily (per-symbol daily block-deal roll-up)',
    category: 'flows', critical: false, table: 'stock_block_deal_daily', dateColumn: 'date', warnDays: 14 },
  { id: 'superstar-investor-activity-recency', label: 'superstar_investor_activity (InvestSights notable-investor stake changes)',
    category: 'flows', critical: false, table: 'superstar_investor_activity', dateColumn: 'fetched_at', warnDays: 14 },
  // Found 2026-08-13 while wiring this check up: the table didn't exist in production at all --
  // mf_holdings_fetcher.py's sole endpoint (mfapps.indiatimes.com's MFPortfolioHolding.cms) was
  // dead (clean nginx 404 for every symbol, upstream retired, confirmed with the fetcher's own
  // real headers). Fixed same day: repointed at ET's shareholding-pattern endpoint
  // (marketservices.indiatimes.com/marketservices/shareholding?companyid=), keyed by the
  // standard ET companyid -- also fixed a hard LIMIT 200 in the old bse/nse-code ID resolution.
  // Live-verified against RELIANCE/HDFCBANK/BEL/360ONE/3MINDIA before landing.
  { id: 'stock-mf-holdings-recency', label: 'stock_mf_holdings (per-stock MF ownership %, quarterly disclosure)',
    category: 'flows', critical: false, table: 'stock_mf_holdings', dateColumn: 'date', warnDays: 10, failDays: 16 },

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
  // Found 2026-08-13 (fetcher-accuracy-review sweep): stock_earnings_dates had ZERO freshness
  // coverage -- the exact table behind the days_to_next_results anchor bug fixed earlier this
  // session (84.6% of symbol-days wrong for a full day whenever the nightly chain crossed
  // midnight IST). mc_earnings_fetcher.py runs daily inside ml-daily-ops, so daily thresholds
  // match its sibling fetchers in this section rather than stock-earnings-beats-recency's
  // sparse-style 10-day warn-only.
  { id: 'stock-earnings-dates-freshness', label: 'stock_earnings_dates (feeds days_to_next_results)',
    category: 'fundamentals', critical: false, table: 'stock_earnings_dates', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
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
  // onboard-data-source batch, 2026-08-13 -- 4 new InvestSights per-stock/screener endpoints.
  // See investsights_fundamentals_fetcher.py / investsights_factor_scores_fetcher.py /
  // investsights_announcement_intel_fetcher.py docstrings for the endpoints + quirks.
  { id: 'investsights-fundamentals-freshness', label: 'investsights_fundamentals_history (TTM + FMP ratios + growth + DCF)',
    category: 'fundamentals', critical: false, table: 'investsights_fundamentals_history', dateColumn: 'fetched_date', warnDays: 3, failDays: 5 },
  { id: 'investsights-factor-scores-freshness', label: 'investsights_factor_scores (cross-sectional PE/ROE/ROCE/growth screener snapshot)',
    category: 'fundamentals', critical: false, table: 'investsights_factor_scores', dateColumn: 'fetched_date', warnDays: 3, failDays: 5 },
  { id: 'investsights-announcement-intel-freshness', label: 'investsights_announcement_intel (per-stock filings/announcements/concall/rating docs)',
    category: 'fundamentals', critical: false, table: 'investsights_announcement_intel', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  // investsights_pe_band_history: initially built against the wrong base path
  // (/fundamentals/{symbol}/pe-band, which 404s), corrected 2026-08-14 to the real
  // /market/pe-band/{symbol}?days=N -- confirmed live, so this gets the same failDays
  // treatment as its investsights siblings above, not a warn-only "sparse by nature" one.
  { id: 'investsights-pe-band-freshness', label: 'investsights_pe_band_history (rolling PE-band chart)',
    category: 'fundamentals', critical: false, table: 'investsights_pe_band_history', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // Found 2026-08-13 (fetcher-accuracy-review sweep, batch 2): 3 more mc_earnings_fetcher.py
  // tables (siblings of stock-earnings-dates-freshness above, same daily fetcher/schedule).
  { id: 'mc-earnings-rapid-freshness', label: 'mc_earnings_rapid (MC results-calendar rapid categories)',
    category: 'fundamentals', critical: false, table: 'mc_earnings_rapid', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'mc-price-shockers-freshness', label: 'mc_price_shockers (post-results price reaction)',
    category: 'fundamentals', critical: false, table: 'mc_price_shockers', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'mc-sector-earnings-freshness', label: 'mc_sector_earnings (sector-level results aggregation)',
    category: 'fundamentals', critical: false, table: 'mc_sector_earnings', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  // mc_pricefeed_fetcher.py is the SOLE writer (confirmed live 2026-08-13: trendlyne_
  // fundamentals_fetcher.py only ever SELECTs from these two tables to compute percentile-rank
  // features -- see its own comment above ensure_schema, "PE/PB dropped: MC's daily fetch
  // already covers them" -- no dual-writer collision despite the table name). Feeds
  // factor_backtest.py's value_book_to_price factor (measurement.md) directly, so a silent
  // gap here would degrade an already-measured result without anyone noticing.
  { id: 'trendlyne-pe-history-freshness', label: 'trendlyne_pe_history (daily PE, feeds value_book_to_price factor)',
    category: 'fundamentals', critical: false, table: 'trendlyne_pe_history', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'trendlyne-pb-history-freshness', label: 'trendlyne_pb_history (daily PB, feeds value_book_to_price factor)',
    category: 'fundamentals', critical: false, table: 'trendlyne_pb_history', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  // moneycontrol_fetcher.py runs daily (queues.ts) -- daily thresholds, matching its sibling
  // mc_* tables throughout this section, not the weekly Trendlyne-family pattern below.
  { id: 'mc-analyst-ratings-freshness', label: 'mc_analyst_ratings (MC consensus buy/hold/sell counts)',
    category: 'fundamentals', critical: false, table: 'mc_analyst_ratings', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'mc-earnings-forecast-freshness', label: 'mc_earnings_forecast (MC forward estimates)',
    category: 'fundamentals', critical: false, table: 'mc_earnings_forecast', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // 2026-08-13: 3 more moneycontrol_fetcher.py siblings, same daily crawl -- gained fetched_at
  // this session (migration 1786990000000) after fetcher-accuracy-review found they had no
  // timestamp column at all.
  { id: 'mc-estimates-hits-misses-freshness', label: 'mc_estimates_hits_misses (actual vs analyst-estimate surprise)',
    category: 'fundamentals', critical: false, table: 'mc_estimates_hits_misses', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'mc-stock-vitals-freshness', label: 'mc_stock_vitals (MC per-stock vitals scorecard)',
    category: 'fundamentals', critical: false, table: 'mc_stock_vitals', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'mc-stock-scans-freshness', label: 'mc_stock_scans (MC technical/fundamental scan membership)',
    category: 'fundamentals', critical: false, table: 'mc_stock_scans', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  // mc_seasonality_best_stocks is market-wide (--seasonality flag), run weekly inside
  // trendlyneWeekly.jobs.ts, not the daily crawl above -- matched to that job's cadence.
  { id: 'mc-seasonality-best-stocks-freshness', label: 'mc_seasonality_best_stocks (monthly seasonality patterns)',
    category: 'fundamentals', critical: false, table: 'mc_seasonality_best_stocks', dateColumn: 'fetched_at', warnDays: 10, failDays: 16 },
  // trendlyne_adv_tech_fetcher.py / trendlyne_fundamentals_fetcher.py both run weekly inside
  // trendlyneWeekly.jobs.ts -- matched to tl-financial-quality-freshness's own 10/16-day
  // thresholds right above, the existing pattern for this exact job's cadence.
  { id: 'trendlyne-adv-tech-daily-freshness', label: 'trendlyne_adv_tech_daily (Trendlyne MA/oscillator/RSI/MACD bull-bear counts)',
    category: 'fundamentals', critical: false, table: 'trendlyne_adv_tech_daily', dateColumn: 'date', warnDays: 10, failDays: 16 },
  { id: 'trendlyne-eps-history-freshness', label: 'trendlyne_eps_history',
    category: 'fundamentals', critical: false, table: 'trendlyne_eps_history', dateColumn: 'fetched_at', warnDays: 10, failDays: 16 },
  { id: 'trendlyne-div-yield-history-freshness', label: 'trendlyne_div_yield_history',
    category: 'fundamentals', critical: false, table: 'trendlyne_div_yield_history', dateColumn: 'fetched_at', warnDays: 10, failDays: 16 },
  // trendlyne_overview_fetcher.py runs via companyProfileSyncService.ts's slow incremental
  // per-stock drip (near-static company profile data, not a daily full-crawl -- see that
  // file's own comment), so warnDays is looser than the weekly Trendlyne pattern above,
  // matching mf-stock-holdings-recency's "genuinely slow-moving data" reasoning instead.
  { id: 'trendlyne-analyst-targets-freshness', label: 'trendlyne_analyst_targets (broker target price/rating history)',
    category: 'fundamentals', critical: false, table: 'trendlyne_analyst_targets', dateColumn: 'fetched_at', warnDays: 30 },
  { id: 'trendlyne-stock-profile-freshness', label: 'trendlyne_stock_profile (company description/margins/annual financials)',
    category: 'fundamentals', critical: false, table: 'trendlyne_stock_profile', dateColumn: 'date', warnDays: 30 },
  { id: 'trendlyne-price-analysis-freshness', label: 'trendlyne_price_analysis (return/alpha vs Nifty+industry, multi-horizon)',
    category: 'fundamentals', critical: false, table: 'trendlyne_price_analysis', dateColumn: 'date', warnDays: 10, failDays: 16 },

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
  // Found 2026-08-13 (fetcher-accuracy-review sweep, batch 2): same investsights_sector_intel_
  // fetcher.py run, same table family as sector_correlation_summary right above.
  { id: 'sector-correlation-pairs-freshness', label: 'sector_correlation_pairs (InvestSights pairwise sector correlation)',
    category: 'macro', critical: false, table: 'sector_correlation_pairs', dateColumn: 'data_date', warnDays: 3, failDays: 5 },
  { id: 'sector-correlation-stats-freshness', label: 'sector_correlation_stats (InvestSights per-sector return/vol stats)',
    category: 'macro', critical: false, table: 'sector_correlation_stats', dateColumn: 'data_date', warnDays: 3, failDays: 5 },
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
  // Found 2026-08-13 (fetcher-accuracy-review sweep): screener_master/screener_catalog -- the
  // EXACT tables corrupted by the 2026-07-23 Trendlyne-id incident (2.1M rows, 7 tables) --
  // had ZERO freshness coverage, still, a full audit cycle later. screener_catalog has no
  // timestamp column of its own at all (checked information_schema.columns; not assumed), so
  // it can't be targeted directly. screener_master.last_updated looked usable but was excluded
  // from trendlyne_screener_discovery.py's ON CONFLICT DO UPDATE SET -- frozen at first-insert
  // forever, would have reported "stale since first backfill" regardless of whether the daily
  // sync ran. Fixed in the same commit (see upsert_screener's own comment) before wiring this
  // check up against it, or the check would have been evidence-shaped, not evidence.
  { id: 'screener-catalog-freshness', label: 'screener_master (proxies screener_catalog, same writer/run, no timestamp of its own)',
    category: 'signals', critical: true, table: 'screener_master', dateColumn: 'last_updated',
    nativeDateColumn: true, warnDays: 3, failDays: 5 },
  // screener_catalog gained its own fetched_at 2026-08-13 (migration 1786990000000) -- checked
  // directly now instead of relying solely on the screener_master proxy above, since the two
  // tables can genuinely diverge (see fix_screener_catalog_source_casing.py's concurrent
  // investigation into screener_id/source identity mismatches between them).
  { id: 'screener-catalog-own-freshness', label: 'screener_catalog (direct, not proxied)',
    category: 'signals', critical: false, table: 'screener_catalog', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  { id: 'stock-event-triggers-freshness', label: 'stock_event_triggers (screener exit/tenure + news attention)',
    category: 'signals', critical: false, table: 'stock_event_triggers', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'screener-sector-rotation-freshness', label: 'screener_sector_rotation',
    category: 'signals', critical: false, table: 'screener_sector_rotation', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // Found 2026-08-13 (data-coverage-audit): screener_features_fetcher.py's own output table.
  // Also has no live_datasource test (test_screener_features_fetcher.py exists but only
  // covers the date-anchor regression, never calls the real API) -- flagged separately, not
  // fixed here (a test needs a real API call this session hasn't verified against).
  { id: 'screener-membership-snapshot-freshness', label: 'screener_membership_snapshot (point-in-time screener membership, currently unconsumed)',
    category: 'signals', critical: false, table: 'screener_membership_snapshot', dateColumn: 'as_of_date', warnDays: 3, failDays: 5 },
  { id: 'intraday-recommendations-freshness', label: 'intraday_recommendations',
    category: 'signals', critical: false, table: 'intraday_recommendations', dateColumn: 'computed_at', warnDays: 3, failDays: 5 },
  // Found 2026-08-13: live_screener_appearances/live_screener_runs (42 NiftyTrader filters +
  // the new local 'todayCapitulation' combo, both written by processLiveScreenerCollect every
  // 15 min during market hours) had ZERO freshness coverage -- the exact "found empty by this
  // very audit" failure mode this file's own mandate exists to catch, just never actioned for
  // this table. Checks live_screener_runs.timestamp, NOT live_screener_appearances -- the runs
  // table gets a row every cycle regardless of whether any filter matched (a quiet market with
  // genuinely 0 matches must not read as "stale", same reasoning as the promotion-gated/
  // output-table class of false-stale documented in recurring-bugs.md). tradingDayAware stays
  // default (true): unlike confluence_signals this job has no extra intra-day skip window
  // beyond isMarketOpen() itself, so tradingDaysStale()'s plain weekend-discount is sufficient
  // and a Monday-morning check against Friday's last run should not need a special-cased
  // fraction-of-a-day threshold the way that one did.
  { id: 'live-screener-runs-freshness', label: 'live_screener_runs (NiftyTrader filters + todayCapitulation combo)',
    category: 'signals', critical: true, table: 'live_screener_runs', dateColumn: 'timestamp', warnDays: 1, failDays: 2 },
  // 2026-08-11: marketsmojo_technical_fetcher.py -- MarketsMojo's getCardInfo returns a full
  // ~3-year dated series (not just the current value) for weekly/monthly MACD/RSI/BB/KST/MA/
  // Dow/OBV + IndiGraph score, confirmed live and backfilled. dateColumn is the indicator's own
  // `date`, not fetched_at, so this reads whether the series is actually being kept current --
  // same cadence expectation as OHLCV since these are computed off daily bars.
  { id: 'marketsmojo-technical-history-freshness', label: 'marketsmojo_technical_history (MACD/RSI/BB/KST/MA/Dow/OBV/IndiGraph series)',
    category: 'signals', critical: false, table: 'marketsmojo_technical_history', dateColumn: 'date', warnDays: 3, failDays: 5 },

  // Added 2026-08-15: trendlyneDailyFetchService.ts's runTrendlyneMetricsFetch() persists here
  // now (was pure cache-warming before -- see that file's own comment for why). Same daily
  // top-500-by-market-cap cadence as marketsmojo_technical_history above; not currently
  // consumed by scoring (deliberate, see METRIC_COLUMNS' comment) so this is warn-only.
  { id: 'trendlyne-stock-metrics-history-freshness', label: 'trendlyne_stock_metrics_history (PEG/PBV/institutional-holding/growth params, unconsumed)',
    category: 'reference', critical: false, table: 'trendlyne_stock_metrics_history', dateColumn: 'date', warnDays: 3 },

  // reference
  // Found 2026-08-13 (fetcher-accuracy-review sweep): asm_gsm_fetcher.py and
  // index_membership_fetcher.py both UPDATE nse_stocks in place (surveillance flags /
  // Nifty50-200-Midcap150-Smallcap250 membership) rather than writing a dedicated dated table,
  // so neither had ever gotten a freshness check -- the standard factory still applies since
  // both fetchers stamp their own *_updated_at column on every write. asm_gsm_fetcher.py runs
  // daily (queues.ts, ml-daily-ops), so 5/10 is already loose relative to its cadence -- a few
  // days' staleness on surveillance flags is a real-world non-event (ASM/GSM entries are rare).
  { id: 'nse-stocks-surveillance-freshness', label: 'nse_stocks.is_asm/gsm_stage (ASM/GSM surveillance flags)',
    category: 'reference', critical: false, table: 'nse_stocks', dateColumn: 'surveillance_updated_at', warnDays: 5, failDays: 10 },
  // index_membership_fetcher.py's own docstring says "Run weekly" and it is wired only into
  // nse-sync-weekly (jobs/sync.jobs.ts, cron '0 2 * * 0' -- Sunday), NOT the daily chain the
  // comment above used to claim it shared with asm-gsm. At 5/10-day thresholds this false-warned
  // every Thu/Fri/Sat of every week (5+ days since the last Sunday run, every week, by
  // construction) -- caught 2026-08-14 from a real daily digest warning at 5.1d. Recalibrated to
  // this file's own established weekly-cadence pair (10/16, see historical-fundamentals-freshness
  // and tl-financial-quality-freshness) instead of the daily 5/10 default.
  { id: 'nse-stocks-index-flags-freshness', label: 'nse_stocks index membership flags (Nifty50/100/200/Midcap150/Smallcap250)',
    category: 'reference', critical: false, table: 'nse_stocks', dateColumn: 'index_flags_updated_at', warnDays: 10, failDays: 16 },
  { id: 'mc-broker-reco-freshness', label: 'mc_broker_reco',
    category: 'reference', critical: false, table: 'mc_broker_reco', dateColumn: 'fetched_at', warnDays: 5, failDays: 10 },
  // Found 2026-08-13 (data-coverage-audit): moneycontrol_fetcher.py writes this (analyst
  // high/mean/low price targets) but no consumer reads it anywhere in the codebase --
  // low-priority per this file's own "orphaned table nothing reads" prioritisation, but the
  // freshness-check mandate is unconditional per live datasource, orphaned or not.
  { id: 'mc-price-forecast-freshness', label: 'mc_price_forecast (analyst target high/mean/low -- currently unconsumed)',
    category: 'reference', critical: false, table: 'mc_price_forecast', dateColumn: 'fetched_at', warnDays: 5, failDays: 10 },
  { id: 'mc-chart-patterns-freshness', label: 'mc_chart_patterns',
    category: 'reference', critical: false, table: 'mc_chart_patterns', dateColumn: 'fetched_at', warnDays: 3, failDays: 5 },
  // Found 2026-08-13 (fetcher-accuracy-review sweep, batch 2): mc_chart_patterns_fetcher.py's
  // sibling table, same fetcher/schedule as the entry right above.
  { id: 'mc-pattern-signals-freshness', label: 'mc_pattern_signals (per-stock bull/bear pattern-signal counts)',
    category: 'reference', critical: false, table: 'mc_pattern_signals', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'market-breadth-freshness', label: 'market_breadth (advance/decline)',
    category: 'reference', critical: false, table: 'market_breadth', dateColumn: 'date', warnDays: 3, failDays: 5 },
  // mc_advance_decline_fetcher.py's own dedicated table (market_breadth above is its second,
  // shared write target) -- same fetcher/schedule.
  { id: 'mc-advance-decline-freshness', label: 'mc_advance_decline (MC NSE advance/decline ratio)',
    category: 'reference', critical: false, table: 'mc_advance_decline', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'preopen-snapshot-freshness', label: 'preopen_snapshot',
    category: 'reference', critical: false, table: 'preopen_snapshot', dateColumn: 'snapshot_date', warnDays: 3, failDays: 5 },
  // preopen_fetcher.py's per-stock sibling table to preopen_snapshot right above.
  { id: 'preopen-stock-snapshot-freshness', label: 'preopen_stock_snapshot (per-stock pre-open IEP/imbalance)',
    category: 'reference', critical: false, table: 'preopen_stock_snapshot', dateColumn: 'snapshot_date', warnDays: 3, failDays: 5 },
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
  // Found 2026-08-13 (data-coverage-audit, TS-side sweep): news_articles/market_sentiment_
  // snapshots are written by the SAME news-sentiment job as news_sentiment_items right above
  // but had no checks of their own -- calibrated identically (same job, same cadence).
  { id: 'news-articles-freshness', label: 'news_articles (BSE event classifier input)',
    category: 'reference', critical: false, table: 'news_articles', dateColumn: 'timestamp',
    nativeDateColumn: true, tradingDayAware: false, warnDays: 1, failDays: 3 },
  { id: 'market-sentiment-snapshots-freshness', label: 'market_sentiment_snapshots',
    category: 'reference', critical: false, table: 'market_sentiment_snapshots', dateColumn: 'snapshot_at',
    nativeDateColumn: true, tradingDayAware: false, warnDays: 1, failDays: 3 },
  // fundamentalsSyncService.ts's runFullFundamentalsSync() runs weekly ('fundamentals-sync-
  // weekly' cron) -- calibrated like tl_financial_quality above (10/16 days), not the 3/5-day
  // daily-cadence default, or this would false-warn every week between syncs.
  { id: 'historical-fundamentals-freshness', label: 'historical_fundamentals (dated fundamentals time series)',
    category: 'fundamentals', critical: false, table: 'historical_fundamentals', dateColumn: 'date', warnDays: 10, failDays: 16 },
  // gdelt_sentiment: found EMPTY (0 rows) earlier this same audit -- gdeltService.ts's
  // runGdeltBackfill() existed but was never called from anywhere. Wired into queues.ts
  // (QUEUE_GDELT_SENTIMENT, daily 19:00 UTC) the same day, so this check is now meaningful
  // rather than permanently red. tradingDayAware:false (GDELT indexes news on weekends too);
  // warnDays/failDays generous relative to the 24h cadence to absorb one GDELT rate-limit
  // throttle/retry without false-alarming the next morning.
  { id: 'gdelt-sentiment-freshness', label: 'gdelt_sentiment (per-company news tone, GDELT DOC API)',
    category: 'reference', critical: false, table: 'gdelt_sentiment', dateColumn: 'computed_at',
    tradingDayAware: false, warnDays: 2, failDays: 4 },
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
    // win_probability is written by ml-ensemble-score (pythonApi.scorePending(), inside
    // ml-daily-ops), which runs once in the evening -- AFTER technical-scan has already
    // written that day's rows earlier (8:30am-4pm IST). This check runs on a 15-min cycle
    // all day (jobWatchdog.ts), so a naive `date >= date('now','-3 days')` window includes
    // TODAY's not-yet-scored rows in the denominator every single weekday between the
    // morning scan and the evening scoring run -- coverage reads ~50% (today unscored,
    // averaged against 1-2 already-scored prior days) with nothing actually broken. Same
    // "checking before the day's pipeline finished" shape as the tradingDaysStale fix just
    // below (2026-08-10, for the staleness half of this same check) -- that fix anchored
    // `stale` correctly but never touched this ratio's window. total/scored now come from
    // the most recently COMPLETED trading day (date < today), which has had a full day+
    // evening cycle to be scored; last_date stays unbounded so a genuine outage (today's
    // scan never running at all) still fails via the staleness branch below.
    sql: `SELECT
            (SELECT MAX(date) FROM technical_signals) AS last_date,
            (SELECT COUNT(*) FROM technical_signals
               -- ts.date is a native Postgres DATE since the 2026-08-25 migration; the other
               -- date columns here are TEXT and sqlTranslate renders date('now',...) as ::text,
               -- so cast THIS column side to match (stripped as a no-op on SQLite).
               WHERE date::text = (SELECT MAX(date)::text FROM technical_signals WHERE date::text < date('now'))) AS total,
            (SELECT COUNT(win_probability) FROM technical_signals
               WHERE date::text = (SELECT MAX(date)::text FROM technical_signals WHERE date::text < date('now'))) AS scored`,
    evaluate: (row, now) => {
      // technical-signals-daily only runs 8:30am-4pm IST on NSE trading days (queues.ts), so a
      // plain calendar-day gap false-fails every Monday morning purely from the Sat/Sun gap --
      // the exact class already fixed for ohlcv/fii-dii/market-regimes freshness on 2026-08-03,
      // just never migrated to this hand-rolled check. tradingDaysStale() subtracts the weekend.
      const stale = tradingDaysStale(row?.last_date, now);
      const total = Number(row?.total) || 0;
      const coverage = safeRatio(row?.scored, row?.total);
      if (stale == null || total === 0) return { status: 'fail', detail: 'No completed technical_signals trading day to measure coverage against' };
      if (stale > 3) return { status: 'fail', detail: `Latest scan is ${fmtDays(stale)} old` };
      // The exact regression class noted in CLAUDE.md: a filter bug silently collapsed
      // win_probability coverage to ~1-3% for weeks while the job kept exiting 0.
      if (coverage < 0.5) return { status: 'fail', detail: `win_probability coverage only ${(coverage * 100).toFixed(1)}% of ${total} rows (last completed trading day)` };
      if (coverage < 0.8) return { status: 'warn', detail: `win_probability coverage ${(coverage * 100).toFixed(1)}% of ${total} rows (last completed trading day)` };
      return { status: 'pass', detail: `${(coverage * 100).toFixed(1)}% coverage, ${total} rows, latest ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'technical-signals-range-bounds',
    label: 'technical_signals value-range invariants (RSI 0-100, win-prob 0-1)',
    category: 'signals',
    critical: true,
    // date is a native DATE (2026-08-25 migration); date('now','-3 days') translates to ::text,
    // so compare like-for-like with date::text (see sqlTranslate.ts's header).
    sql: `SELECT COUNT(*) AS bad FROM technical_signals
          WHERE date::text >= date('now','-3 days') AND (
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
          FROM technical_signals WHERE date::text >= date('now','-3 days')`,
    evaluate: (row) => {
      const total = Number(row?.total) || 0;
      const distinct = Number(row?.distinct_scores) || 0;
      if (total === 0) return { status: 'fail', detail: 'No rows in the last 3 days' };
      if (distinct <= 1) return { status: 'fail', detail: `signal_score is identical across all ${total} rows — looks stuck at a default` };
      return { status: 'pass', detail: `${distinct} distinct signal_score values across ${total} rows` };
    },
  },
  // ── Provenance invariants ─────────────────────────────────────────────
  // These three exist because the 2026-08-12 defects were invisible to every check above:
  // none was a NULL, a staleness gap, or a coverage collapse. A corrupted provenance column is
  // 100% populated and perfectly fresh — the only thing wrong with it is that it disagrees with
  // another column it can never legitimately disagree with. Assert the relationship, not the
  // presence.
  //
  // These use Postgres interval arithmetic deliberately. The live DB is Postgres; on a dev
  // SQLite fallback they surface as status:'error' (the runner catches and reports), which is
  // loud rather than a silent false pass.
  {
    id: 'signal-provenance-monotonic',
    label: 'unified_signals.signal_generated_at is never later than created_at',
    category: 'signals',
    critical: false,
    // A row cannot be generated after it was created. When signal_generated_at sat in all three
    // writers' ON CONFLICT DO UPDATE SET, every re-run walked it forward and 29,433 of 55,736
    // rows violated this — which silently made 82% of the platform's signals un-gradeable and
    // handed the accuracy review a confident wrong answer (measurement.md retracts it).
    // 5-minute tolerance: app-built timestamps vs the DB's own now() default differ by up to
    // 57s in practice, while the real defect drifted up to 24h. Sized to the defect, not to zero.
    sql: `SELECT SUM(CASE WHEN created_at < signal_generated_at - interval '5 minutes'
                          THEN 1 ELSE 0 END) AS bad,
                 COUNT(*) AS total
          FROM unified_signals
          WHERE created_at IS NOT NULL AND signal_generated_at IS NOT NULL`,
    evaluate: (row) => {
      const bad = Number(row?.bad) || 0;
      const total = Number(row?.total) || 0;
      if (total === 0) return { status: 'warn', detail: 'No unified_signals rows with both timestamps' };
      if (bad > 0) {
        return { status: 'fail', detail: `${bad} of ${total} rows have signal_generated_at LATER than created_at — a writer is refreshing the provenance stamp on re-run (see recurring-bugs.md)` };
      }
      return { status: 'pass', detail: `All ${total} rows have a generation stamp at or before creation` };
    },
  },
  {
    id: 'unified-signals-confidence-scale',
    label: 'unified_signals.confidence_score stays on one (0-100) scale',
    category: 'signals',
    critical: false,
    // Four of the five writers emitted a 0-1 fraction into a column db.ts documents as
    // "0-100, from any source" (measured 2026-08-16: technical_scan 0.10-1.00,
    // SCREENER_SURFACING 0.65-0.74, screener 0.80-1.00, platform 0.80 — against AI's 0-98).
    // Nothing errored, and no NOT NULL/type/drift check can see it: every value is a valid
    // REAL. It only surfaced as downstream nonsense — a threshold filter that was a no-op for
    // half the table, and outcome_resolver.py's round(confidence_score) collapsing 1,411 rows
    // to 0/1. Writers fixed + 8,448 rows backfilled by migration 1787070000000; this is what
    // catches the next writer that regresses.
    //
    // Threshold is a SHARE, not a bare count (recurring-bugs.md: "a check that fires on a bare
    // count > 0 will fail on correct data"). A genuine 0-100 score below 1.0 is legitimate —
    // AI's own minimum is 0.000 — so a handful of sub-1 rows is not evidence of anything. A
    // whole writer back on the wrong scale shows up as a large share, not a few rows.
    sql: `SELECT COUNT(*) AS scored,
                 COUNT(*) FILTER (WHERE confidence_score > 0 AND confidence_score <= 1) AS suspect,
                 COUNT(*) FILTER (WHERE confidence_score > 100 OR confidence_score < 0) AS out_of_range
            FROM unified_signals
           WHERE confidence_score IS NOT NULL
             AND signal_date >= CURRENT_DATE - 30`,
    evaluate: (row) => {
      const scored = Number(row?.scored) || 0;
      const suspect = Number(row?.suspect) || 0;
      const outOfRange = Number(row?.out_of_range) || 0;
      if (scored === 0) return { status: 'pass', detail: 'No scored unified_signals rows in the last 30 days' };
      if (outOfRange > 0) {
        return { status: 'fail', detail: `${outOfRange} row(s) outside 0-100 — a writer is emitting a scale this column does not use` };
      }
      const pct = (suspect / scored) * 100;
      if (pct >= 5) {
        return { status: 'fail', detail: `${suspect}/${scored} (${pct.toFixed(1)}%) of scored rows sit in (0, 1] — a writer has regressed to the 0-1 fraction scale (see migration 1787070000000)` };
      }
      return { status: 'pass', detail: `${scored} scored rows, all within 0-100 (${suspect} in (0,1], ${pct.toFixed(1)}%)` };
    },
  },
  {
    id: 'signal-source-case-collision',
    label: 'No two signal_source values differ only by case',
    category: 'signals',
    critical: false,
    // 'technical' vs 'TECHNICAL' were two different producers for months. Any consumer filtering
    // one silently dropped the other, and reward_engine.py's exclusion list fell straight
    // through the gap. Renamed to 'technical_scan' 2026-08-12 (migration 1786930000000).
    //
    // ALL FIVE tables carrying a signal_source column. The first version of this check listed
    // only unified_signals and unified_signal_outcomes and therefore reported PASS while
    // signal_source_weights still held both spellings — the same hand-enumerated-allowlist
    // failure as screenerAppearedAt.test.ts in recurring-bugs.md. The companion
    // signal-source-table-coverage check below fails if a sixth table ever appears, so this
    // list cannot silently go stale again.
    sql: `SELECT COUNT(*) AS collisions FROM (
            SELECT LOWER(signal_source) AS lowered
            FROM (SELECT signal_source FROM unified_signals
                  UNION ALL SELECT signal_source FROM unified_signal_outcomes
                  UNION ALL SELECT signal_source FROM signal_outcomes
                  UNION ALL SELECT signal_source FROM signal_source_weights
                  UNION ALL SELECT signal_source FROM signal_actions) s
            WHERE signal_source IS NOT NULL
            GROUP BY LOWER(signal_source)
            HAVING COUNT(DISTINCT signal_source) > 1) x`,
    evaluate: (row) => {
      const collisions = Number(row?.collisions) || 0;
      if (collisions > 0) {
        return { status: 'fail', detail: `${collisions} signal_source value(s) exist in more than one casing — any consumer filtering on one spelling silently drops the other` };
      }
      return { status: 'pass', detail: 'All signal_source values are unique case-insensitively across all 5 tables' };
    },
  },
  {
    id: 'signal-source-table-coverage',
    label: 'signal-source-case-collision covers every table with a signal_source column',
    category: 'signals',
    critical: false,
    // Derives the table list from the schema instead of trusting the hand-written UNION above.
    // Without this, adding a sixth signal_source table leaves the collision check silently
    // partial — which is exactly how the first version of it passed while a real collision sat
    // in signal_source_weights.
    sql: `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'signal_source'`,
    evaluate: (row) => {
      const n = Number(row?.n) || 0;
      const covered = 5;
      if (n !== covered) {
        return { status: 'fail', detail: `${n} tables carry a signal_source column but signal-source-case-collision only UNIONs ${covered} — add the new table(s) to that check, then update this count` };
      }
      return { status: 'pass', detail: `All ${covered} signal_source tables are covered by the collision check` };
    },
  },
  {
    id: 'signal-outcomes-label-definition-consistent',
    label: 'Each signal_outcomes source uses exactly one label_definition',
    category: 'signals',
    critical: false,
    // terminal_pct2 (fixed ±2% terminal) and path_barrier (path-based MFE) are NOT comparable:
    // measured live, the same calendar window gave 88–91% vs 41–44% win rates purely from the
    // label convention. A source carrying both would make its own win rate meaningless, and
    // nothing else in this file would notice. NULLs are reported but do not fail on their own —
    // 1,610 legacy 'technical' rows predate the column, and a permanently-warning check stops
    // being read.
    sql: `SELECT COUNT(*) AS mixed_sources, COALESCE(SUM(nulls), 0) AS null_rows FROM (
            SELECT signal_source,
                   COUNT(DISTINCT label_definition) AS labels,
                   SUM(CASE WHEN label_definition IS NULL THEN 1 ELSE 0 END) AS nulls
            FROM signal_outcomes GROUP BY signal_source
            HAVING COUNT(DISTINCT label_definition) > 1) x`,
    evaluate: (row) => {
      const mixed = Number(row?.mixed_sources) || 0;
      if (mixed > 0) {
        return { status: 'fail', detail: `${mixed} signal_source(s) carry more than one label_definition — win rates across them are not comparable (see measurement.md)` };
      }
      return { status: 'pass', detail: 'Every signal_source uses a single label_definition' };
    },
  },

  {
    id: 'quant-scores-history-column-parity',
    label: 'quant_scores_history mirrors every quant_scores column',
    category: 'scoring',
    critical: false,
    // quant_scores has no date column, so quant_scores_history is the ONLY record of what a
    // symbol's momentum/quality/value/vol inputs were on any past date. A column added to
    // quant_scores and not to the history table is silently unrecorded forever — and you find
    // out weeks later, when the history you needed turns out to have a hole in exactly the
    // column you wanted. Derived from information_schema rather than a hand-written list, for
    // the same reason as signal-source-table-coverage.
    sql: `SELECT COUNT(*) AS missing FROM (
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'quant_scores'
            EXCEPT
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'quant_scores_history') x`,
    evaluate: (row) => {
      const missing = Number(row?.missing) || 0;
      if (missing > 0) {
        return { status: 'fail', detail: `${missing} quant_scores column(s) are not mirrored in quant_scores_history — they are being permanently lost every run (see migration 1786960000000)` };
      }
      return { status: 'pass', detail: 'quant_scores_history mirrors all quant_scores columns' };
    },
  },
  {
    id: 'quant-scores-history-freshness',
    label: 'quant_scores_history is accumulating snapshots',
    category: 'scoring',
    critical: false,
    // The snapshot runs at the end of processQuantScoring (17:30 UTC weekdays). If it silently
    // stops, quant_scores history quietly stops accumulating and nothing else notices — the
    // live quant_scores table stays perfectly fresh either way, which is precisely why the
    // absence is invisible without this check.
    sql: `SELECT MAX(snapshot_date) AS last_date, COUNT(DISTINCT snapshot_date) AS dates
          FROM quant_scores_history`,
    evaluate: (row, now) => {
      if (!row?.last_date) return { status: 'fail', detail: 'quant_scores_history is empty — the snapshot step is not running' };
      const stale = tradingDaysStale(row.last_date, now);
      const dates = Number(row.dates) || 0;
      if (stale != null && stale > 3) return { status: 'fail', detail: `Latest quant_scores snapshot is ${fmtDays(stale)} old (${dates} sessions recorded)` };
      return { status: 'pass', detail: `${dates} session(s) recorded, latest ${fmtDays(stale)} old` };
    },
  },
  // ml-promotion-gate-review, 2026-08-19: 'ensemble' was the only model_registry model_name with
  // a freshness check, despite cs_ranker/exit_policy/confluence_ml/online_sgd sharing the exact
  // same "a row is written on EVERY run, promoted or rejected" property the comment below
  // explains -- so a promotion gate correctly rejecting a bad retrain and one that has silently
  // stopped running for weeks were indistinguishable everywhere in this platform's monitoring for
  // 4 of 6 model_registry-backed engines. Confirmed live-relevant, not hypothetical: exit_policy's
  // --train step timed out 2026-08-17 with nothing surfacing it beyond a console.warn in raw pm2
  // logs. Factored into one function so the 5 entries share the exact same MAX(trained_at) logic
  // instead of 5 near-identical hand-rolled blocks.
  ...([
    { modelName: 'ensemble', label: 'Ensemble' },
    { modelName: 'cs_ranker', label: 'CS Ranker' },
    { modelName: 'exit_policy', label: 'Exit Policy' },
    { modelName: 'confluence_ml', label: 'Confluence ML' },
    { modelName: 'online_sgd', label: 'Online SGD' },
    // Added separately (2026-08-19, same sweep continued): dl_trainer.py's _record_model_registry
    // writes a model_registry row on every BiLSTM run too (promoted or not, dl_trainer.py's own
    // comment: "previously ... never deactivated the previous row either way -- every version
    // from v4 through v18 was left with is_active=1 forever"). It already has monitorScripts.ts's
    // 'dl-trainer' job-heartbeat, but that only proves the SCRIPT exited 0 -- not that the
    // model_registry WRITE inside it actually landed, the same distinction the other 5 entries
    // exist to make.
    { modelName: 'BiLSTM', label: 'BiLSTM' },
  ] as const).map(({ modelName, label }): DataQualityCheck => ({
    id: `model-registry-active-${modelName}`,
    label: `Active ${label} model exists and was retrained recently`,
    category: 'ml',
    critical: false,
    // Warning past 45 days since the ACTIVE row's own trained_at can misread a correctly-
    // rejected challenger as a problem -- a retrain can legitimately keep rejecting a
    // stale-but-still-best baseline for up to DEFAULT_STALENESS_MAX_REJECTIONS (10) runs before
    // the staleness override self-heals it, same shape as monitorScripts.ts's already-fixed
    // strategy-optimizer/screener_weight_history case ("a gated run is a successful run" -- see
    // monitor.router.ts's LATEST-of-{output probe, stored _ran_at, job_heartbeat} comment).
    // register_model()/_register_cs_model() etc. all write a model_registry row on EVERY run,
    // promoted or rejected -- so unlike strategy-optimizer this doesn't need job_heartbeat/
    // app_settings at all: MAX(trained_at) across every row (not just the active one) is already
    // proof the job ran, whether or not it promoted.
    sql: `SELECT
            (SELECT trained_at FROM model_registry WHERE model_name = ? AND is_active = 1
             ORDER BY id DESC LIMIT 1) AS active_trained_at,
            (SELECT cv_roc_auc FROM model_registry WHERE model_name = ? AND is_active = 1
             ORDER BY id DESC LIMIT 1) AS active_auc,
            (SELECT MAX(trained_at) FROM model_registry WHERE model_name = ?) AS last_run_at`,
    params: [modelName, modelName, modelName],
    evaluate: (row, now) => {
      if (!row || !row.active_trained_at) return { status: 'fail', detail: `No active ${label} model in model_registry` };
      const activeAge = daysStale(row.active_trained_at, now);
      const runAge = daysStale(row.last_run_at, now) ?? activeAge;
      if (runAge != null && runAge > 45) return { status: 'warn', detail: `${label} retrain hasn't RUN in ${fmtDays(runAge)} (active model itself is ${fmtDays(activeAge)} old, AUC/rho ${row.active_auc ?? 'n/a'})` };
      return { status: 'pass', detail: `${label} retrain last ran ${fmtDays(runAge)} ago; active model is ${fmtDays(activeAge)} old, AUC/rho ${row.active_auc ?? 'n/a'}` };
    },
  })),
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
    //
    // NOT a bare "no matching stock_ohlcv row" test (2026-08-13 false positive, found live):
    // logical_session_date() also rolls a run whose market OPEN has already passed forward to
    // the NEXT session (as_of.py, 2026-08-12) -- a legitimate evening/post-close re-run for
    // TODAY correctly gets stamped with TOMORROW's date, a real future weekday that simply has
    // no stock_ohlcv row yet because that session hasn't happened. A bare NOT EXISTS flagged
    // 2026-08-14 (a Friday) every night until that day's bar landed. Only a WEEKEND date is
    // knowable as bad in advance (never gets a bar); a non-weekend date only counts as bad once
    // it is safely in the past and still has no bar.
    sql: `SELECT COUNT(DISTINCT u.computed_at) AS bad_days
          FROM unified_recommendations u
          WHERE EXTRACT(ISODOW FROM u.computed_at::date) IN (6, 7)
             OR (u.computed_at::date < CURRENT_DATE AND NOT EXISTS (
                   SELECT 1 FROM stock_ohlcv s WHERE s.date = u.computed_at::date
                 ))`,
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
  {
    // Found 2026-08-14 (job-runtime-audit): confluence_outcome_tracker.py had silently failed
    // its 5-min budget every scheduled run for 11 consecutive days (2026-08-03 through 08-14) --
    // its own .catch() in confluence.jobs.ts only console.warns, so BullMQ kept reporting
    // 'completed', and NOTHING watched either of this job's two write targets
    // (screener_reliability, confluence-sourced signal_outcomes), so nothing else could have
    // caught it either. screener_reliability is checked here since it's this job's own
    // exclusive output table (no other writer) -- a clean, unambiguous "is this job still
    // running" signal, unlike signal_outcomes which has multiple signal_source writers sharing
    // one table and would need a source-scoped WHERE the generic factory doesn't support.
    id: 'screener-reliability-freshness',
    label: 'screener_reliability (confluence_outcome_tracker.py liveness)',
    category: 'outcomes',
    critical: true,
    sql: `SELECT MAX(last_updated) AS last_date FROM screener_reliability`,
    evaluate: (row, now) => {
      const stale = tradingDaysStale(row?.last_date, now);
      if (stale == null) return { status: 'fail', detail: 'screener_reliability is empty' };
      if (stale > 4) return { status: 'fail', detail: `Latest screener_reliability row is ${fmtDays(stale)} old -- confluence_outcome_tracker.py may be failing silently` };
      if (stale > 2) return { status: 'warn', detail: `Latest screener_reliability row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `Latest screener_reliability row ${fmtDays(stale)} old` };
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
      // ml_calibration.py only runs weekdays (ml-daily-ops, '20 13 * * 1-5' = 18:50 IST) —
      // tradingDaysStale, not daysStale, or a Monday-afternoon check reads Friday's snapshot as
      // stale purely from the Sat/Sun gap before today's own run has had its scheduled slot.
      // Found live 2026-08-17: this was the raw-daysStale form, reading 3.1d on a Monday for a
      // Friday snapshot that hadn't missed anything — recurring-bugs.md's "Raw daysStale() on a
      // freshness check" class, in a hand-rolled 'ML state' check the factory doesn't cover.
      const stale = tradingDaysStale(row?.latest_computed_at, now);
      if (stale != null && stale > 3) {
        return { status: 'warn', detail: `regime_edge_status hasn't refreshed in ${fmtDays(stale)} trading day(s) — ml_calibration.py's nightly snapshot may not be running.` };
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

  // The gap every other check in this file structurally cannot see.
  //
  // All ~90 checks above ask "did this TABLE get fresh rows?". None asks "did the FEATURE that
  // table exists to produce actually land on the grid?" -- and those are different questions.
  // Measured 2026-08-12: extra_endpoint_responses was receiving 21,461 fresh rows a night, so
  // its freshness check passed, while all 14 ext_* columns it feeds sat at 0% because the
  // parser was being SIGKILLed before it ever ran. The monitor read 86 pass / 1 fail while 21
  // of ml_ensemble.py's declared inputs were constants for every stock on every date.
  //
  // Deliberately generic (jsonb_each over the row, not a hand-written column list): an
  // enumerated allowlist only ever guards the columns someone remembered to list, which is the
  // failure in .claude/rules/recurring-bugs.md (Testing) that left appeared_at populated on 10
  // rows platform-wide behind a green suite. This counts every column the table actually has,
  // so a NEW feature column that never gets written is caught without anyone updating a list.
  //
  // Thresholds are a REGRESSION guard, not a target. 53 of 302 columns were 100% NULL on the
  // last completed day when this was written (2026-08-13) -- some genuinely broken, many just
  // sparse-by-nature on a single date (DVM is weekly, the mc_* block writes on its own cadence,
  // and densify_feature_matrix.py forward-fills both under an age cap). Failing on all 53 would
  // be the "check that cries wolf on correct data" anti-pattern, so this alarms on the count
  // GROWING instead. Ratchet the numbers down as the backlog is fixed; do not raise them to
  // silence a real regression.
  //
  // Anchored to MAX(date) < today, not today: today's grid is still being written when this
  // runs, and a same-day denominator reads as a false collapse -- the same bug already fixed
  // once in technical-signals-freshness-coverage.
  {
    id: 'dq-new-failures',
    label: 'no data-quality check has newly started failing since the previous run',
    category: 'meta',
    critical: true,
    // THE alerting fix (2026-08-15). The problem was never detection -- it was that a genuine
    // FAIL sat unread inside "145/148 passed, 0 critical failures", because absolute severity
    // cannot distinguish "this broke an hour ago" from "this has been red for three weeks".
    // Novelty is the signal: a pass->fail TRANSITION is urgent and actionable; a long-standing
    // red is a backlog item. This is critical:true precisely because it fires rarely and only
    // on something that just changed -- the opposite of the alert fatigue that buried the
    // original failure.
    sql: `WITH ranked AS (
            SELECT check_id, status, checked_at,
                   ROW_NUMBER() OVER (PARTITION BY check_id ORDER BY checked_at DESC) AS rn
              FROM data_quality_history
             WHERE checked_at > (EXTRACT(epoch FROM now()) - 86400 * 7) * 1000
          ), pairs AS (
            SELECT c.check_id,
                   MAX(CASE WHEN c.rn = 1 THEN c.status END) AS now_status,
                   MAX(CASE WHEN c.rn = 2 THEN c.status END) AS prev_status
              FROM ranked c WHERE c.rn <= 2 GROUP BY c.check_id
          )
          SELECT COUNT(*) FILTER (WHERE now_status IN ('fail','error') AND prev_status = 'pass') AS newly_failing,
                 COUNT(*) FILTER (WHERE now_status = 'warn' AND prev_status = 'pass') AS newly_warning,
                 COALESCE(string_agg(check_id, ', ') FILTER (WHERE now_status IN ('fail','error') AND prev_status = 'pass'), '') AS newly_failing_ids,
                 COUNT(*) AS checks_with_history
            FROM pairs`,
    evaluate: (row) => {
      const hist = Number(row?.checks_with_history ?? 0);
      if (hist === 0) {
        return { status: 'pass', detail: 'No verdict history yet — needs two runs to compare. Re-check after the next data-quality run.' };
      }
      const nf = Number(row?.newly_failing ?? 0);
      const nw = Number(row?.newly_warning ?? 0);
      if (nf > 0) {
        return {
          status: 'fail',
          detail: `${nf} check(s) went pass -> fail since the previous run: ${row?.newly_failing_ids}. ` +
                  `A transition is the actionable signal — investigate these before any long-standing red.`,
        };
      }
      if (nw > 0) return { status: 'warn', detail: `${nw} check(s) went pass -> warn since the previous run.` };
      return { status: 'pass', detail: `No new failures across ${hist} checks with history.` };
    },
  },

  {
    id: 'dq-uninformative-checks',
    label: 'no data-quality check has an unvarying verdict (a check that cannot fail proves nothing)',
    category: 'meta',
    critical: false,
    // Class-3 detection, automated for all ~150 checks at once. A verdict that never varies
    // carries zero information whether it is permanently green or permanently red -- this is
    // exactly how drift_detector fired EMERGENCY_RETRAIN at 16/16 historical evaluation points
    // across 14 months while looking like a functioning monitor, and how two checks written in
    // this same session passed only vacuously. Previously this could only be found by manually
    // replaying one detector over history; now it surfaces on its own.
    //
    // Needs >= 10 runs before judging non-pass stuck verdicts, so a newly-added check is not
    // flagged for being new. Permanently-green needs a MUCH higher bar (>= 200 runs, roughly
    // 4+ days at this check's own ~30-min cadence): a check that has simply been healthy for a
    // day or two is indistinguishable from one that is structurally incapable of ever failing,
    // and reporting the former as the latter is exactly the false-alarm noise that makes a real
    // monitor stop being read. Found live 2026-08-17 (`/threshold-calibration-audit`): the
    // original SQL only ever computed stuck_bad (`only_status <> 'pass'`) despite this comment
    // already describing the green-forever half as intended — it was documented, never wired up.
    sql: `WITH agg AS (
            SELECT check_id, COUNT(*) AS runs, COUNT(DISTINCT status) AS distinct_status,
                   MIN(status) AS only_status
              FROM data_quality_history
             WHERE checked_at > (EXTRACT(epoch FROM now()) - 86400 * 30) * 1000
             GROUP BY check_id
          )
          SELECT COUNT(*) FILTER (WHERE runs >= 10) AS judged,
                 COUNT(*) FILTER (WHERE runs >= 10 AND distinct_status = 1 AND only_status <> 'pass') AS stuck_bad,
                 COALESCE(string_agg(check_id, ', ') FILTER (WHERE runs >= 10 AND distinct_status = 1 AND only_status <> 'pass'), '') AS stuck_bad_ids,
                 COUNT(*) FILTER (WHERE runs >= 200 AND distinct_status = 1 AND only_status = 'pass') AS stuck_good,
                 COALESCE(string_agg(check_id, ', ') FILTER (WHERE runs >= 200 AND distinct_status = 1 AND only_status = 'pass'), '') AS stuck_good_ids
            FROM agg`,
    evaluate: (row) => {
      const judged = Number(row?.judged ?? 0);
      if (judged === 0) {
        return { status: 'pass', detail: 'Not enough verdict history yet (needs 10+ runs per check) — re-check in a few days.' };
      }
      const bad = Number(row?.stuck_bad ?? 0);
      const good = Number(row?.stuck_good ?? 0);
      if (bad > 0) {
        return {
          status: 'warn',
          detail: `${bad} check(s) have returned the SAME non-pass verdict on every one of their last 10+ runs: ` +
                  `${row?.stuck_bad_ids}. Either the defect is real and unactioned, or the check cannot pass — ` +
                  `both mean it is currently providing no signal.` +
                  (good > 0 ? ` Also, ${good} check(s) have passed on every one of their last 200+ runs (candidate for a too-loose threshold, not proof of one): ${row?.stuck_good_ids}.` : ''),
        };
      }
      if (good > 0) {
        return {
          status: 'warn',
          detail: `${good} check(s) have passed on EVERY one of their last 200+ runs: ${row?.stuck_good_ids}. ` +
                  `A verdict that can never vary carries no information either direction — this is a candidate ` +
                  `list for a too-loose threshold, not proof of one; review whether each could ever actually fire.`,
        };
      }
      return { status: 'pass', detail: `${judged} checks judged over 10+ runs; none stuck on a single verdict either direction.` };
    },
  },

  {
    id: 'ml-signal-columns-populated',
    label: 'every ML signal column on technical_signals is actually being written',
    category: 'ml',
    critical: false,
    // Built 2026-08-15 after a session that found defects in these columns ONE AT A TIME over
    // weeks -- fix one, wait days for data, find the next. Checking all of them together is a
    // few seconds and immediately surfaced flyer_probability at 0/2192 on every recent date,
    // which nothing else was watching.
    //
    // These are the columns consumed as SIGNALS (scoring_engine's Factor 3, cs_ranker, the
    // ranker's gates), as opposed to the ~300 feature inputs covered by
    // technical-signals-feature-coverage's aggregate count. A dead signal column is a silently
    // degraded score, not a missing feature -- it must be named, not counted.
    //
    // Adding a new ML output column to technical_signals? Add it here. The list is deliberately
    // explicit rather than derived: these are a handful of known model outputs, and a wrong
    // derivation (matching any *_probability, say) would silently drop coverage the day someone
    // renames one.
    // Measured on the last ENRICHED day, not the last day with rows. These columns are written
    // by ml-daily-ops in the EVENING, enriching the previous completed session -- so the most
    // recent date in the table is always the one whose enrichment has not run yet, and reading
    // it reports every enrichment column as 100% dead every single day. Confirmed live
    // 2026-08-15: date 2026-08-14 showed 0/2192 on delivery_pct, roce, iv_hv_ratio and ~20 more,
    // while 2026-08-13 was healthy (1939, 1609, 2185) -- ml-daily-ops last succeeded 08-14 20:23
    // IST and 08-15 was Independence Day, so 08-14's enrichment never ran. This is exactly
    // recurring-bugs.md's "coverage ratio computed over a window that includes today" class, and
    // the first version of this check reintroduced it.
    //
    // Anchor: the newest date strictly OLDER than the last successful ml-daily-ops run, i.e. a
    // day enrichment has demonstrably had its chance at. Falls back to the second-newest date if
    // no heartbeat exists, rather than silently reverting to the broken same-day read.
    sql: `WITH enriched_through AS (
            SELECT COALESCE(
              (SELECT to_timestamp(MAX(last_success_at)/1000)::date FROM job_heartbeat WHERE job_name = 'ml-daily-ops'),
              (SELECT MAX(date)::date - 1 FROM technical_signals)
            ) AS d
          ), latest AS (
            SELECT * FROM technical_signals
            WHERE date = (SELECT MAX(date) FROM technical_signals
                           WHERE date::date < (SELECT d FROM enriched_through))
          )
          SELECT COUNT(*) AS rows,
                 COUNT(win_probability)            AS win_probability,
                 COUNT(calibrated_win_probability) AS calibrated_win_probability,
                 COUNT(cs_score)                   AS cs_score,
                 COUNT(flyer_probability)          AS flyer_probability,
                 COUNT(movement_probability)       AS movement_probability,
                 COUNT(breakout_probability)       AS breakout_probability
            FROM latest`,
    evaluate: (row) => {
      const rows = Number(row?.rows ?? 0);
      if (rows === 0) return { status: 'fail', detail: 'No technical_signals rows on the last completed trading day.' };
      // flyer_probability is deliberately excluded: it is written WEEKLY (live-checked
      // 2026-08-15 -- 2193 rows on 2026-08-07, 0 on every other date), so grading it on a daily
      // bar reports a false failure 6 days in 7. A weekly column needs a weekly-cadence check,
      // not this one. measurement.md also records flyer_classifier as AUC 0.81 / IC -0.041,
      // i.e. a known-bad model -- worth deciding whether it should exist at all.
      const cols = ['win_probability', 'calibrated_win_probability', 'cs_score',
                    'movement_probability', 'breakout_probability'];
      const dead = cols.filter(c => Number(row?.[c] ?? 0) === 0);
      const thin = cols.filter(c => {
        const n = Number(row?.[c] ?? 0);
        return n > 0 && n / rows < 0.5;
      });
      if (dead.length) {
        return {
          status: 'fail',
          detail: `${dead.join(', ')} 100% NULL across all ${rows} rows of the last completed day — ` +
                  `its writer is not landing, and any score consuming it is silently degraded.` +
                  (thin.length ? ` Also thin (<50%): ${thin.join(', ')}.` : ''),
        };
      }
      if (thin.length) {
        return { status: 'warn', detail: `Thin coverage (<50% of ${rows} rows): ${thin.join(', ')}.` };
      }
      return { status: 'pass', detail: `All ${cols.length} ML signal columns populated across ${rows} rows.` };
    },
  },

  {
    id: 'win-probability-scored-in-time',
    label: 'win_probability is written soon enough after its signal date to be a usable signal',
    category: 'ml',
    critical: false,
    // This check exists because the 2026-08-15 grading of win_probability produced a clean-looking
    // forward edge (raw h=1d rank IC +0.0364, t=+2.58) whose provenance nobody could confirm from
    // the data; win_probability_scored_at (migration 1787050000000) makes the lag measurable, so
    // the question is settled by a number instead of by re-deriving it from the scheduler.
    //
    // CORRECTED 2026-08-16: an earlier version of this comment asserted that `ml_ensemble.py
    // --score` runs ONLY inside the WEEKLY retrain, and that the 2026-08-15 result was therefore
    // pure look-ahead. **measurement.md withdrew that retraction the same day and the comment was
    // never swept.** Scoring runs DAILY -- `queues.ts:1037` calls `pythonApi.scorePending()` ->
    // ml-api -> `ml_ensemble.run(do_train=False, do_score=True)`, which no grep for `--score` can
    // find. Confirmed in data: `unscored = 0` on every recent date. Do not restore the weekly
    // claim; see recurring-bugs.md's "a writer is not found by grepping its CLI flag".
    //
    // A signal must be written before the next session opens to be actionable. One calendar day
    // of slack tolerates the normal post-close scoring window; beyond ~3 days the column cannot
    // be a live signal at all, only a backfilled label.
    sql: `SELECT COUNT(*) AS scored,
                 ROUND(AVG(EXTRACT(epoch FROM (win_probability_scored_at - date::date)) / 86400.0)::numeric, 2) AS avg_lag_days,
                 MAX(EXTRACT(epoch FROM (win_probability_scored_at - date::date)) / 86400.0) AS max_lag_days
            FROM technical_signals
           WHERE win_probability_scored_at IS NOT NULL
             AND date::date >= CURRENT_DATE - 30`,
    evaluate: (row) => {
      const scored = Number(row?.scored ?? 0);
      if (scored === 0) {
        return {
          status: 'pass',
          detail: 'No rows scored since migration 1787050000000 yet. The daily ml-ensemble-score ' +
                  'step (queues.ts:1037) stamps this on its next run against a fresh trading day.',
        };
      }
      // Minimum-sample guard. A whole batch is ~2,200 rows; anything far below that is not the
      // scorer's real cadence, it is a manual/partial write, and averaging over it produces a
      // confident wrong verdict. Measured 2026-08-16: exactly ONE row carried a stamp (1.41d),
      // which measurement.md itself records as "an artifact of a manual test write, NOT the real
      // cadence" -- and this check reported warn on 36/36 runs off that single row, which is how
      // it landed on the unvarying-verdict meta-check's list. Same family as measurement.md's
      // "dramatic number from a small filtered subsample" (t=-3.44 -> -1.28 once re-anchored).
      const MIN_SAMPLE = 100;
      if (scored < MIN_SAMPLE) {
        return {
          status: 'pass',
          detail: `Only ${scored} row(s) carry a scored-at stamp in the last 30d — below the ` +
                  `${MIN_SAMPLE}-row floor needed to read a cadence. Too thin to judge, so no verdict ` +
                  `is rendered rather than averaging a partial/manual write into a false alarm.`,
        };
      }
      const avg = Number(row?.avg_lag_days ?? 0);
      const max = Number(row?.max_lag_days ?? 0);
      const detail = `${scored} rows scored in the last 30d; win_probability written on average ` +
                     `${avg.toFixed(2)}d after its signal date (worst ${max.toFixed(2)}d).`;
      if (avg > 3) {
        return {
          status: 'fail',
          detail: `${detail} That is far too late to be a live signal — it is a backfilled label, and ` +
                  `grading it against next-day entry is look-ahead (see measurement.md's retraction).`,
        };
      }
      if (avg > 1) {
        return { status: 'warn', detail: `${detail} Past the next session's open for most rows — not reliably actionable.` };
      }
      return { status: 'pass', detail };
    },
  },

  {
    id: 'technical-signals-provenance-timestamps',
    label: 'technical_signals.created_at/updated_at are actually populated on rows written today',
    category: 'ml',
    critical: false,
    // A dead PROVENANCE column is categorically different from a dead ML feature, and must not be
    // absorbed into the aggregate dead-column count below. Both were 100% NULL on all 73,563 rows
    // until migration 1787040000000 -- they had no DEFAULT and no writer set them -- and
    // 'technical-signals-feature-coverage' counted them silently inside a baseline of 53 dead
    // columns, where two more were indistinguishable from an unpopulated feature.
    //
    // The cost of that blindness (2026-08-15): win_probability is written by a LATER UPDATE than
    // the row's creation, so "was this knowable before the next session's open?" can only be
    // answered from the UPDATE time. computed_at records the row's BIRTH -- a lower bound that
    // cannot prove a later write landed in time. With updated_at dead, a naive read of computed_at
    // ("same-day, looks fine") produced a confident, wrong "win_probability has forward edge,
    // IC +0.0364, t=+2.58" that had to be retracted once the writer's weekly cadence was traced
    // through the scheduler instead. See recurring-bugs.md.
    //
    // Scoped to rows created TODAY: historical rows are NULL by design (migration 1787040000000
    // deliberately did not backfill -- stamping a fabricated write time onto an audit column is
    // worse than an honest NULL), so a whole-table NULL count would never go green.
    sql: `SELECT COUNT(*) AS todays_rows,
                 COUNT(created_at) AS created_at_set,
                 COUNT(updated_at) AS updated_at_set
            FROM technical_signals
           WHERE computed_at >= CURRENT_DATE`,
    evaluate: (row) => {
      const rows = Number(row?.todays_rows ?? 0);
      const cSet = Number(row?.created_at_set ?? 0);
      const uSet = Number(row?.updated_at_set ?? 0);
      if (rows === 0) {
        return { status: 'pass', detail: 'No technical_signals rows created yet today — nothing to check.' };
      }
      const dead: string[] = [];
      if (cSet === 0) dead.push('created_at');
      if (uSet === 0) dead.push('updated_at');
      if (dead.length) {
        return {
          status: 'fail',
          detail: `${dead.join(' and ')} NULL on all ${rows} rows created today — the DEFAULT/trigger from ` +
                  `migration 1787040000000 is not in effect. Write provenance is unauditable, which is how the ` +
                  `2026-08-15 win_probability look-ahead went undetected.`,
        };
      }
      return {
        status: 'pass',
        detail: `created_at ${cSet}/${rows}, updated_at ${uSet}/${rows} populated on today's rows.`,
      };
    },
  },

  {
    id: 'technical-signals-feature-coverage',
    label: 'technical_signals feature columns that are 100% NULL on the last completed day',
    category: 'ml',
    critical: false,
    sql: `WITH latest AS (
            SELECT * FROM technical_signals
            -- date is a native DATE (2026-08-25 migration): compare it to a DATE. The previous
            -- form cast CURRENT_DATE to text instead, which is exactly "date < text".
            WHERE date::text < CURRENT_DATE
              AND date = (SELECT MAX(date) FROM technical_signals WHERE date::text < CURRENT_DATE)
          ), kv AS (
            SELECT key, COUNT(*) FILTER (WHERE value <> 'null'::jsonb) AS non_null
            FROM latest t, LATERAL jsonb_each(to_jsonb(t))
            GROUP BY key
          )
          SELECT (SELECT COUNT(*) FROM latest) AS grid_rows,
                 COUNT(*) AS total_cols,
                 COUNT(*) FILTER (WHERE non_null = 0) AS dead_cols
          FROM kv`,
    evaluate: (row) => {
      const gridRows = Number(row?.grid_rows ?? 0);
      const total = Number(row?.total_cols ?? 0);
      const dead = Number(row?.dead_cols ?? 0);
      if (gridRows === 0 || total === 0) {
        return { status: 'fail', detail: 'No technical_signals rows on the last completed trading day — the grid-ensurer did not run.' };
      }
      const pct = ((dead / total) * 100).toFixed(1);
      const detail = `${dead}/${total} feature columns (${pct}%) are 100% NULL across all ${gridRows} rows of the last completed day (baseline 53 on 2026-08-13).`;
      if (dead > 65) return { status: 'fail', detail: `${detail} That is well above the baseline — a feature writer has stopped landing on the grid.` };
      if (dead > 55) return { status: 'warn', detail: `${detail} Up from the baseline — check which writer regressed.` };
      return { status: 'pass', detail };
    },
  },

  {
    id: 'pg-backup-recency',
    label: 'Postgres logical backup ran, and the dump it wrote was readable',
    category: 'infra',
    // critical: a single-box deployment's entire recovery story. Everything else in this file
    // watches whether the data is CORRECT; this is the only one watching whether it still
    // EXISTS after a disk loss.
    critical: true,
    // scripts/backup_pg.py shipped with P5 hardening and was then referenced by nothing --
    // not queues.ts, not jobRegistry.ts, not ecosystem.config.cjs. It had never run on a
    // schedule, and no check could have revealed that, because a backup leaves no trace in
    // any data table. Scheduled 2026-08-19 as pm2's `pg-backup-nightly`; this check is the
    // other half, since a scheduled-but-silently-failing backup is the same outcome.
    //
    // NOT tradingDaysStale: the database accumulates rows 24/7 (confluence_signals refreshes
    // every 30 min year-round) and a weekend disk loss costs exactly as much as a weekday one.
    // Backups are one of the few genuinely 7-day-cadence things here.
    //
    // backup_pg.py records success only AFTER verifying the dump's TOC with `pg_restore
    // --list`, so last_success_at means "a readable dump exists", not merely "pg_dump exited
    // 0" -- pg_dump can exit 0 having written a truncated file when the disk fills mid-write.
    sql: `SELECT last_status, last_error,
                 to_timestamp(last_run_at/1000)     AS last_run_at,
                 to_timestamp(last_success_at/1000) AS last_success_at
            FROM job_heartbeat
           WHERE job_name = 'pg-backup'`,
    evaluate: (row, now) => {
      if (!row) {
        return {
          status: 'fail',
          detail: 'No pg-backup heartbeat row has ever been written — the nightly backup has ' +
                  'never run. Check that pm2 has `pg-backup-nightly` registered ' +
                  '(`pm2 describe pg-backup-nightly`) and that ecosystem.config.cjs was reloaded.',
        };
      }
      const sinceSuccess = daysStale(row.last_success_at, now);
      if (sinceSuccess == null) {
        return {
          status: 'fail',
          detail: `pg-backup has run (last_run_at ${row.last_run_at ?? 'unknown'}) but has NEVER ` +
                  `succeeded. Last error: ${row.last_error ?? 'none recorded'}`,
        };
      }
      const d = sinceSuccess.toFixed(1);
      // The job is nightly, so >2d means at least one full run was missed or failed.
      if (sinceSuccess > 3) {
        return {
          status: 'fail',
          detail: `Last verified Postgres backup was ${d} days ago. Recovery point is now ${d} ` +
                  `days of data. Last status '${row.last_status}'` +
                  (row.last_error ? `: ${String(row.last_error).slice(0, 300)}` : '.'),
        };
      }
      if (sinceSuccess > 2) {
        return {
          status: 'warn',
          detail: `Last verified Postgres backup was ${d} days ago on a nightly schedule — one run ` +
                  `was missed or failed. Last status '${row.last_status}'.`,
        };
      }
      if (row.last_status !== 'success') {
        return {
          status: 'warn',
          detail: `A verified backup exists from ${d} days ago, but the MOST RECENT run failed: ` +
                  `${String(row.last_error ?? '').slice(0, 300)}`,
        };
      }
      return { status: 'pass', detail: `Verified backup ${d} days old (TOC readable at write time).` };
    },
  },

  {
    id: 'deploy-drift',
    label: 'bharat-server was restarted at or after the current git HEAD commit',
    category: 'infra',
    // critical: a merged fix that was never deployed is worse than no fix -- it reads as
    // resolved everywhere except in the one place that matters.
    critical: true,
    // scripts/check_deploy_drift.mjs does the actual git/pm2 comparison (it needs `git log`
    // and `pm2 jlist`, neither of which belongs behind a SQL query) and stamps this row.
    // NOTE: that script applies a 2h grace window (scripts/lib/deployDriftVerdict.mjs) before a
    // commit newer than the running process counts as a finding -- it stamps SUCCESS while a
    // just-landed commit is still inside it. Without that, this entry went red the instant
    // anyone committed and stayed red until the next restart (measured 61/198 runs failed), and
    // a `critical` check that is red by construction on every dev day stops being read.
    // "server N commits behind HEAD" is a recurring audit finding (AF-14) -- always caught
    // late by a human noticing, never by a check, because nothing compared the two before.
    sql: `SELECT last_status, last_error,
                 to_timestamp(last_run_at/1000)     AS last_run_at,
                 to_timestamp(last_success_at/1000) AS last_success_at
            FROM job_heartbeat
           WHERE job_name = 'deploy-drift'`,
    evaluate: (row, now) => {
      if (!row) {
        return {
          status: 'fail',
          detail: 'No deploy-drift heartbeat row has ever been written — the check has never run. ' +
                  'Confirm pm2 has `deploy-drift-check` registered (`pm2 describe deploy-drift-check`).',
        };
      }
      const sinceRun = daysStale(row.last_run_at, now);
      if (sinceRun == null || sinceRun > 0.5) {
        // Scheduled every 15 min; >12h since ANY run (success or fail) means the checker
        // itself has stopped, which is worse than a drift finding — nothing is watching.
        return {
          status: 'fail',
          detail: `deploy-drift-check has not run in ${sinceRun == null ? 'an unknown amount of time' : `${sinceRun.toFixed(1)} days`} ` +
                  '— the checker itself appears to have stopped, not just found drift.',
        };
      }
      if (row.last_status !== 'success') {
        return {
          status: 'fail',
          detail: String(row.last_error ?? 'bharat-server is behind the current commit, or is not running.'),
        };
      }
      return { status: 'pass', detail: 'bharat-server was last restarted at or after the current HEAD commit.' };
    },
  },

  {
    id: 'port-drift',
    label: 'Every online pm2 app service actually owns the port it is supposed to be listening on',
    category: 'infra',
    // critical: this is the exact failure mode that took ml-api and alphaquant-api fully
    // offline for over an hour on 2026-08-20 while pm2 reported both "online" -- an
    // ancestry-unrelated process (leftover from a Docker Desktop crash) won the port race
    // first, so the pm2-tracked process started clean but never actually served traffic.
    critical: true,
    // scripts/check_port_drift.mjs does the actual pm2/netstat/process-tree comparison
    // (needs `pm2 jlist` and Windows process introspection, neither of which belongs
    // behind a SQL query) and stamps this row. See that script's header for the full
    // incident and why ancestry, not interpreter path, is the only reliable signal.
    sql: `SELECT last_status, last_error,
                 to_timestamp(last_run_at/1000)     AS last_run_at,
                 to_timestamp(last_success_at/1000) AS last_success_at
            FROM job_heartbeat
           WHERE job_name = 'port-drift'`,
    evaluate: (row, now) => {
      if (!row) {
        return {
          status: 'fail',
          detail: 'No port-drift heartbeat row has ever been written — the check has never run. ' +
                  'Confirm pm2 has `port-drift-check` registered (`pm2 describe port-drift-check`).',
        };
      }
      const sinceRun = daysStale(row.last_run_at, now);
      if (sinceRun == null || sinceRun > 0.5) {
        // Scheduled every 15 min; >12h since ANY run (success or fail) means the checker
        // itself has stopped, which is worse than a drift finding — nothing is watching.
        return {
          status: 'fail',
          detail: `port-drift-check has not run in ${sinceRun == null ? 'an unknown amount of time' : `${sinceRun.toFixed(1)} days`} ` +
                  '— the checker itself appears to have stopped, not just found drift.',
        };
      }
      if (row.last_status !== 'success') {
        return {
          status: 'fail',
          detail: String(row.last_error ?? 'a service port is squatted by a process outside pm2\'s tracked tree.'),
        };
      }
      return { status: 'pass', detail: 'every online pm2 app service owns its expected port.' };
    },
  },

  {
    id: 'trendlyne-per-symbol-fetcher-coverage',
    label: 'Trendlyne per-symbol fetchers cover the universe they claim to, not just a recent sliver',
    category: 'reference',
    critical: false,
    // Hand-rolled, not a TABLE_FRESHNESS_CHECKS entry, and that is the entire point.
    // data-sources.md's freshness mandate is satisfied for both these tables and is structurally
    // blind here: makeFreshnessCheck() reads MAX(date), and ONE partial write keeps MAX(date)
    // recent while ~93% of the universe is missing.
    //
    // Found live 2026-08-16. `trendlyne-midweek` had not succeeded since 2026-08-04 (26/33 runs
    // failed) because Trendlyne began returning `405 Not Allowed` for EVERY id on both
    // adv-technical-analysis and price-performance-analysis. Measured against 2,234 mapped
    // numeric tlids: trendlyne_price_analysis held 165 symbols (7.4%) on its newest date and 357
    // rows in its entire lifetime; trendlyne_adv_tech_daily held 1,350 (60%) on 08-14 but 139 and
    // 125 on the two days before. Both freshness checks reported PASS throughout.
    // recurring-bugs.md: "a fresh table is not a delivered feature."
    //
    // Measured over a ROLLING WINDOW on fetched_at, not "coverage on MAX(date)" -- the original
    // shape of this check, which was wrong in BOTH directions once the fetchers moved (2026-08-17,
    // f498061/19b82b2) from one full-universe pass per run to a bounded slice per run that
    // converges across many runs:
    //
    //   * FALSE ALL-CLEAR. trendlyne_adv_tech_daily stamps its rows with logical_write_floor()
    //     (= MAX(stock_ohlcv.date)), which only advances when a new session's OHLCV lands. Once
    //     that date is fully covered the fetcher correctly no-ops -- _load_stocks returns [] and
    //     main() exits 0. Live 2026-08-17: its newest date was 2026-08-14, three days old and at
    //     2234/2234, and this check reported "100.0%" PASS. Had Trendlyne blocked the endpoint
    //     permanently at that moment, MAX(date) would have stayed pinned there and the check
    //     would have read 100% PASS forever. That is precisely the blind spot the comment above
    //     claims this check exists to close, in mirror image: it caught partial coverage on a
    //     fresh date and could not see full coverage on a dead one.
    //   * FALSE ALARM. trendlyne_price_analysis keys its rows on the real calendar date, so its
    //     coverage resets to zero at every midnight and climbs through the day at ~110 symbols
    //     per 80-minute rotation slot. This check runs at 08:40 IST, ~6 slices in, so a perfectly
    //     healthy fetcher could not read above ~30% at report time and fired FAIL/WARN every
    //     single morning by construction -- which is why dq-unvarying-verdict independently
    //     flagged this check as one that never returns a passing verdict.
    //
    // fetched_at is the honest column for both: it is a true last-write time (both upserts carry
    // `fetched_at = CURRENT_TIMESTAMP` in their ON CONFLICT DO UPDATE list -- verified, not
    // assumed, since a fetched_at absent from that list would silently be a first-seen time, cf.
    // the signal_generated_at incident in recurring-bugs.md) and it is independent of the two
    // fetchers' genuinely different date semantics. It is TEXT in production on both tables
    // (information_schema, not assumed), hence the explicit cast.
    //
    // A 4-day window is wide enough that a healthy fetcher always contains at least one full
    // pass -- including across a weekend, when adv_tech legitimately writes nothing from Saturday
    // until the next session's OHLCV lands -- and narrow enough to notice a dead endpoint within
    // 4 days, against the previous check's "never". That latency is the deliberate trade.
    sql: `WITH universe AS (
            SELECT COUNT(*)::float AS n FROM nse_stocks
             WHERE tlid IS NOT NULL AND tlid ~ '^[0-9]+$'
          )
          SELECT (SELECT n FROM universe) AS universe,
                 (SELECT COUNT(DISTINCT symbol) FROM trendlyne_adv_tech_daily
                   WHERE fetched_at::timestamptz >= NOW() - INTERVAL '4 days') AS adv_tech,
                 (SELECT ROUND((EXTRACT(EPOCH FROM (NOW() - MAX(fetched_at::timestamptz))) / 3600.0)::numeric, 1)
                    FROM trendlyne_adv_tech_daily) AS adv_tech_hrs,
                 (SELECT COUNT(DISTINCT symbol) FROM trendlyne_price_analysis
                   WHERE fetched_at::timestamptz >= NOW() - INTERVAL '4 days') AS price_analysis,
                 (SELECT ROUND((EXTRACT(EPOCH FROM (NOW() - MAX(fetched_at::timestamptz))) / 3600.0)::numeric, 1)
                    FROM trendlyne_price_analysis) AS price_analysis_hrs`,
    evaluate: (row) => {
      const universe = Number(row?.universe ?? 0);
      if (universe === 0) return { status: 'fail', detail: 'No nse_stocks rows carry a numeric tlid — the mapping itself is broken.' };
      const parts = [
        { name: 'trendlyne_adv_tech_daily', n: Number(row?.adv_tech ?? 0), hrs: row?.adv_tech_hrs },
        { name: 'trendlyne_price_analysis', n: Number(row?.price_analysis ?? 0), hrs: row?.price_analysis_hrs },
      ].map(p => ({ ...p, pct: p.n / universe }));
      const detail = parts
        .map(p => `${p.name} ${p.n}/${universe} (${(p.pct * 100).toFixed(1)}%) in the last 4d, ` +
                  `last write ${p.hrs == null ? 'never' : `${Number(p.hrs).toFixed(1)}h ago`}`)
        .join('; ');
      const dead = parts.filter(p => p.pct < 0.50);
      const thin = parts.filter(p => p.pct >= 0.50 && p.pct < 0.85);
      if (dead.length) {
        return {
          status: 'fail',
          detail: `${detail}. ${dead.map(p => p.name).join(', ')} reached under 50% of the mapped universe ` +
                  `across a full 4-day rotation window — that is not a mid-convergence partial run, the ` +
                  `fetcher is not getting through (check job_heartbeat for trendlyne-catchup and ` +
                  `trendlyne-midweek; a 405 on every id means the endpoint is blocked upstream, not a code fault).`,
        };
      }
      if (thin.length) {
        return { status: 'warn', detail: `${detail}. ${thin.map(p => p.name).join(', ')} between 50% and 85% over 4 days — converging slower than the rotation should allow.` };
      }
      return { status: 'pass', detail };
    },
  },

  // ── News sources added 2026-08-13, source-scoped (hand-rolled, not the TABLE_FRESHNESS_CHECKS
  // factory) -- all four write into the same shared news_sentiment_items table the existing
  // 'news-sentiment-freshness' check already covers, so a bare MAX(fetched_at) over the whole
  // table would stay green even if one of these four sources went silently dead while the other
  // ~15 kept writing. Per data-sources.md's freshness-check mandate: "a hand-rolled bespoke
  // check is still fine for anything needing custom logic beyond simple freshness" -- a
  // WHERE source = ? filter is exactly that, which the factory doesn't support.
  {
    id: 'nse-announcements-freshness', label: 'news_sentiment_items — NSE Announcements source',
    category: 'reference', critical: false,
    sql: `SELECT MAX(fetched_at) AS last_date FROM news_sentiment_items WHERE source = 'NSE Announcements'`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'No NSE Announcements rows yet' };
      if (stale > 3) return { status: 'fail', detail: `Latest NSE Announcements row is ${fmtDays(stale)} old` };
      if (stale > 1) return { status: 'warn', detail: `Latest NSE Announcements row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `Latest NSE Announcements row ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'nse-financial-results-freshness', label: 'news_sentiment_items — NSE Financial Results source',
    category: 'reference', critical: false,
    sql: `SELECT MAX(fetched_at) AS last_date FROM news_sentiment_items WHERE source = 'NSE Financial Results'`,
    evaluate: (row, now) => {
      // Sparse by nature (few filings/day outside results season) -- warn-only, matching
      // insider-trades-recency's existing style for episodic datasources.
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'No NSE Financial Results rows yet' };
      if (stale > 7) return { status: 'warn', detail: `Latest NSE Financial Results row is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Latest NSE Financial Results row ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'mc-earnings-news-freshness', label: 'news_sentiment_items — MoneyControl Earnings source',
    category: 'reference', critical: false,
    sql: `SELECT MAX(fetched_at) AS last_date FROM news_sentiment_items WHERE source = 'MoneyControl Earnings'`,
    evaluate: (row, now) => {
      // Sparse by nature -- only fires when a symbol is actually within the results window
      // (technical_signals.days_to_next_results), which can legitimately be zero on a quiet day.
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'No MoneyControl Earnings rows yet' };
      if (stale > 7) return { status: 'warn', detail: `Latest MoneyControl Earnings row is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Latest MoneyControl Earnings row ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'mc-deals-news-freshness', label: 'news_sentiment_items — MoneyControl Deals source',
    category: 'reference', critical: false,
    sql: `SELECT MAX(fetched_at) AS last_date FROM news_sentiment_items WHERE source = 'MoneyControl Deals'`,
    evaluate: (row, now) => {
      // MC Deals only publishes on trading days (bulk/block deal news) -- unlike the market-wide
      // RSS/Google News/GNews sources this table also holds, which is why the sibling
      // news-sentiment-freshness check above is deliberately tradingDayAware:false but this
      // source-scoped one isn't. Raw daysStale() read a stale Friday row as "stale" every
      // weekend it was checked (found live 2026-08-19, /temporal-correctness-audit: warn on
      // 18/74 sampled Sundays, 1/3 Saturdays, 0/0 any weekday) -- tradingDaysStale() removes
      // the Sat/Sun gap the same way the ohlcv/fii-dii/market-regimes checks were fixed for
      // Monday mornings on 2026-08-03.
      const stale = tradingDaysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'No MoneyControl Deals rows yet' };
      if (stale > 3) return { status: 'fail', detail: `Latest MoneyControl Deals row is ${fmtDays(stale)} old` };
      if (stale > 1) return { status: 'warn', detail: `Latest MoneyControl Deals row is ${fmtDays(stale)} old` };
      return { status: 'pass', detail: `Latest MoneyControl Deals row ${fmtDays(stale)} old` };
    },
  },

  // ── Generated from TABLE_FRESHNESS_CHECKS (see the factory + mandate comment above) ──────
  ...TABLE_FRESHNESS_CHECKS.map(makeFreshnessCheck),
  {
    id: 'ur-engine-score-zero-not-null',
    label: 'unified_recommendations *_score columns write NULL (not 0.0) when an engine never scored a symbol',
    category: 'scoring',
    // NOT critical: this is a data-fidelity defect, not an outage. It never breaks a live
    // score -- engine_scores/`unified` are computed from `present` BEFORE these reporting
    // columns are built -- but it silently poisons any MEASUREMENT built on this table.
    critical: false,
    // AF-20260818-31. Five of the eight reporting columns lacked the
    // `'X' in has_data else None` guard three siblings already had, so an engine that never
    // scored a symbol wrote a literal 0.0. Fixed 2026-08-18 (unified_ranker.py:2454-2461,
    // all 8 columns now guarded).
    //
    // Why it earns a standing check rather than "fixed, move on": the blast radius was only
    // discovered on 2026-08-22, four days later, when an ablation built its historical panel
    // from these columns and reported a NEGATIVE blend IC. ml_score was 0 on 36,400 of 72,223
    // rows and dl_score on 100% of some dates; normalizing a constant-zero engine re-spreads
    // it over a full 0-100 rank, i.e. injects pure noise at a real weight. A wrong number that
    // looks plausible is this repo's most expensive failure mode (measurement.md: "a bug in
    // the measurement tooling is worse than no measurement, because it looks like evidence").
    //
    // The test is a ZERO SPIKE, not any zero at all. Genuine zeros exist and must not alarm:
    // verified live 2026-08-22, dl_score=0 rows have real prob_up_5d values rounding to 0.00,
    // and smart_money_score=0 legitimately means "no deals". The artifact's signature is a
    // whole ENGINE going zero at once (100%, or a systematically-unscored cohort), never a
    // handful of rows.
    //
    // The floor is MEASURED against post-fix dates (2026-08-18+), not guessed: per-date
    // genuine zero share maxes at smart_money 7.0%, dl 2.1%, breakout/cs 0.0%. 15% therefore
    // sits above every genuine rate observed and an order of magnitude below the artifact's.
    // A first version used 5% and WARNed on smart_money's legitimate 6.9% on the very first
    // live run -- recurring-bugs.md is explicit that a check which cries wolf on correct data
    // stops being read, which is the same argument the delivery-data check already lost once.
    sql: `WITH latest AS (SELECT MAX(computed_at)::date AS d FROM unified_recommendations),
               r AS (SELECT * FROM unified_recommendations
                      WHERE computed_at::date = (SELECT d FROM latest))
          SELECT (SELECT d FROM latest) AS d, count(*) AS n,
                 count(*) FILTER (WHERE screener_stock_score = 0) AS z_screener,
                 count(*) FILTER (WHERE ml_score = 0)             AS z_ml,
                 count(*) FILTER (WHERE cs_score = 0)             AS z_cs,
                 count(*) FILTER (WHERE confluence_score = 0)     AS z_confluence,
                 count(*) FILTER (WHERE technical_score = 0)      AS z_technical,
                 count(*) FILTER (WHERE dl_score = 0)             AS z_dl,
                 count(*) FILTER (WHERE breakout_score = 0)       AS z_breakout,
                 count(*) FILTER (WHERE smart_money_score = 0)    AS z_smart_money
            FROM r`,
    evaluate: (row) => {
      const n = Number(row?.n ?? 0);
      if (!n) return { status: 'warn', detail: 'No unified_recommendations rows to check' };
      const engines = ['screener', 'ml', 'cs', 'confluence', 'technical', 'dl', 'breakout', 'smart_money'];
      const spikes = engines
        .map(e => ({ e, share: Number(row['z_' + e] ?? 0) / n }))
        .filter(x => x.share >= 0.15)
        .sort((a, b) => b.share - a.share);
      if (!spikes.length) {
        return { status: 'pass', detail: `No engine writes a zero spike on ${row.d} (${n} rows)` };
      }
      const worst = spikes[0];
      const detail = spikes.map(x => `${x.e} ${(x.share * 100).toFixed(1)}%`).join(', ');
      // >=50% of an entire engine at exactly 0 cannot be a real score distribution.
      const status: 'fail' | 'warn' = worst.share >= 0.5 ? 'fail' : 'warn';
      return {
        status,
        detail: `zero-score spike on ${row.d} (${n} rows): ${detail}. A never-scored engine ` +
          'must write NULL, not 0.0 (AF-20260818-31) — check the has_data guards at ' +
          'unified_ranker.py:2454-2461.',
      };
    },
  },
  {
    id: 'ur-engine-dispersion-collapse',
    label: 'How often each engine collapses below ZERO_DISPERSION_MIN_SD and is dropped from the blend',
    category: 'scoring',
    // NOT critical: dropping a collapsed engine is CORRECT behaviour, not a bug. The check
    // exists because the RATE is the signal and nothing was reporting it.
    critical: false,
    // Measured 2026-08-22 over 38 ranker dates, cross-sectional sd on the real 0-100 scale:
    //   dl BELOW 5.0 on 15/38 dates (39%), ml on 13/38 (34%), technical on 7/38 (18%),
    //   confluence 1/38, and screener/cs/breakout/smart_money never.
    // So the ranker genuinely runs without dl or ml about a third of the time. That is
    // already documented as episodic (measurement.md: _get_ml_scores reads
    // calibrated_win_probability, whose isotonic calibrator correctly flattens in a no-edge
    // regime) -- but "correct behaviour" and "fine" are different claims, and until now the
    // rate was invisible: engine_coverage_count records it per row and nothing aggregated it.
    //
    // A sustained rise means an engine is dying, not calibrating. Thresholds sit above the
    // measured baseline (39%) so today's normal does not alarm: warn at 60% of the trailing
    // 10 dates, fail at 80%.
    //
    // NOTE the scale: ZERO_DISPERSION_MIN_SD = 5.0 is calibrated for 0-100 engine scores and
    // is meaningless against raw model outputs (win_probability is 0-1, sd ~0.07 -- every
    // engine looks collapsed). A 2026-08-22 ablation applied it on the raw scale and dropped
    // ml on 33 of 43 dates, flipping its own result negative. This check reads the stored
    // 0-100 columns, which is the scale the constant was written for.
    sql: `WITH d AS (SELECT DISTINCT computed_at::date AS dt FROM unified_recommendations
                      ORDER BY 1 DESC LIMIT 10)
          SELECT count(*) AS dates,
                 count(*) FILTER (WHERE sd_ml   < 5.0) AS collapse_ml,
                 count(*) FILTER (WHERE sd_dl   < 5.0) AS collapse_dl,
                 count(*) FILTER (WHERE sd_tech < 5.0) AS collapse_technical
            FROM (SELECT ur.computed_at::date AS dt,
                         stddev_samp(ur.ml_score)        AS sd_ml,
                         stddev_samp(ur.dl_score)        AS sd_dl,
                         stddev_samp(ur.technical_score) AS sd_tech
                    FROM unified_recommendations ur
                   WHERE ur.computed_at::date IN (SELECT dt FROM d)
                   GROUP BY 1 HAVING count(*) >= 50) x`,
    evaluate: (row) => {
      const dates = Number(row?.dates ?? 0);
      if (dates < 5) return { status: 'pass', detail: `Only ${dates} ranker dates — too few to judge` };
      const rates = ['ml', 'dl', 'technical']
        .map(e => ({ e, rate: Number(row['collapse_' + e] ?? 0) / dates }))
        .sort((a, b) => b.rate - a.rate);
      const detail = rates.map(x => `${x.e} ${(x.rate * 100).toFixed(0)}%`).join(', ') +
        ` of last ${dates} dates (baseline 2026-08-22: dl 39%, ml 34%, technical 18%)`;
      const worst = rates[0];
      if (worst.rate >= 0.8) {
        return {
          status: 'fail',
          detail: `${worst.e} dropped from the blend on ${(worst.rate * 100).toFixed(0)}% of recent ` +
            `dates — an engine collapsing this often is dying, not calibrating: ${detail}`,
        };
      }
      if (worst.rate >= 0.6) return { status: 'warn', detail: `Engine dispersion collapse above baseline: ${detail}` };
      return { status: 'pass', detail: `Engine dispersion collapse within baseline: ${detail}` };
    },
  },
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

// Append-only verdict history, added 2026-08-15. data_quality_results above is a SNAPSHOT --
// one row per check, overwritten every run -- so it cannot answer the two questions that
// actually decide whether a failure gets acted on:
//   1. Did this check just START failing? A pass->fail transition is urgent; a check red for
//      three weeks is a backlog item. Without history both look identical, which is how a real
//      FAIL sat unread inside "145/148 passed, 0 critical failures" (2026-08-15).
//   2. Has this check EVER failed? A verdict that never varies carries zero information whether
//      it is always green or always red -- the exact defect that let drift_detector fire
//      EMERGENCY_RETRAIN 16/16 across 14 months while looking like a working monitor. With
//      history this is detectable automatically, for every check, instead of one at a time.
// Retention is bounded by the pruning in persistHistory (90 days) so this cannot grow unbounded.
const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS data_quality_history (
  check_id   TEXT NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT,
  checked_at BIGINT NOT NULL
)`;
const HISTORY_IDX = `CREATE INDEX IF NOT EXISTS dq_history_check_time
  ON data_quality_history (check_id, checked_at DESC)`;

let _tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!_tableReady) {
    _tableReady = dbExec(DDL)
      .then(() => dbExec(HISTORY_DDL))
      .then(() => dbExec(HISTORY_IDX))
      .catch(() => { /* already exists / DB not ready */ });
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
    // Append to history as well as upserting the snapshot. Best-effort and separately
    // try/caught: a history write must never break either the snapshot or the check run.
    try {
      await dbRun(
        `INSERT INTO data_quality_history (check_id, status, detail, checked_at) VALUES (?, ?, ?, ?)`,
        [check.id, result.status, result.detail, Date.now()],
      );
    } catch { /* history is diagnostic, never load-bearing */ }
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
