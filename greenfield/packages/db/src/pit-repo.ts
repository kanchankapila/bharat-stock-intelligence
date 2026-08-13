// Task 4.2: point-in-time (PIT) read API. Feature-computation code (stage4/
// compute-features.ts) reads exclusively through these functions -- never
// issues raw SQL against market_bar/delivery_stat/fundamental_fact/
// market_flow/screener_membership directly. Functions return whole-panel
// series (not one symbol/date at a time): computing ~1,400 sessions x
// ~4,000 symbols one lookup at a time would be the exact O(dates x symbols)
// blowup Stage 2/3 already hit with per-row writes -- Postgres window
// functions do the momentum/moving-average work server-side in one pass
// instead.
import type pg from 'pg';

export interface MarketBarFeatureRow {
  symbol: string;
  sessionDate: string;
  close: number;
  isSuspect: boolean;
  momentum21d: number | null;
  momentum63d: number | null;
  adt252d: number | null;
  deliveryPct: number | null;
  deliveryPctMa20: number | null;
}

/** One row per (symbol, session_date) that actually traded, with momentum,
 * 252-session average daily turnover (the liquidity floor input), and
 * delivery stats already computed via window functions. is_suspect rows are
 * excluded up front (Task 4.2 mandatory rule 3). */
export async function queryMarketBarFeaturePanel(pool: pg.Pool, source = 'nse'): Promise<MarketBarFeatureRow[]> {
  const { rows } = await pool.query<{
    symbol: string; session_date: string; close: string; momentum_21d: string | null; momentum_63d: string | null;
    adt_252d: string | null; delivery_pct: string | null; delivery_pct_ma20: string | null;
  }>(
    `WITH bars AS (
       SELECT symbol, session_date, close, turnover
       FROM market_bar
       WHERE source = $1 AND is_suspect = false
     ),
     mom AS (
       SELECT symbol, session_date, close,
         close / NULLIF(LAG(close, 21) OVER w, 0) - 1 AS momentum_21d,
         close / NULLIF(LAG(close, 63) OVER w, 0) - 1 AS momentum_63d,
         AVG(turnover) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) AS adt_252d
       FROM bars
       WINDOW w AS (PARTITION BY symbol ORDER BY session_date)
     ),
     deliv AS (
       SELECT symbol, session_date, delivery_pct,
         AVG(delivery_pct) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS delivery_pct_ma20
       FROM delivery_stat
       WHERE source = $1
     )
     SELECT m.symbol, m.session_date::text, m.close::text,
            m.momentum_21d::text, m.momentum_63d::text, m.adt_252d::text,
            d.delivery_pct::text, d.delivery_pct_ma20::text
     FROM mom m
     LEFT JOIN deliv d ON d.symbol = m.symbol AND d.session_date = m.session_date
     ORDER BY m.symbol, m.session_date`,
    [source],
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    sessionDate: r.session_date,
    close: Number(r.close),
    isSuspect: false,
    momentum21d: r.momentum_21d !== null ? Number(r.momentum_21d) : null,
    momentum63d: r.momentum_63d !== null ? Number(r.momentum_63d) : null,
    adt252d: r.adt_252d !== null ? Number(r.adt_252d) : null,
    deliveryPct: r.delivery_pct !== null ? Number(r.delivery_pct) : null,
    deliveryPctMa20: r.delivery_pct_ma20 !== null ? Number(r.delivery_pct_ma20) : null,
  }));
}

export interface OpenPriceRow {
  symbol: string;
  sessionDate: string;
  open: number | null;
  adt252d: number | null;
}

/** Raw open prices + 252-session ADT (liquidity floor input) per (symbol,
 * session_date) that actually traded, is_suspect excluded. Used by the
 * research harness (Task 4.3/4.4) to compute forward returns at ANY
 * rebalance horizon by array-indexing N sessions ahead in TypeScript --
 * kept as raw opens rather than precomputed at a fixed horizon so the
 * harness's own --rebalance parameter isn't baked into the SQL layer. */
export async function queryOpenPriceSeries(pool: pg.Pool, source = 'nse'): Promise<OpenPriceRow[]> {
  const { rows } = await pool.query<{ symbol: string; session_date: string; open: string | null; adt_252d: string | null }>(
    `SELECT symbol, session_date::text, open::text,
       AVG(turnover) OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 251 PRECEDING AND CURRENT ROW)::text AS adt_252d
     FROM market_bar
     WHERE source = $1 AND is_suspect = false
     ORDER BY symbol, session_date`,
    [source],
  );
  return rows.map((r) => ({
    symbol: r.symbol, sessionDate: r.session_date,
    open: r.open !== null ? Number(r.open) : null,
    adt252d: r.adt_252d !== null ? Number(r.adt_252d) : null,
  }));
}

/** Every row with is_suspect=true, for Task 4.5's feature-suspect-exclusion
 * check to verify against independently of the panel query above (which
 * already excludes them at the source). */
export async function querySuspectMarketBarDates(pool: pg.Pool, source = 'nse'): Promise<Set<string>> {
  const { rows } = await pool.query<{ symbol: string; session_date: string }>(
    `SELECT symbol, session_date::text FROM market_bar WHERE source = $1 AND is_suspect = true`,
    [source],
  );
  return new Set(rows.map((r) => `${r.symbol}|${r.session_date}`));
}

export interface FundamentalAsOfPoint {
  symbol: string;
  availableAt: string;
  periodEnd: string;
  value: number;
}

/** Full point-in-time series for one metric, ordered so the caller can
 * binary-search "latest value with available_at <= facts_cutoff" per
 * symbol. Small tables (thousands to tens of thousands of rows) -- fetched
 * whole rather than joined per-date, which is both simpler and faster than
 * a LEAD-based validity-range SQL join for this size. */
export async function queryFundamentalAsOfSeries(pool: pg.Pool, metric: string, source: string): Promise<FundamentalAsOfPoint[]> {
  const { rows } = await pool.query<{ symbol: string; available_at: string; period_end: string; value: string }>(
    `SELECT symbol, available_at::text, period_end::text, value::text
     FROM fundamental_fact
     WHERE metric = $1 AND source = $2 AND value IS NOT NULL
     ORDER BY symbol, available_at`,
    [metric, source],
  );
  return rows.map((r) => ({ symbol: r.symbol, availableAt: r.available_at, periodEnd: r.period_end, value: Number(r.value) }));
}

export interface MarketFlowDay {
  flowDate: string;
  fiiNet: number | null;
  diiNet: number | null;
}

/** Market-wide (not per-symbol) daily FII/DII net -- the whole table is a
 * few thousand rows, fetched in full. */
export async function queryMarketFlowSeries(pool: pg.Pool, source = 'nse'): Promise<MarketFlowDay[]> {
  const { rows } = await pool.query<{ flow_date: string; fii_net: string | null; dii_net: string | null }>(
    `SELECT flow_date::text, fii_net::text, dii_net::text
     FROM market_flow WHERE source = $1 AND scope = 'market' AND segment = 'cash'
     ORDER BY flow_date`,
    [source],
  );
  return rows.map((r) => ({ flowDate: r.flow_date, fiiNet: r.fii_net !== null ? Number(r.fii_net) : null, diiNet: r.dii_net !== null ? Number(r.dii_net) : null }));
}

export interface ScreenerBreadthPoint {
  symbol: string;
  observedAt: string;
  breadth: number;
}

/** Distinct-screener count per (symbol, observed_at) snapshot. */
export async function queryScreenerBreadthSeries(pool: pg.Pool, provider = 'trendlyne'): Promise<ScreenerBreadthPoint[]> {
  const { rows } = await pool.query<{ symbol: string; observed_at: string; breadth: string }>(
    `SELECT symbol, observed_at::text, count(DISTINCT provider_id)::text breadth
     FROM screener_membership WHERE provider = $1
     GROUP BY symbol, observed_at
     ORDER BY symbol, observed_at`,
    [provider],
  );
  return rows.map((r) => ({ symbol: r.symbol, observedAt: r.observed_at, breadth: Number(r.breadth) }));
}

export async function queryTradingSessionDates(pool: pg.Pool, exchange = 'NSE'): Promise<string[]> {
  const { rows } = await pool.query<{ session_date: string }>(
    `SELECT session_date::text FROM trading_session WHERE exchange = $1 ORDER BY session_date`,
    [exchange],
  );
  return rows.map((r) => r.session_date);
}

export interface FeatureSnapshotInput {
  symbol: string;
  asOfSession: string;
  featureSetVersion: string;
  factsCutoff: string;
  values: Record<string, number | null>;
  coverage: number;
  runId: string;
}

export async function bulkInsertFeatureSnapshot(client: pg.ClientBase, rows: FeatureSnapshotInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO feature_snapshot (symbol, as_of_session, feature_set_version, facts_cutoff, values, coverage, run_id)
     SELECT symbol, session_date::date, fsv, cutoff::timestamptz, vals::jsonb, cov::float8, rid::uuid
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::float8[], $7::text[])
       AS t(symbol, session_date, fsv, cutoff, vals, cov, rid)
     ON CONFLICT (symbol, as_of_session, feature_set_version) DO NOTHING`,
    [
      rows.map((r) => r.symbol), rows.map((r) => r.asOfSession), rows.map((r) => r.featureSetVersion),
      rows.map((r) => r.factsCutoff), rows.map((r) => JSON.stringify(r.values)), rows.map((r) => r.coverage),
      rows.map((r) => r.runId),
    ],
  );
  return rowCount ?? 0;
}

export interface FeatureMetricPoint {
  symbol: string;
  asOfSession: string;
  value: number | null;
}

/** One metric's values extracted from every feature_snapshot row's JSONB
 * `values` blob -- the research harness (Task 4.3/4.4) reads factor series
 * through this rather than pulling the whole values object client-side. */
export async function queryFeatureSnapshotMetricSeries(pool: pg.Pool, metric: string, featureSetVersion = 'v1'): Promise<FeatureMetricPoint[]> {
  const { rows } = await pool.query<{ symbol: string; as_of_session: string; value: string | null }>(
    `SELECT symbol, as_of_session::text, (values ->> $1)::text AS value
     FROM feature_snapshot WHERE feature_set_version = $2`,
    [metric, featureSetVersion],
  );
  return rows.map((r) => ({ symbol: r.symbol, asOfSession: r.as_of_session, value: r.value !== null ? Number(r.value) : null }));
}

export async function queryFeatureSnapshotForSymbolSession(
  pool: pg.Pool, symbol: string, asOfSession: string, featureSetVersion = 'v1',
): Promise<{ values: Record<string, number | null>; coverage: number; factsCutoff: string } | null> {
  const { rows } = await pool.query<{ values: Record<string, number | null>; coverage: number; facts_cutoff: string }>(
    `SELECT values, coverage, facts_cutoff::text FROM feature_snapshot
     WHERE symbol = $1 AND as_of_session = $2 AND feature_set_version = $3`,
    [symbol, asOfSession, featureSetVersion],
  );
  const r = rows[0];
  return r ? { values: r.values, coverage: r.coverage, factsCutoff: r.facts_cutoff } : null;
}
