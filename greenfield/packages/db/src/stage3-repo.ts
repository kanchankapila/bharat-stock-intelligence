// BUILD_STAGE_3_4_SPEC.md Stage 3 -- Class Q transfer. All SQL for the new
// tables lives here ("only db issues SQL", carried over from Stage 2).
import type pg from 'pg';

export async function seedStage3Registry(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES
       ('investsights', 'InvestSights', '{investsights.in}', 'none', 'permitted'),
       ('trendlyne', 'Trendlyne (kayal)', '{kayal.trendlyne.com,trendlyne.com}', 'none', 'permitted'),
       ('etmarketsapis', 'ET Markets Stats', '{etmarketsapis.indiatimes.com}', 'none', 'permitted'),
       ('marketsmojo', 'MarketsMojo', '{frapi.marketsmojo.com,www.marketsmojo.com}', 'none', 'permitted'),
       ('moneycontrol', 'MoneyControl', '{moneycontrol.com}', 'none', 'permitted'),
       ('etnow', 'ET Now', '{etnownews.com}', 'none', 'permitted')
     ON CONFLICT (provider) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES
       ('investsights.corporate_actions', 'investsights', 'ingestion',
         'https://investsights.in/api/v2/market/corporate-actions?days_back={days_back}&days_ahead={days_ahead}', 'v1'),
       ('trendlyne.kayal_screener', 'trendlyne', 'ingestion',
         'https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/?perPageCount=10000&pageNumber=0&screenpk={pk}&groupType=all&groupName=', 'v1'),
       ('nse.fii_dii', 'nse', 'ingestion',
         'https://www.nseindia.com/api/fiidiiTradeReact', 'v1'),
       ('etmarketsapis.stats', 'etmarketsapis', 'ingestion',
         'https://etmarketsapis.indiatimes.com/ET_Stats/mobile?companyId={companyId}&events={events}&last={n}&bType=all', 'v1'),
       ('marketsmojo.financials', 'marketsmojo', 'ingestion',
         'https://frapi.marketsmojo.com/apiv1/financials/get-financials?qtype=qoq&card=1&page={n}&sid={sid}', 'v1')
     ON CONFLICT (endpoint_key) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES
       ('stage3.corporate_actions', 'Stage 3 Class Q transfer: corporate actions / events (InvestSights + legacy)', 'Asia/Kolkata', 'v1'),
       ('stage3.screener_membership', 'Stage 3 Class Q transfer: Trendlyne screener membership (kayal)', 'Asia/Kolkata', 'v1'),
       ('stage3.fii_dii', 'Stage 3 Class Q transfer: FII/DII flow (NSE + legacy)', 'Asia/Kolkata', 'v1'),
       ('stage3.fundamentals', 'Stage 3 Class Q transfer: fundamentals (ET Stats + MarketsMojo)', 'Asia/Kolkata', 'v1'),
       ('stage3.screener_definitions', 'Stage 3 Class Q transfer: screener catalog (legacy MC/ETNow)', 'Asia/Kolkata', 'v1'),
       ('stage3.boundary', 'Stage 3 Task 3.0: provenance boundary date recording', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );
}

// --- transfer_reject: every row a transfer rejects, with a reason. Never
// silently drop -- rows_read = rows_accepted + rows_rejected must balance. ---
export interface TransferRejectInput {
  sourceTable: string;
  sourcePk: string;
  reason: string;
  rawSnippet?: unknown;
}

export async function insertTransferReject(client: pg.ClientBase, input: TransferRejectInput): Promise<void> {
  await client.query(
    `INSERT INTO transfer_reject (source_table, source_pk, reason, raw_snippet) VALUES ($1, $2, $3, $4)`,
    [input.sourceTable, input.sourcePk, input.reason, input.rawSnippet ? JSON.stringify(input.rawSnippet) : null],
  );
}

export async function countTransferRejects(pool: pg.Pool, sourceTable: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM transfer_reject WHERE source_table = $1`,
    [sourceTable],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function rejectReasonsByTable(pool: pg.Pool, sourceTable: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ reason: string; n: string }>(
    `SELECT reason, count(*)::text n FROM transfer_reject WHERE source_table = $1 GROUP BY reason ORDER BY 2 DESC`,
    [sourceTable],
  );
  return Object.fromEntries(rows.map((r) => [r.reason, Number(r.n)]));
}

// --- audit_metric / provenance boundary date (Task 3.0) ---
export async function queryProvenanceBoundaryDate(pool: pg.Pool, source = 'nse'): Promise<string | null> {
  const { rows } = await pool.query<{ d: string | null }>(
    `SELECT max(session_date)::text d FROM market_bar WHERE source = $1`,
    [source],
  );
  return rows[0]?.d ?? null;
}

export interface AuditMetricInput {
  runId: string;
  metricName: string;
  metricVersion: string;
  dimensions?: Record<string, unknown>;
  value?: number | null;
  nObservations?: number | null;
  dataWatermark: string;
  paramsHash: string;
  codeCommit: string;
}

export async function insertAuditMetric(client: pg.ClientBase, input: AuditMetricInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_metric (run_id, metric_name, metric_version, dimensions, value, n_observations, data_watermark, params_hash, code_commit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (run_id, metric_name, dimensions) DO NOTHING`,
    [
      input.runId, input.metricName, input.metricVersion, JSON.stringify(input.dimensions ?? {}),
      input.value ?? null, input.nObservations ?? null, input.dataWatermark, input.paramsHash, input.codeCommit,
    ],
  );
}

// --- event_fact (corporate actions / events, Task 3.2) ---
export interface EventFactInput {
  source: string;
  sourceEventId: string;
  symbol: string | null;
  kind: string;
  effectiveAt: string | null;
  availableAt: string;
  headline: string | null;
  payload: Record<string, unknown>;
  provenanceQuality: 'recorded' | 'inferred';
  runId: string;
}

export async function upsertEventFact(client: pg.ClientBase, input: EventFactInput): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO event_fact (source, source_event_id, symbol, kind, effective_at, available_at, headline, payload, provenance_quality, run_id)
     VALUES ($1, $2, $3, $4::event_type, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source, source_event_id) DO NOTHING`,
    [
      input.source, input.sourceEventId, input.symbol, input.kind, input.effectiveAt, input.availableAt,
      input.headline, JSON.stringify(input.payload), input.provenanceQuality, input.runId,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export async function symbolExists(pool: pg.Pool | pg.ClientBase, symbol: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM security WHERE symbol = $1) AS exists`,
    [symbol],
  );
  return rows[0]?.exists ?? false;
}

export async function loadKnownSymbols(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ symbol: string }>(`SELECT symbol FROM security`);
  return new Set(rows.map((r) => r.symbol));
}

// --- market_flow (FII/DII, Task 3.4) ---
export interface MarketFlowInput {
  scope: string;
  segment: string;
  flowDate: string;
  source: string;
  fiiNet: number | null;
  diiNet: number | null;
  availableAt: string;
  provenanceQuality: 'recorded' | 'inferred';
  runId: string;
}

export async function upsertMarketFlow(client: pg.ClientBase, input: MarketFlowInput): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO market_flow (scope, segment, flow_date, source, fii_net, dii_net, available_at, provenance_quality, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (scope, segment, flow_date, source) DO NOTHING`,
    [input.scope, input.segment, input.flowDate, input.source, input.fiiNet, input.diiNet, input.availableAt, input.provenanceQuality, input.runId],
  );
  return (rowCount ?? 0) > 0;
}

export async function queryMarketFlowDateRange(pool: pg.Pool, source = 'nse'): Promise<{ min: string | null; max: string | null }> {
  const { rows } = await pool.query<{ min: string | null; max: string | null }>(
    `SELECT min(flow_date)::text min, max(flow_date)::text max FROM market_flow WHERE source = $1`,
    [source],
  );
  return rows[0] ?? { min: null, max: null };
}

// --- fundamental_fact (Task 3.5) ---
export interface FundamentalFactInput {
  symbol: string;
  metric: string;
  periodEnd: string;
  periodType: 'Q' | 'H' | 'FY' | 'TTM';
  source: string;
  value: number | null;
  unit: string | null;
  announcedAt: string | null;
  availableAt: string;
  provenanceQuality: 'recorded' | 'inferred';
  runId: string;
}

export async function upsertFundamentalFact(client: pg.ClientBase, input: FundamentalFactInput): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO fundamental_fact (symbol, metric, period_end, period_type, source, value, unit, announced_at, available_at, provenance_quality, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (symbol, metric, period_end, period_type, source, available_at) DO NOTHING`,
    [
      input.symbol, input.metric, input.periodEnd, input.periodType, input.source, input.value, input.unit,
      input.announcedAt, input.availableAt, input.provenanceQuality, input.runId,
    ],
  );
  return (rowCount ?? 0) > 0;
}

export async function queryFundamentalCoveragePct(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ pct: string }>(
    `SELECT round(100.0 * count(DISTINCT ff.symbol) / NULLIF(count(DISTINCT s.symbol), 0), 2)::text pct
     FROM security s
     LEFT JOIN fundamental_fact ff ON ff.symbol = s.symbol
     WHERE s.status = 'listed'`,
  );
  return Number(rows[0]?.pct ?? 0);
}

export async function queryFundamentalLagViolations(pool: pg.Pool, lagFloorDays = 89): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM fundamental_fact
     WHERE available_at < (period_end + ($1 || ' days')::interval)`,
    [lagFloorDays],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function queryFutureDatedFundamentalFacts(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM fundamental_fact WHERE available_at > now()`,
  );
  return Number(rows[0]?.n ?? 0);
}

// --- screener_definition / screener_membership (Tasks 3.3, 3.6) ---
export interface ScreenerDefinitionInput {
  provider: string;
  providerId: string;
  version: number;
  name: string;
  requestHash: string;
  requestBody: Record<string, unknown> | null;
  category: string | null;
  enabled: boolean;
}

export async function upsertScreenerDefinition(client: pg.ClientBase, input: ScreenerDefinitionInput): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO screener_definition (provider, provider_id, version, name, request_hash, request_body, category, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, provider_id, version) DO NOTHING`,
    [input.provider, input.providerId, input.version, input.name, input.requestHash, input.requestBody ? JSON.stringify(input.requestBody) : null, input.category, input.enabled],
  );
  return (rowCount ?? 0) > 0;
}

export async function countScreenerDefinitions(pool: pg.Pool, provider: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM screener_definition WHERE provider = $1`,
    [provider],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ScreenerMembershipRow {
  symbol: string;
  rank: number | null;
}

/** Bulk insert via unnest -- kayal fetches across 1,052 PKs can produce tens
 * of thousands of membership rows; per-row inserts were the measured
 * bottleneck for the same shape of problem in Stage 2 (17.5x speedup). */
export async function bulkUpsertScreenerMembership(
  client: pg.ClientBase, provider: string, providerId: string, version: number,
  rows: ScreenerMembershipRow[], observedAt: string, runId: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO screener_membership (provider, provider_id, version, symbol, observed_at, rank, run_id)
     SELECT $1, $2, $3, symbol, $6::timestamptz, rank, $7::uuid
     FROM unnest($4::text[], $5::int[]) AS t(symbol, rank)
     ON CONFLICT (provider, provider_id, version, symbol, observed_at) DO NOTHING`,
    [provider, providerId, version, rows.map((r) => r.symbol), rows.map((r) => r.rank), observedAt, runId],
  );
  return rowCount ?? 0;
}

export async function countDistinctObservedScreeners(pool: pg.Pool, provider: string, observedAt: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT provider_id)::text n FROM screener_membership WHERE provider = $1 AND observed_at = $2`,
    [provider, observedAt],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function queryLatestScreenerMembershipObservedAt(pool: pg.Pool, provider = 'trendlyne'): Promise<string | null> {
  const { rows } = await pool.query<{ d: string | null }>(
    `SELECT max(observed_at)::text d FROM screener_membership WHERE provider = $1`,
    [provider],
  );
  return rows[0]?.d ?? null;
}

// --- DQ check support queries (Task 3.7) ---
// source/provider are overridable for the same reason nse/dq-checks.ts's
// scope parameters exist: these queries read MAX() ACROSS THE WHOLE TABLE by
// design, so a negative-control test inserting one stale fixture row under
// an unscoped query would be silently masked by real, fresher production
// data in the same table (event_fact has 2 real sources, market_flow and
// screener_membership are refreshed same-day) -- the exact incident class
// documented in recurring-bugs.md. Default is unscoped (the real production
// question: "is ANY of this data fresh"); tests pass a distinct fake scope.
export async function queryLatestEventFactAnnouncement(pool: pg.Pool, source?: string): Promise<{ latest: string | null; daysBehind: number | null }> {
  const { rows } = await pool.query<{ latest: string | null; days_behind: string | null }>(
    `SELECT max(available_at)::date::text latest,
            (CURRENT_DATE - max(available_at)::date) days_behind
     FROM event_fact WHERE ($1::text IS NULL OR source = $1)`,
    [source ?? null],
  );
  const r = rows[0];
  return { latest: r?.latest ?? null, daysBehind: r?.days_behind != null ? Number(r.days_behind) : null };
}

export async function queryLatestMarketFlowSession(pool: pg.Pool, source?: string): Promise<{ latest: string | null; daysBehind: number | null }> {
  const { rows } = await pool.query<{ latest: string | null; days_behind: string | null }>(
    `SELECT max(flow_date)::text latest, (CURRENT_DATE - max(flow_date)) days_behind
     FROM market_flow WHERE ($1::text IS NULL OR source = $1)`,
    [source ?? null],
  );
  const r = rows[0];
  return { latest: r?.latest ?? null, daysBehind: r?.days_behind != null ? Number(r.days_behind) : null };
}

export async function queryLatestScreenerMembershipFreshness(pool: pg.Pool, provider?: string): Promise<{ latest: string | null; daysBehind: number | null }> {
  const { rows } = await pool.query<{ latest: string | null; days_behind: string | null }>(
    `SELECT max(observed_at)::date::text latest, (CURRENT_DATE - max(observed_at)::date) days_behind
     FROM screener_membership WHERE ($1::text IS NULL OR provider = $1)`,
    [provider ?? null],
  );
  const r = rows[0];
  return { latest: r?.latest ?? null, daysBehind: r?.days_behind != null ? Number(r.days_behind) : null };
}
