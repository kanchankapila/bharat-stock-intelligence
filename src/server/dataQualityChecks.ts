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
import { dbGet, dbRun, dbExec } from './dbAsync';

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

export const DATA_QUALITY_CHECKS: DataQualityCheck[] = [
  // ── OHLCV ──────────────────────────────────────────────────────────────
  {
    id: 'ohlcv-freshness-coverage',
    label: 'OHLCV freshness & universe coverage',
    category: 'ohlcv',
    critical: true,
    sql: `SELECT MAX(date) AS last_date, COUNT(DISTINCT symbol) AS symbols
          FROM stock_ohlcv WHERE date >= date('now','-10 days')`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
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
            (SELECT COUNT(*) FROM stock_ohlcv WHERE date >= date('now','-5 days')
               AND (close <= 0 OR high < low OR is_suspect = 1)) AS bad,
            (SELECT COUNT(*) FROM stock_ohlcv WHERE date >= date('now','-5 days')) AS total`,
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
    sql: `SELECT MAX(date) AS last_date, COUNT(DISTINCT symbol) AS symbols
          FROM feature_store WHERE date >= date('now','-10 days')`,
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
    sql: `SELECT COUNT(*) AS total,
                 (SELECT COUNT(*) FROM nse_stocks) AS universe,
                 MAX(last_updated) AS last_updated
          FROM stock_scores WHERE timeframe = 'swing'`,
    evaluate: (row, now) => {
      const total = Number(row?.total) || 0;
      const universe = Number(row?.universe) || 0;
      const stale = daysStale(row?.last_updated, now);
      if (total === 0) return { status: 'fail', detail: 'stock_scores (swing) is empty' };
      if (universe > 0 && total < universe * 0.2) {
        return { status: 'fail', detail: `Only ${total}/${universe} NSE stocks have a swing score` };
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
      const stale = daysStale(row?.last_date, now);
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
    sql: `SELECT MAX(date) AS last_date FROM insider_trades`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'insider_trades is empty' };
      if (stale > 14) return { status: 'warn', detail: `Latest insider trade is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Latest insider trade ${fmtDays(stale)} old` };
    },
  },
  {
    id: 'bulk-deals-recency',
    label: 'bulk_deals recency',
    category: 'flows',
    critical: false,
    sql: `SELECT MAX(date) AS last_date FROM bulk_deals`,
    evaluate: (row, now) => {
      const stale = daysStale(row?.last_date, now);
      if (stale == null) return { status: 'warn', detail: 'bulk_deals is empty' };
      if (stale > 14) return { status: 'warn', detail: `Latest bulk deal is ${fmtDays(stale)} old (sparse by nature, so a soft warn)` };
      return { status: 'pass', detail: `Latest bulk deal ${fmtDays(stale)} old` };
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
      const stale = daysStale(row?.last_date, now);
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
