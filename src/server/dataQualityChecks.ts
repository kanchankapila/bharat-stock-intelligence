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
      if (stale == null) return { status: cfg.critical ? 'fail' : 'warn', detail: `${cfg.table} is empty` };
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

  // flows
  { id: 'insider-transactions-recency', label: 'insider_transactions (NSE PIT filings)',
    category: 'flows', critical: false, table: 'insider_transactions', dateColumn: 'transaction_date', warnDays: 14 },
  { id: 'bulk-block-deals-recency', label: 'bulk_block_deals (delivery-trend NSE bulk/block feed)',
    category: 'flows', critical: false, table: 'bulk_block_deals', dateColumn: 'deal_date', warnDays: 14 },
  { id: 'stock-delivery-volume-freshness', label: 'stock_delivery_volume (MTO delivery %)',
    category: 'flows', critical: false, table: 'stock_delivery_volume', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'mf-stock-holdings-recency', label: 'mf_stock_holdings (per-stock MF ownership, monthly disclosure)',
    category: 'flows', critical: false, table: 'mf_stock_holdings', dateColumn: 'as_of_date', warnDays: 45 },
  { id: 'mf-sector-allocation-recency', label: 'mf_sector_allocation (MF sector flow)',
    category: 'flows', critical: false, table: 'mf_sector_allocation', dateColumn: 'month', warnDays: 45 },

  // fundamentals
  { id: 'tl-financial-quality-freshness', label: 'tl_financial_quality (weekly ET ratios)',
    category: 'fundamentals', critical: false, table: 'tl_financial_quality', dateColumn: 'as_of_date', warnDays: 10, failDays: 16 },
  { id: 'trendlyne-dvm-scores-freshness', label: 'trendlyne_dvm_scores',
    category: 'fundamentals', critical: false, table: 'trendlyne_dvm_scores', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'proprietary-scores-history-freshness', label: 'proprietary_scores_history (Altman/Ohlson/Graham/DuPont)',
    category: 'fundamentals', critical: false, table: 'proprietary_scores_history', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'working-capital-history-recency', label: 'working_capital_history (monthly cash-conversion-cycle)',
    category: 'fundamentals', critical: false, table: 'working_capital_history', dateColumn: 'fetched_at', warnDays: 45 },
  { id: 'stock-earnings-beats-recency', label: 'stock_earnings_beats',
    category: 'fundamentals', critical: false, table: 'stock_earnings_beats', dateColumn: 'fetched_at', warnDays: 10 },
  { id: 'eps-surprise-history-recency', label: 'eps_surprise_history',
    category: 'fundamentals', critical: false, table: 'eps_surprise_history', dateColumn: 'fetched_at', warnDays: 10 },

  // macro
  { id: 'macro-asset-prices-freshness', label: 'macro_asset_prices (VIX/FII-DII/global indices/PCR-GEX/MMI)',
    category: 'macro', critical: true, table: 'macro_asset_prices', dateColumn: 'date', nativeDateColumn: true, warnDays: 3, failDays: 5 },
  { id: 'eco-calendar-recency', label: 'eco_calendar (MC economic calendar)',
    category: 'macro', critical: false, table: 'eco_calendar', dateColumn: 'fetched_at', warnDays: 14 },
  { id: 'index-valuation-freshness', label: 'index_valuation (Nifty/Sensex PE-PB)',
    category: 'macro', critical: false, table: 'index_valuation', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'mc-global-snapshot-freshness', label: 'mc_global_snapshot (global indices/currencies/ADRs/commodities)',
    category: 'macro', critical: false, table: 'mc_global_snapshot', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'sector-global-corr-freshness', label: 'sector_global_corr',
    category: 'macro', critical: false, table: 'sector_global_corr', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'historical-fno-sentiment-freshness', label: 'historical_fno_sentiment (index-level PCR/GEX)',
    category: 'macro', critical: false, table: 'historical_fno_sentiment', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'sector-fo-sentiment-freshness', label: 'sector_fo_sentiment',
    category: 'macro', critical: false, table: 'sector_fo_sentiment', dateColumn: 'date', nativeDateColumn: true, warnDays: 3, failDays: 5 },
  { id: 'nse-ipo-calendar-recency', label: 'nse_ipo_calendar',
    category: 'macro', critical: false, table: 'nse_ipo_calendar', dateColumn: 'fetched_at', warnDays: 14 },

  // signals / scoring
  { id: 'confluence-signals-freshness', label: 'confluence_signals (canonical confluence engine)',
    category: 'scoring', critical: true, table: 'confluence_signals', dateColumn: 'computed_at',
    tradingDayAware: false, warnDays: 0.1, failDays: 0.25 },
  { id: 'unified-signals-freshness', label: 'unified_signals',
    category: 'signals', critical: false, table: 'unified_signals', dateColumn: 'signal_date', warnDays: 3, failDays: 5 },
  { id: 'screener-appearances-freshness', label: 'screener_appearances (feeds screener_momentum_score)',
    category: 'signals', critical: true, table: 'screener_appearances', dateColumn: 'appeared_date', warnDays: 3, failDays: 5 },
  { id: 'screener-sector-rotation-freshness', label: 'screener_sector_rotation',
    category: 'signals', critical: false, table: 'screener_sector_rotation', dateColumn: 'date', warnDays: 3, failDays: 5 },
  { id: 'intraday-recommendations-freshness', label: 'intraday_recommendations',
    category: 'signals', critical: false, table: 'intraday_recommendations', dateColumn: 'computed_at', warnDays: 3, failDays: 5 },

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
      const stale = daysStale(row?.last_date, now);
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
          FROM signal_outcomes WHERE horizon_days = 15 AND signal_date <= date('now','-20 days')`,
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
