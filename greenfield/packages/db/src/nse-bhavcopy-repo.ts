// "Only db issues SQL. No SQL string in api or ingestion." (GREENFIELD_
// BUILD_SPEC.md A2 hard rules; B6 extends this explicitly to SELECTs, not
// just writes.) Every query the NSE bhavcopy adapter (packages/ingestion)
// needs lives here as a named, typed function -- ingestion calls these, it
// never opens its own client.query() with a raw SQL string. Business logic
// (parsing, threshold decisions, report formatting) stays in ingestion;
// only the SQL itself is centralized.
import type pg from 'pg';

export async function seedNseBhavcopyRegistry(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ('nse', 'NSE Archives', '{archives.nseindia.com}', 'none', 'permitted')
     ON CONFLICT (provider) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ('nse.bhavcopy', 'nse', 'ingestion',
             'https://archives.nseindia.com/products/content/sec_bhavdata_full_{DDMMYYYY}.csv', 'v1')
     ON CONFLICT (endpoint_key) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('nse.bhavcopy', 'NSE full bhavcopy backfill', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );
}

export interface RawObjectInput {
  runId: string;
  endpointKey: string;
  contentHash: string;
  httpStatus: number;
  contentType: string | null;
  byteSize: number;
  storageUri: string;
}

export async function insertRawObject(client: pg.ClientBase, input: RawObjectInput): Promise<void> {
  await client.query(
    `INSERT INTO raw_object
       (run_id, endpoint_key, request_hash, http_status, content_type, content_hash, byte_size, storage_uri, parse_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
    [input.runId, input.endpointKey, input.contentHash, input.httpStatus, input.contentType, input.contentHash, input.byteSize, input.storageUri],
  );
}

export async function markRawObjectParsed(client: pg.ClientBase, runId: string): Promise<void> {
  await client.query(`UPDATE raw_object SET parse_status = 'parsed' WHERE run_id = $1`, [runId]);
}

export async function seedSecurityFirstSighting(client: pg.ClientBase, symbol: string, listedFrom: string): Promise<void> {
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status, listed_from)
     VALUES ($1, $1, 'NSE', 'listed', $2)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol, listedFrom],
  );
}

export interface MarketBarInput {
  symbol: string;
  sessionDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  prevClose: number | null;
  volume: number | null;
  trades: number | null;
  turnover: number | null;
  vwap: number | null;
  availableAt: string;
  runId: string;
}

export async function upsertMarketBar(client: pg.ClientBase, row: MarketBarInput): Promise<void> {
  await client.query(
    `INSERT INTO market_bar
       (symbol, session_date, interval, source, open, high, low, close, prev_close, volume, trades, turnover, vwap, available_at, run_id)
     VALUES ($1, $2, '1d', 'nse', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (symbol, session_date, interval, source) DO NOTHING`,
    [row.symbol, row.sessionDate, row.open, row.high, row.low, row.close, row.prevClose, row.volume, row.trades, row.turnover, row.vwap, row.availableAt, row.runId],
  );
}

export interface DeliveryStatInput {
  symbol: string;
  sessionDate: string;
  deliveryQty: number | null;
  deliveryPct: number | null;
  availableAt: string;
  runId: string;
}

export async function upsertDeliveryStat(client: pg.ClientBase, row: DeliveryStatInput): Promise<void> {
  await client.query(
    `INSERT INTO delivery_stat (symbol, session_date, source, delivery_qty, delivery_pct, available_at, run_id)
     VALUES ($1, $2, 'nse', $3, $4, $5, $6)
     ON CONFLICT (symbol, session_date, source) DO NOTHING`,
    [row.symbol, row.sessionDate, row.deliveryQty, row.deliveryPct, row.availableAt, row.runId],
  );
}

// Bulk variants: a real trading day can carry ~1,900 accepted rows, and the
// per-row functions above issue 3 sequential round trips each (~5,700/day).
// At that rate the full 2021-present backfill (~1,435 real trading days)
// would take the better part of a day. These batch a whole day's rows into
// ONE round trip per table via unnest() -- the columns that are constant for
// the whole batch (session_date, source, run_id, ...) are passed as scalars
// and cross-joined against the per-row arrays, not repeated per row.

export async function bulkSeedSecurityFirstSighting(
  client: pg.ClientBase, symbols: string[], listedFrom: string,
): Promise<void> {
  if (symbols.length === 0) return;
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status, listed_from)
     SELECT symbol, symbol, 'NSE', 'listed', $2::date
     FROM unnest($1::text[]) AS t(symbol)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbols, listedFrom],
  );
}

export async function bulkUpsertMarketBar(
  client: pg.ClientBase, rows: MarketBarInput[], sessionDate: string, availableAt: string, runId: string,
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO market_bar
       (symbol, session_date, interval, source, open, high, low, close, prev_close, volume, trades, turnover, vwap, available_at, run_id)
     SELECT symbol, $2::date, '1d', 'nse', open, high, low, close, prev_close, volume, trades, turnover, vwap, $12::timestamptz, $13::uuid
     FROM unnest($1::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[],
                  $8::bigint[], $9::bigint[], $10::numeric[], $11::numeric[])
       AS t(symbol, open, high, low, close, prev_close, volume, trades, turnover, vwap)
     ON CONFLICT (symbol, session_date, interval, source) DO NOTHING`,
    [
      rows.map((r) => r.symbol), sessionDate,
      rows.map((r) => r.open), rows.map((r) => r.high), rows.map((r) => r.low), rows.map((r) => r.close),
      rows.map((r) => r.prevClose), rows.map((r) => r.volume), rows.map((r) => r.trades),
      rows.map((r) => r.turnover), rows.map((r) => r.vwap), availableAt, runId,
    ],
  );
}

export async function bulkUpsertDeliveryStat(
  client: pg.ClientBase, rows: DeliveryStatInput[], sessionDate: string, availableAt: string, runId: string,
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO delivery_stat (symbol, session_date, source, delivery_qty, delivery_pct, available_at, run_id)
     SELECT symbol, $2::date, 'nse', delivery_qty, delivery_pct, $5::timestamptz, $6::uuid
     FROM unnest($1::text[], $3::bigint[], $4::float8[]) AS t(symbol, delivery_qty, delivery_pct)
     ON CONFLICT (symbol, session_date, source) DO NOTHING`,
    [
      rows.map((r) => r.symbol), sessionDate,
      rows.map((r) => r.deliveryQty), rows.map((r) => r.deliveryPct), availableAt, runId,
    ],
  );
}

export async function upsertTradingSession(
  client: pg.ClientBase,
  exchange: string,
  sessionDate: string,
  openAt: string,
  closeAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO trading_session (exchange, session_date, open_at, close_at, is_holiday)
     VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (exchange, session_date) DO NOTHING`,
    [exchange, sessionDate, openAt, closeAt],
  );
}

export async function isRunAlreadyCompleted(pool: pg.Pool, jobId: string, outputWatermark: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM ingestion_run
     WHERE job_id = $1 AND output_watermark = $2 AND status IN ('succeeded', 'skipped')
     LIMIT 1`,
    [jobId, outputWatermark],
  );
  return rows.length > 0;
}

export async function setRunErrorSummary(client: pg.ClientBase, runId: string, summary: string): Promise<void> {
  await client.query(`UPDATE ingestion_run SET error_summary = $1 WHERE run_id = $2`, [summary, runId]);
}

export interface SecurityMasterSpanRow {
  latestSession: string | null;
  symbolsUpdated: number;
}

export async function deriveSecurityMasterFromMarketBar(pool: pg.Pool, source: string = 'nse'): Promise<SecurityMasterSpanRow> {
  const { rows: latestRows } = await pool.query<{ latest: string | null }>(
    `SELECT MAX(session_date)::text AS latest FROM market_bar WHERE source = $1`,
    [source],
  );
  const latestSession = latestRows[0]?.latest ?? null;
  if (!latestSession) {
    return { latestSession: null, symbolsUpdated: 0 };
  }

  const { rowCount } = await pool.query(
    `WITH spans AS (
       SELECT symbol, MIN(session_date) AS first_seen, MAX(session_date) AS last_seen
       FROM market_bar
       WHERE source = $2
       GROUP BY symbol
     )
     UPDATE security s
     SET listed_from = spans.first_seen,
         listed_to = CASE WHEN spans.last_seen = $1::date THEN NULL ELSE spans.last_seen END,
         status = (CASE WHEN spans.last_seen = $1::date THEN 'listed' ELSE 'delisted' END)::security_status,
         updated_at = now()
     FROM spans
     WHERE s.symbol = spans.symbol`,
    [latestSession, source],
  );

  return { latestSession, symbolsUpdated: rowCount ?? 0 };
}

// ── DQ check queries (Task 2.4) ─────────────────────────────────────────────

export async function queryDqCheckFreshnessThresholds(pool: pg.Pool, checkId: string): Promise<{ warnDays: number; failDays: number }> {
  const { rows } = await pool.query<{ warn_days: number | null; fail_days: number | null }>(
    `SELECT warn_days, fail_days FROM dq_check WHERE check_id = $1`,
    [checkId],
  );
  return { warnDays: rows[0]?.warn_days ?? 1, failDays: rows[0]?.fail_days ?? 3 };
}

export async function queryDqCheckSpec<T>(pool: pg.Pool, checkId: string, fallback: T): Promise<T> {
  const { rows } = await pool.query<{ spec: T }>(`SELECT spec FROM dq_check WHERE check_id = $1`, [checkId]);
  return rows[0]?.spec ?? fallback;
}

export async function queryLatestSessionWeekdayGap(pool: pg.Pool, exchange: string = 'NSE'): Promise<{ latestSession: string | null; weekdayGap: number }> {
  const { rows } = await pool.query<{ latest_session: string | null; weekday_gap: number }>(
    `WITH latest AS (
       SELECT MAX(session_date) AS latest_session FROM trading_session WHERE exchange = $1
     ),
     today_ref AS (
       SELECT CASE EXTRACT(ISODOW FROM CURRENT_DATE)
         WHEN 6 THEN CURRENT_DATE - 1
         WHEN 7 THEN CURRENT_DATE - 2
         ELSE CURRENT_DATE
       END AS ref_date
     )
     SELECT latest.latest_session::text,
       COALESCE((
         SELECT count(*) FROM generate_series(latest.latest_session + 1, today_ref.ref_date, interval '1 day') d
         WHERE EXTRACT(ISODOW FROM d) < 6
       ), 0)::int AS weekday_gap
     FROM latest, today_ref`,
    [exchange],
  );
  return { latestSession: rows[0]?.latest_session ?? null, weekdayGap: rows[0]?.weekday_gap ?? 0 };
}

export async function queryLatestSessionSymbolCount(pool: pg.Pool, source: string = 'nse'): Promise<{ sessionDate: string | null; symbolCount: number }> {
  const { rows } = await pool.query<{ session_date: string | null; n: number }>(
    `SELECT MAX(session_date)::text AS session_date, count(DISTINCT symbol)::int AS n
     FROM market_bar WHERE source = $1 AND session_date = (SELECT MAX(session_date) FROM market_bar WHERE source = $1)`,
    [source],
  );
  return { sessionDate: rows[0]?.session_date ?? null, symbolCount: rows[0]?.n ?? 0 };
}

export async function queryAvgRejectRate(pool: pg.Pool, jobId: string): Promise<{ avgRate: number | null; runsEvaluated: number }> {
  const { rows } = await pool.query<{ avg_rate: number | null; n: number }>(
    `SELECT AVG(rows_rejected::float8 / NULLIF(rows_seen, 0))::float8 AS avg_rate, count(*)::int AS n
     FROM ingestion_run WHERE job_id = $1 AND status = 'succeeded'`,
    [jobId],
  );
  return { avgRate: rows[0]?.avg_rate ?? null, runsEvaluated: rows[0]?.n ?? 0 };
}

export async function queryOhlcSanityViolations(pool: pg.Pool, source: string = 'nse'): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM market_bar
     WHERE source = $1 AND (close <= 0 OR (high IS NOT NULL AND low IS NOT NULL AND high < low))`,
    [source],
  );
  return rows[0]?.n ?? 0;
}

export async function queryDeliveryPctViolations(pool: pg.Pool, source: string = 'nse'): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM delivery_stat
     WHERE source = $1 AND delivery_pct IS NOT NULL AND (delivery_pct < 0 OR delivery_pct > 100)`,
    [source],
  );
  return rows[0]?.n ?? 0;
}

export async function queryLongestWeekdayCalendarGap(pool: pg.Pool, exchange: string = 'NSE'): Promise<{ gapLen: number; gapStart: string | null; gapEnd: string | null }> {
  const { rows } = await pool.query<{ gap_len: number | null; gap_start: string | null; gap_end: string | null }>(
    `WITH bounds AS (
       SELECT MIN(session_date) AS d0, MAX(session_date) AS d1 FROM trading_session WHERE exchange = $1
     ),
     weekdays AS (
       SELECT d::date AS d, row_number() OVER (ORDER BY d::date) AS wd_ord
       FROM bounds, generate_series(d0, d1, interval '1 day') d
       WHERE bounds.d0 IS NOT NULL AND EXTRACT(ISODOW FROM d) < 6
     ),
     missing AS (
       SELECT w.d, w.wd_ord FROM weekdays w
       LEFT JOIN trading_session ts ON ts.exchange = $1 AND ts.session_date = w.d
       WHERE ts.session_date IS NULL
     ),
     grp AS (
       SELECT d, wd_ord - row_number() OVER (ORDER BY wd_ord) AS grp_key FROM missing
     )
     SELECT count(*)::int AS gap_len, MIN(d)::text AS gap_start, MAX(d)::text AS gap_end
     FROM grp GROUP BY grp_key ORDER BY gap_len DESC LIMIT 1`,
    [exchange],
  );
  const row = rows[0];
  return { gapLen: row?.gap_len ?? 0, gapStart: row?.gap_start ?? null, gapEnd: row?.gap_end ?? null };
}

// ── Coverage report queries (Task 2.5) ──────────────────────────────────────

export async function queryPerYearCoverage(pool: pg.Pool, source: string = 'nse'): Promise<Array<{ year: number; distinctSessions: number; distinctSymbols: number }>> {
  const { rows } = await pool.query<{ year: number; distinct_sessions: number; distinct_symbols: number }>(
    `SELECT EXTRACT(YEAR FROM session_date)::int AS year,
            count(DISTINCT session_date)::int AS distinct_sessions,
            count(DISTINCT symbol)::int AS distinct_symbols
     FROM market_bar WHERE source = $1
     GROUP BY 1 ORDER BY 1`,
    [source],
  );
  return rows.map((r) => ({ year: r.year, distinctSessions: r.distinct_sessions, distinctSymbols: r.distinct_symbols }));
}

export async function queryPerSymbolSessionSpan(pool: pg.Pool, source: string = 'nse'): Promise<{ min: number; median: number; max: number }> {
  const { rows } = await pool.query<{ min_n: number | null; median_n: number | null; max_n: number | null }>(
    `SELECT min(n)::int AS min_n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS median_n,
            max(n)::int AS max_n
     FROM (SELECT symbol, count(DISTINCT session_date) AS n FROM market_bar WHERE source = $1 GROUP BY symbol) t`,
    [source],
  );
  return {
    min: rows[0]?.min_n ?? 0,
    median: Math.round(rows[0]?.median_n ?? 0),
    max: rows[0]?.max_n ?? 0,
  };
}

export async function queryRejectedByReason(pool: pg.Pool, jobId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ key: string; n: string }>(
    `SELECT key, sum(value::int)::text AS n
     FROM ingestion_run, jsonb_each_text((error_summary::jsonb) -> 'rejectReasons')
     WHERE job_id = $1 AND error_summary IS JSON OBJECT
     GROUP BY key ORDER BY n DESC`,
    [jobId],
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.key] = Number(row.n);
  return out;
}

export async function insertDqResult(
  pool: pg.Pool,
  input: { checkId: string; status: string; detail: string; observed: unknown; runId: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO dq_result (check_id, status, detail, observed, run_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.checkId, input.status, input.detail, JSON.stringify(input.observed), input.runId],
  );
}

export async function querySecurityStatusCounts(pool: pg.Pool, source: string): Promise<{ listed: number; delisted: number }> {
  const { rows } = await pool.query<{ status: string; n: number }>(
    `SELECT status::text, count(*)::int AS n FROM security
     WHERE symbol IN (SELECT DISTINCT symbol FROM market_bar WHERE source = $1)
     GROUP BY status`,
    [source],
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.n;
  return { listed: out.listed ?? 0, delisted: out.delisted ?? 0 };
}
