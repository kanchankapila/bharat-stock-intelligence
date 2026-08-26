/**
 * PostgreSQL connection pool (Phase 3).
 *
 * Lazily creates a single shared pool from pgConfig. Only used when USE_POSTGRES is on;
 * the dbAsync facade routes here. Kept separate from the facade so the pool lifecycle
 * (and a health probe) lives in one place.
 */
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { pgConnectionString, vitestSchema } from './pgConfig';

// Parse Postgres BIGINT (INT8) as JavaScript numbers (safe up to 2^53 - 1)
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

// node-postgres's default parser for TIMESTAMP WITHOUT TIME ZONE (OID 1114) builds the JS Date
// using the *client host's* local timezone, not the DB session's. Every naive TIMESTAMP column
// in this schema (computed_ts, resolved_at, fetched_at, etc.) is written via CURRENT_TIMESTAMP
// on a UTC-configured Postgres session (confirmed via `SHOW timezone`), so on an IST host the
// default parser silently shifted every such value by -5:30 (e.g. "10:00 UTC" read back as
// "04:30 UTC"). Confirmed live 2026-07-17 against intraday_recommendations.computed_ts, which
// produced a wrong-by-5.5h staleness read. Override globally so every consumer gets a correct
// Date without a per-callsite `::text` + manual 'Z'-append workaround.
types.setTypeParser(types.builtins.TIMESTAMP, (val) => (val === null ? null : new Date(val.replace(' ', 'T') + 'Z')));

// node-postgres leaves NUMERIC/DECIMAL (OID 1700) as a string by default, to avoid silent
// precision loss on bignum values. Every NUMERIC column this app actually produces is a
// financial ratio/percentage/score, not a value needing exact decimal precision, and callers
// throughout the codebase treat query results as plain numbers (`.toFixed()`, `>`/`<`
// comparisons) -- e.g. `growth_pct` in signals.router.ts/ml.router.ts is built via
// `ROUND(<double precision expr>, 2)`, and Postgres only has a 2-arg round() overload for
// `numeric`, so it silently upcasts the double-precision expression and returns `numeric`
// even though every input column is DOUBLE PRECISION. Confirmed live 2026-08-04: growth_pct
// arrived as a string, and SignalTracking.tsx/V2SignalTracking.tsx's unguarded
// `sig.growth_pct.toFixed(2)` threw during render -- caught by TabErrorBoundary and shown as
// "Service temporarily unavailable", not an actual backend outage.
types.setTypeParser(types.builtins.NUMERIC, (val) => (val === null ? null : parseFloat(val)));

// node-postgres's default parser for DATE (OID 1082) — used by every TimescaleDB hypertable's
// partition column (macro_asset_prices, stock_ohlcv, confluence_signals, ...) since
// create_hypertable requires a real date/timestamp type — builds a JS Date object. Every other
// "date" column in this schema is TEXT and every consumer throughout the app (frontend included)
// treats a query result's date field as a plain string; superjson (this app's tRPC transformer)
// faithfully round-trips a real Date object to the client rather than stringifying it, so a raw
// `{date}` in JSX throws "Objects are not valid as a React child (found: [object Date])" the
// instant that query actually resolves with data — confirmed live 2026-08-07 via
// MarketMoodGauge.tsx reading macro_asset_prices.date, caught by TabErrorBoundary and shown as
// "Service temporarily unavailable" (not an actual outage). Keep DATE as the raw 'YYYY-MM-DD'
// wire string, matching every TEXT-date column's existing behavior, instead of adding a
// timezone-shift risk on top by parsing to a Date and reformatting per-callsite.
types.setTypeParser(types.builtins.DATE, (val) => val);

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    // Inside the vitest `unit` project, vitest.globalSetup.ts has already created a private
    // throwaway schema and applied db/schema.postgres.sql into it. Pinning search_path on the
    // POOL (not per-query) is what makes the isolation unconditional: every unqualified name in
    // every query, from any call site, resolves inside the throwaway schema first and can only
    // shadow a production table, never write to one. `public` stays on the path so pg_trgm and
    // timescaledb types still resolve. Mirrors conftest.py's pg_schema fixture exactly.
    const schema = vitestSchema();
    pool = new Pool({
      connectionString: schema ? (process.env.VITEST_PG_URL || pgConnectionString()) : pgConnectionString(),
      ...(schema ? { options: `-c search_path="${schema}",public` } : {}),
      // Budget: bharat-server 22 + alphaquant 5 + ml-api 5 + chatbot 3 + Python 10 = 45 / 60 max_connections
      max: Number(process.env.PG_POOL_MAX ?? 22),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,  // more resilient to startup spikes
    });
    pool.on('error', (err) => console.error('[PG] idle client error:', err.message));
  }
  return pool;
}

/** True for transient pool/socket errors where the query never reached the server. */
function isTransientConnError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  // 53300 "too many clients already": under load (unit + live vitest projects co-running with
  // the four pm2 services against one Postgres) new connections are briefly refused -- same
  // shape as the connection-terminated case below, safe to retry because SELECTs are
  // idempotent and pgExecute's caller decides for writes.
  return /connection terminated|connection timeout|ECONNRESET|ETIMEDOUT|Client has encountered a connection error|server closed the connection|too many clients already/i.test(
    msg,
  );
}

/**
 * Run a parameterised query ($1,$2,...). Returns the full result rows.
 *
 * Read-only path (backs dbGet/dbAll). At market-open bursts the shared Postgres
 * (max_connections=50, split across all PM2 services + spawned Python) can briefly
 * refuse a new connection, surfacing as "Connection terminated". Retry once on those
 * transient errors only — safe here because SELECTs are idempotent.
 */
export async function pgQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  // Retry up to 3 times on transient connection errors (PG restart, ECONNRESET, pool timeout).
  // Backoff: 300ms → 1s → 3s — gives PG container ~4s to come back after an OOM restart.
  const delays = [300, 1000, 3000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await getPool().query<T>(text, params as any[]);
      return res.rows;
    } catch (err) {
      if (!isTransientConnError(err)) throw err;
      lastErr = err;
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  throw lastErr;
}

/** Run a query and return the raw result (for rowCount / RETURNING handling). */
export async function pgExecute(text: string, params: unknown[] = []) {
  // Single retry for writes — safe only for idempotent INSERT/UPDATE; caller decides.
  try {
    return await getPool().query(text, params as any[]);
  } catch (err) {
    if (!isTransientConnError(err)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return getPool().query(text, params as any[]);
  }
}

/** Acquire a client for an explicit transaction; caller MUST release. */
export async function pgClient(): Promise<PoolClient> {
  return getPool().connect();
}

/**
 * Acquire a client, run `fn`, and release unconditionally.
 * Prefer this over the raw `pgClient()` export for all explicit transactions.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

let _columnsEnsured = false;

/**
 * Schema version as tracked by `_migrations` (created by db/schema.postgres.sql). Distinct from
 * the SQLite side's `runMigration()` audit trail in db.ts, which this mirrors. Read this instead
 * of assuming the live schema matches any particular commit — see pgEnsureColumns below for why
 * that assumption has broken in the past (technical_signals.fcf_yield_approx incident).
 */
export async function pgSchemaVersion(): Promise<{ appliedCount: number; latest: string | null }> {
  const rows = await pgQuery<{ name: string }>('SELECT name FROM "_migrations" ORDER BY applied_at DESC LIMIT 1');
  const countRow = await pgQuery<{ n: number }>('SELECT COUNT(*)::int as n FROM "_migrations"');
  return { appliedCount: countRow[0]?.n ?? 0, latest: rows[0]?.name ?? null };
}

/**
 * Idempotent column guard: ensures columns added after the initial DB creation
 * exist in the live Postgres instance. Safe to run on every startup (IF NOT EXISTS).
 * Only called when USE_POSTGRES=true, after the pool is healthy.
 *
 * ALTERs are tracked against the `_migrations` table (already created by
 * db/schema.postgres.sql but previously unused on the Postgres path — every restart blind-ran
 * all ~90 ALTER statements and silently swallowed "already exists" errors, so there was no way
 * to tell what schema state a running server was actually on. That gap is exactly how
 * technical_signals.fcf_yield_approx drifted between db.ts and schema.postgres.sql for a day
 * (see CLAUDE.md's migration-066 note) — nothing recorded that the column had ever been added.
 * Now each ALTER runs at most once per fresh DB and is recorded, matching the SQLite side's
 * runMigration() pattern; pgSchemaVersion() gives a queryable schema state for ops/CI checks.
 *
 * As of 2026-07-24, node-pg-migrate is the tool for NEW schema changes (see migrations/ and the
 * npm run migrate:* scripts) — do not add new entries to `creates`/`alters` below; write a
 * migration instead. This function and its existing entries stay as-is (idempotent, harmless)
 * for schema predating that adoption.
 */
export async function pgEnsureColumns(): Promise<void> {
  if (_columnsEnsured) return;
  _columnsEnsured = true;

  // Create tables that may not exist yet (idempotent)
  const creates = [
    `CREATE TABLE IF NOT EXISTS mc_sector_earnings (
       sector_name TEXT PRIMARY KEY,
       market_np_yoy DOUBLE PRECISION,
       earnings_breadth DOUBLE PRECISION,
       updated_at TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS feature_store (
       symbol TEXT, date DATE, timeframe TEXT,
       PRIMARY KEY (symbol, date, timeframe)
     )`,
    `CREATE TABLE IF NOT EXISTS market_regimes (
       date TEXT PRIMARY KEY,
       regime TEXT,
       regime_prob DOUBLE PRECISION
     )`,
    `CREATE TABLE IF NOT EXISTS early_hours_predictions (
       symbol TEXT NOT NULL,
       date TEXT NOT NULL,
       score DOUBLE PRECISION NOT NULL,
       iep_gap_pct DOUBLE PRECISION,
       preopen_imbalance DOUBLE PRECISION,
       delivery_spike_pct DOUBLE PRECISION,
       has_corporate_action INTEGER DEFAULT 0,
       corporate_action_title TEXT,
       breakout_signals TEXT,
       reasons_json TEXT,
       computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (symbol, date)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ehp_date ON early_hours_predictions(date DESC)`,
    `CREATE TABLE IF NOT EXISTS intraday_breadth_snapshots (
       snapshot_at TEXT PRIMARY KEY,
       date TEXT,
       adv INTEGER, dec INTEGER, unch INTEGER, total INTEGER,
       adv_decline_ratio DOUBLE PRECISION,
       pct_positive DOUBLE PRECISION,
       avg_change_pct DOUBLE PRECISION,
       breadth_score DOUBLE PRECISION,
       risk_tilt TEXT,
       computed_at TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ibs_date ON intraday_breadth_snapshots(date DESC)`,
    `CREATE TABLE IF NOT EXISTS intraday_recommendations (
       symbol TEXT, computed_at TEXT, intraday_regime TEXT,
       intraday_score DOUBLE PRECISION, conviction_level TEXT, classification TEXT,
       screener_score DOUBLE PRECISION, breakout_score DOUBLE PRECISION,
       news_sentiment DOUBLE PRECISION,
       bullish_count INTEGER, bearish_count INTEGER,
       cmp DOUBLE PRECISION, entry_price DOUBLE PRECISION, stop_loss DOUBLE PRECISION,
       target_1 DOUBLE PRECISION, risk_reward DOUBLE PRECISION, position_size_pct DOUBLE PRECISION,
       reasoning TEXT, computed_ts TIMESTAMP,
       PRIMARY KEY (symbol, computed_at)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_intraday_recs_score ON intraday_recommendations(computed_at DESC, intraday_score DESC)`,
    `CREATE TABLE IF NOT EXISTS intraday_recommendations_history (
       symbol TEXT NOT NULL, computed_at TEXT NOT NULL, cycle_at TEXT NOT NULL,
       intraday_regime TEXT, intraday_score DOUBLE PRECISION, conviction_level TEXT,
       classification TEXT, screener_score DOUBLE PRECISION, breakout_score DOUBLE PRECISION,
       news_sentiment DOUBLE PRECISION, bullish_count INTEGER, bearish_count INTEGER,
       cmp DOUBLE PRECISION, entry_price DOUBLE PRECISION, stop_loss DOUBLE PRECISION,
       target_1 DOUBLE PRECISION, risk_reward DOUBLE PRECISION, position_size_pct DOUBLE PRECISION,
       PRIMARY KEY (symbol, cycle_at)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_irh_symbol_date ON intraday_recommendations_history(symbol, computed_at, cycle_at)`,
    // Append-only point-in-time snapshot of unified_recommendations. That table is keyed
    // (symbol, computed_at) on a bare DATE, so a same-day re-run replaces the morning's row and
    // destroys the only evidence of what was said before the open. See migration
    // 1786940000000 for the measured consequence (37 dates, 1 gradeable).
    `CREATE TABLE IF NOT EXISTS unified_recommendations_history (
       symbol TEXT NOT NULL, computed_at TEXT NOT NULL, generated_at TIMESTAMPTZ NOT NULL,
       regime TEXT, unified_score DOUBLE PRECISION, conviction_level TEXT, classification TEXT,
       screener_stock_score DOUBLE PRECISION, ml_score DOUBLE PRECISION,
       confluence_score DOUBLE PRECISION, technical_score DOUBLE PRECISION,
       cs_score DOUBLE PRECISION, breakout_score DOUBLE PRECISION,
       smart_money_score DOUBLE PRECISION, fundamental_score DOUBLE PRECISION,
       engine_coverage_count INTEGER, entry_zone_low DOUBLE PRECISION,
       stop_loss DOUBLE PRECISION, target_1 DOUBLE PRECISION,
       position_size_pct DOUBLE PRECISION, sector TEXT,
       PRIMARY KEY (symbol, generated_at)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_urh_computed_generated ON unified_recommendations_history(computed_at, generated_at)`,
    // Point-in-time snapshot of quant_scores. quant_scores is PRIMARY KEY (symbol) with no date
    // column, so every run overwrites it -- without this, its history is unrecoverable and the
    // canonical ranker cannot be backfilled. Written by snapshotQuantScores() at the end of the
    // quant-scoring job; snapshot_date is MAX(date) FROM stock_ohlcv, not a wall clock.
    `CREATE TABLE IF NOT EXISTS quant_scores_history (
       symbol TEXT NOT NULL,
       snapshot_date TEXT NOT NULL,
       return_1m DOUBLE PRECISION,
       return_3m DOUBLE PRECISION,
       return_6m DOUBLE PRECISION,
       return_12m DOUBLE PRECISION,
       above_sma200 BIGINT,
       sma200_distance_pct DOUBLE PRECISION,
       momentum_score DOUBLE PRECISION,
       annualized_vol DOUBLE PRECISION,
       sharpe_ratio DOUBLE PRECISION,
       max_drawdown_1y DOUBLE PRECISION,
       vol_rank DOUBLE PRECISION,
       sharpe_rank DOUBLE PRECISION,
       trailing_pe DOUBLE PRECISION,
       forward_pe DOUBLE PRECISION,
       debt_to_equity DOUBLE PRECISION,
       return_on_equity DOUBLE PRECISION,
       operating_margins DOUBLE PRECISION,
       revenue_growth DOUBLE PRECISION,
       piotroski_f_score BIGINT,
       valuation_score DOUBLE PRECISION,
       bullish_screener_count BIGINT,
       bearish_screener_count BIGINT,
       screener_category_breadth BIGINT,
       screener_net_score DOUBLE PRECISION,
       confluence_rank DOUBLE PRECISION,
       rank_momentum DOUBLE PRECISION,
       rank_quality DOUBLE PRECISION,
       rank_value DOUBLE PRECISION,
       rank_composite DOUBLE PRECISION,
       composite_class TEXT,
       ohlcv_days BIGINT,
       last_computed TIMESTAMPTZ,
       return_1w DOUBLE PRECISION,
       beta_1y DOUBLE PRECISION,
       beta_6m DOUBLE PRECISION,
       sortino_ratio DOUBLE PRECISION,
       var_95 DOUBLE PRECISION,
       mf_quality_score DOUBLE PRECISION,
       mf_momentum_score DOUBLE PRECISION,
       mf_value_score DOUBLE PRECISION,
       mf_risk_adj_score DOUBLE PRECISION,
       mf_macro_score DOUBLE PRECISION,
       mf_composite_score DOUBLE PRECISION,
       PRIMARY KEY (symbol, snapshot_date)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_qsh_snapshot_symbol ON quant_scores_history(snapshot_date, symbol)`,
    `CREATE TABLE IF NOT EXISTS intraday_recommendation_outcomes (
       symbol TEXT, computed_at TEXT, direction TEXT NOT NULL DEFAULT 'LONG',
       entry_price DOUBLE PRECISION, target_1 DOUBLE PRECISION, stop_loss DOUBLE PRECISION,
       day_high DOUBLE PRECISION, day_low DOUBLE PRECISION, day_close DOUBLE PRECISION,
       exit_price DOUBLE PRECISION, exit_reason TEXT, pnl_pct DOUBLE PRECISION, outcome TEXT,
       resolved_at TIMESTAMP,
       PRIMARY KEY (symbol, computed_at, direction)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_intraday_outcomes_date ON intraday_recommendation_outcomes(computed_at DESC)`,
    `CREATE TABLE IF NOT EXISTS intraday_strategy_lifts (
       as_of TEXT, dimension TEXT, bucket TEXT,
       n INTEGER, wins INTEGER, win_rate DOUBLE PRECISION, lift DOUBLE PRECISION,
       avg_pnl DOUBLE PRECISION,
       PRIMARY KEY (as_of, dimension, bucket)
     )`,
    `CREATE TABLE IF NOT EXISTS intraday_regime_history (
       computed_at TEXT PRIMARY KEY, date TEXT, regime TEXT,
       composite DOUBLE PRECISION, vix DOUBLE PRECISION, mmi DOUBLE PRECISION,
       usdinr_chg DOUBLE PRECISION, basis DOUBLE PRECISION, breadth_score DOUBLE PRECISION
     )`,
    `CREATE TABLE IF NOT EXISTS trendlyne_checklist (
       symbol TEXT PRIMARY KEY,
       score DOUBLE PRECISION,
       total BIGINT,
       yes_count BIGINT,
       insight TEXT,
       checklist_data TEXT,
       fetched_at TIMESTAMPTZ
     )`,
    // Append-only daily snapshot trail for signal_type_stats/signal_type_weights, which are
    // themselves overwrite-in-place (no history). A historical technical-signal rescan needs
    // to read win-rates/weights as they stood on the scan date, not today's latest -- see
    // loadSignalWinRates/loadLearnedWeights in technicalSignalsService.ts.
    `CREATE TABLE IF NOT EXISTS signal_type_stats_history (
       snapshot_date TEXT NOT NULL,
       signal_type TEXT NOT NULL,
       horizon_days BIGINT NOT NULL,
       market_regime TEXT NOT NULL DEFAULT 'ALL',
       total_occurrences BIGINT DEFAULT 0,
       win_count BIGINT DEFAULT 0,
       avg_return_pct DOUBLE PRECISION,
       median_return_pct DOUBLE PRECISION,
       win_rate DOUBLE PRECISION,
       PRIMARY KEY (snapshot_date, signal_type, horizon_days, market_regime)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_sts_hist_date ON signal_type_stats_history(snapshot_date DESC)`,
    `CREATE TABLE IF NOT EXISTS signal_type_weights_history (
       snapshot_date TEXT NOT NULL,
       signal_type TEXT NOT NULL,
       regime TEXT NOT NULL,
       sector TEXT NOT NULL DEFAULT 'ALL',
       weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
       sample_count BIGINT NOT NULL DEFAULT 0,
       PRIMARY KEY (snapshot_date, signal_type, regime, sector)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_stw_hist_date ON signal_type_weights_history(snapshot_date DESC)`,
    // ML win-probability per (run, symbol) from live_screener_ml_ranker.py (migration 071)
    `CREATE TABLE IF NOT EXISTS live_screener_ml_scores (
       run_id BIGINT NOT NULL,
       symbol TEXT NOT NULL,
       win_probability DOUBLE PRECISION NOT NULL,
       model_version TEXT,
       computed_at TIMESTAMPTZ DEFAULT now(),
       PRIMARY KEY (run_id, symbol)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_lsms_run ON live_screener_ml_scores(run_id)`,
    // Per-stock GDELT news tone (gdeltService.ts) — never had a canonical schema entry, so on
    // Postgres this table simply never existed and the ml_ensemble.py training-data join added
    // for it (COALESCE fallback for pre-finbert-coverage rows) would have failed at runtime.
    `CREATE TABLE IF NOT EXISTS gdelt_sentiment (
       symbol TEXT NOT NULL,
       date TEXT NOT NULL,
       avg_tone DOUBLE PRECISION,
       computed_at TEXT,
       PRIMARY KEY (symbol, date)
     )`,
  ];
  const client = await getPool().connect();
  try {
  for (const sql of creates) {
    try { await client.query(sql); } catch { /* ignore */ }
  }

  const alters = [
    // nse_stocks surveillance flags (added in SQLite migration 052)
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS is_asm              BIGINT DEFAULT 0`,
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS gsm_stage           BIGINT DEFAULT 0`,
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS surveillance_updated_at TEXT`,
    // nse_stocks index membership flags (migration 063)
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS is_nifty50          BIGINT DEFAULT 0`,
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS is_nifty100         BIGINT DEFAULT 0`,
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS is_nifty200         BIGINT DEFAULT 0`,
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS is_midcap150        BIGINT DEFAULT 0`,
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS is_smallcap250      BIGINT DEFAULT 0`,
    `ALTER TABLE nse_stocks ADD COLUMN IF NOT EXISTS index_flags_updated_at TEXT`,
    // fundamentals_history pledge snapshot (migration 063)
    `ALTER TABLE fundamentals_history ADD COLUMN IF NOT EXISTS pledge_pct DOUBLE PRECISION`,
    // technical_signals new feature columns (migrations 060, 061, 062, 063)
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS hv_10d               DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS hv_20d               DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS hv_30d               DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS hv_60d               DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS iv_hv_ratio          DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_revision_3m_pct  DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS target_revision_3m_pct DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS analyst_count_chg    BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS rs_vs_sector_21d     DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS rs_vs_sector_63d     DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS asm_flag             BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS gsm_stage            BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS crude_corr_90d       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS gold_corr_90d        DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS dxy_corr_90d         DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS sp500_corr_90d       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_broker_buy_7d     BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_broker_sell_7d    BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_broker_upside     DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS days_to_next_results BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_category_yoy BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_category_qoq BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_np_growth_yoy DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_np_growth_qoq DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_shocker_flag BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_shocker_gain DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS is_nifty50           BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS is_nifty100          BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS is_nifty200          BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS is_midcap150         BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS is_smallcap250       BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS nifty_tier           BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pledge_chg_90d       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS iep_gap_pct          DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS preopen_imbalance    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS expected_move_pct    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS stock_gex_proxy      DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_funds_adding      BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_funds_trimming    BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_add_trim_ratio    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_pct               DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS promoter_chg_qoq     DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fii_chg_qoq          DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_chg_qoq           DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pledge_chg_qoq       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_avg_pct_assets    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_big_fund_flow     DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_flow_vs_sector    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_flow_rank         DOUBLE PRECISION`,
    // migration 064 — earnings quality, insider, macro wave
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_surprise_q1       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_surprise_q2       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_beat_streak       BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_miss_after_streak BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS rev_surprise_q1       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_yield             DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS interest_coverage     DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_positive          BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS debt_coverage_risk    BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS delivery_trend_30d    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS block_deal_flag       BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS block_deal_direction  BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS short_interest_proxy  DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS promoter_buy_90d_cr   DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS promoter_sell_90d_cr  DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS promoter_net_90d      DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS insider_buy_flag      BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS insider_sell_flag     BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS rating_upgrade_180d   BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS rating_downgrade_180d BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS days_since_upgrade    BIGINT`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_sector_flow_pct   DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS receivables_days_ttm  DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ccc_ttm               DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ccc_trend             DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS wc_deteriorating      BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS wc_improving          BIGINT DEFAULT 0`,
    // migration 065 — PEAD + BSE event classifier scores
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pead_score            DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS event_signal_score    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS event_type_flags      TEXT`,
    // breakout classifier (Lever #4) — cross-sectional P(>=6% move in next 10 trading days)
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS breakout_probability  DOUBLE PRECISION`,
    // MoneyControl technical scanners + rating (forward-capture alt-data features)
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_bullish_scan_count BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_scan_52w_high      BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_scan_squeeze_bo    BIGINT DEFAULT 0`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_tech_rating        BIGINT`,
    // migration 066 (2026-07-04 trendlyne-fetch-rationalization) — fcf_yield_approx
    // superseded fcf_yield (Task 11) but this file wasn't updated when db.ts/
    // schema.postgres.sql were, leaving live Postgres without the column for a day
    // until ml_ensemble.py --score started throwing UndefinedColumn. Keep this file
    // in sync with db.ts's ALTER block whenever a migration touches Postgres-backed tables.
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_yield_approx      DOUBLE PRECISION`,
    // Extra endpoints features (parsed from indiatimes/marketsmojo/trading80)
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_fii_holding_pct   DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_dii_holding_pct   DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_fii_qoq_chg       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_dii_qoq_chg       DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_t80_tech_score    DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_t80_quality_rank  DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_t80_valuation_rank DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_t80_financial_pts  DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_mojo_quality_rank  DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_mojo_valuation_rank DOUBLE PRECISION`,
    `ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS ext_mojo_financial_pts DOUBLE PRECISION`,
    `ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS cfi_ttm            DOUBLE PRECISION`,
    `ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS fcf_ttm_approx     DOUBLE PRECISION`,
    `ALTER TABLE tl_financial_quality ADD COLUMN IF NOT EXISTS fcf_yield_approx   DOUBLE PRECISION`,
    // New quant_scores risk and multi-factor columns (migration 053)
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS beta_1y            DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS beta_6m            DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS sortino_ratio      DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS var_95             DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS mf_quality_score   DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS mf_momentum_score  DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS mf_value_score     DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS mf_risk_adj_score  DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS mf_macro_score     DOUBLE PRECISION`,
    `ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS mf_composite_score DOUBLE PRECISION`,
    // intraday_recommendations news-sentiment feature (added after the table's initial creation)
    `ALTER TABLE intraday_recommendations ADD COLUMN IF NOT EXISTS news_sentiment DOUBLE PRECISION`,
    // walk-forward optimization per-fold breakdown (run_walk_forward in backtester.py)
    `ALTER TABLE backtesting_runs ADD COLUMN IF NOT EXISTS walk_forward_folds_json TEXT`,
    // same-day return alongside the existing 1d/3d/5d EOD horizons (migration 070)
    `ALTER TABLE live_screener_outcomes ADD COLUMN IF NOT EXISTS return_intraday DOUBLE PRECISION`,
    // todos ownership column — closes an unauthenticated-CRUD gap (todo.router.ts now scopes
    // every read/write to ctx.uid via protectedProcedure)
    `ALTER TABLE todos ADD COLUMN IF NOT EXISTS "userId" TEXT`,
    // CHECK constraint (structural guard, not a column) — root cause: trendlyne_screener_
    // discovery.py had a blind "column 0" fallback when no table header matched nsecode/
    // symbol, and for some screeners column 0 is the stock-name/profile-link column —
    // writing a raw Trendlyne URL into `symbol` (~2M rows in confluence_signals, ~79K in
    // unified_recommendations, plus smaller counts in stock_scores/stock_factor_breakdown/
    // stock_factor_breakdown_history/recommendation_log/intraday_recommendations, all
    // sourced from THIS table). The writer is fixed and all known-bad rows purged
    // (2026-07-23); this constraint makes the bug class structurally impossible at its
    // actual source regardless of which reader (present or future) trusts it.
    // NOTE: the same constraint on confluence_signals was NOT added — it's a compressed
    // TimescaleDB hypertable and Postgres refuses ADD CONSTRAINT on those without first
    // decompressing every chunk (a heavy operation on 2M+ rows, not done without a explicit
    // go-ahead). confluence_signals is defended instead by: (a) this upstream constraint
    // (its only writer, confluenceEngine.ts, sources symbols exclusively from this table and
    // the other screener-membership tables, none of which were found contaminated), and
    // (b) the symbol NOT LIKE '%://%' read-side guards in unified_ranker.py's
    // _get_confluence_scores/_get_confluence_latest_map.
    `ALTER TABLE trendlyne_screener_stocks ADD CONSTRAINT chk_tl_screener_stocks_symbol_not_url CHECK (symbol IS NULL OR symbol NOT LIKE '%://%')`,
  ];

  await client.query(`CREATE TABLE IF NOT EXISTS "_migrations" (
    "name" TEXT PRIMARY KEY,
    "applied_at" TIMESTAMPTZ DEFAULT now()
  )`);
  const applied = new Set(
    (await client.query('SELECT name FROM "_migrations"')).rows.map((r: { name: string }) => r.name),
  );

  // Run each ALTER individually — Postgres can't do multiple DDL in one statement. Skip ones
  // already recorded in _migrations so a warm restart doesn't re-issue ~90 ALTERs every time.
  for (const sql of alters) {
    const name = alterMigrationName(sql);
    if (applied.has(name)) continue;
    try {
      await client.query(sql);
      await client.query('INSERT INTO "_migrations" (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42701' || code === '42710') {
        // 42701 = column already exists (pre-fix blind ALTER), 42710 = constraint already
        // exists — either way, record it now so future boots skip it.
        await client.query('INSERT INTO "_migrations" (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]).catch(() => {});
      } else {
        console.error('[PG] pgEnsureColumns failed:', (err as Error).message, '|', sql);
      }
    }
  }
  } finally {
    client.release();
  }
}

/** Derives a stable, human-readable _migrations name from an `ALTER TABLE t ADD COLUMN IF NOT EXISTS c ...`
 *  or `ALTER TABLE t ADD CONSTRAINT name ...` statement. */
export function alterMigrationName(sql: string): string {
  const addColumn = sql.match(/ALTER TABLE (\S+) ADD COLUMN IF NOT EXISTS (\S+)/i);
  if (addColumn) return `alter_${addColumn[1]}_${addColumn[2]}`;
  const addConstraint = sql.match(/ALTER TABLE (\S+) ADD CONSTRAINT (\S+)/i);
  if (addConstraint) return `alter_${addConstraint[1]}_${addConstraint[2]}`;
  throw new Error(`alterMigrationName: unrecognized ALTER shape: ${sql}`);
}

export async function pgHealthy(): Promise<boolean> {
  try {
    await pgQuery('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
