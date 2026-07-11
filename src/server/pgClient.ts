/**
 * PostgreSQL connection pool (Phase 3).
 *
 * Lazily creates a single shared pool from pgConfig. Only used when USE_POSTGRES is on;
 * the dbAsync facade routes here. Kept separate from the facade so the pool lifecycle
 * (and a health probe) lives in one place.
 */
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { pgConnectionString } from './pgConfig';

// Parse Postgres BIGINT (INT8) as JavaScript numbers (safe up to 2^53 - 1)
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: pgConnectionString(),
      // Budget: bharat-server 15 + alphaquant 5 + ml-api 5 + chatbot 3 + Python 10 = 38 / 60 max_connections
      max: Number(process.env.PG_POOL_MAX ?? 15),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 8_000,  // fail fast — pgQuery retries with backoff so total wait is still ~4s
    });
    pool.on('error', (err) => console.error('[PG] idle client error:', err.message));
  }
  return pool;
}

/** True for transient pool/socket errors where the query never reached the server. */
function isTransientConnError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  return /connection terminated|connection timeout|ECONNRESET|ETIMEDOUT|Client has encountered a connection error|server closed the connection/i.test(
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
 * Idempotent column guard: ensures columns added after the initial DB creation
 * exist in the live Postgres instance. Safe to run on every startup (IF NOT EXISTS).
 * Only called when USE_POSTGRES=true, after the pool is healthy.
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
    `CREATE TABLE IF NOT EXISTS trendlyne_checklist (
       symbol TEXT PRIMARY KEY,
       score DOUBLE PRECISION,
       total BIGINT,
       yes_count BIGINT,
       insight TEXT,
       checklist_data TEXT,
       fetched_at TIMESTAMPTZ
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
  ];
  // Run each ALTER individually — Postgres can't do multiple DDL in one statement
  for (const sql of alters) {
    try {
      await client.query(sql);
    } catch (err) {
      // Column-already-exists (42701) is silently swallowed; real errors re-throw.
      if ((err as { code?: string }).code !== '42701') {
        console.error('[PG] pgEnsureColumns failed:', (err as Error).message, '|', sql);
      }
    }
  }
  } finally {
    client.release();
  }
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
