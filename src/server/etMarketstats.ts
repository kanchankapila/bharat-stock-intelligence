import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dbAll, dbTransaction } from './dbAsync';

/**
 * ET Marketstats/Technicals screener family — etapi.indiatimes.com/et-screener/v2.
 * Distinct from the scrid-based screener.indiatimes.com family already onboarded
 * as etnow_screeners/etnow.ts. This family has two endpoints:
 *   technical-data  -> filter via firstOperand/operationType/secondOperand
 *                      (financials, moving-averages, rsi, macd, bollinger-band,
 *                       stochastic, price-and-pivots, relative-returns, shareholding)
 *   intraday-stats  -> filter via apiType (+ optional duration/timespan)
 *                      (top gainers/losers, 52-week hi/lo, volume shockers, ...)
 * viewId alone does NOT identify a screen — it only selects the column layout and
 * is reused across multiple distinct filters (e.g. RSI "Crossed Above 20/30/70/80"
 * all share viewId 7848). The true identity of a screen is the full operand tuple,
 * so screener_key is a hash of that tuple rather than the raw viewId.
 */

const TECHNICAL_DATA_URL = 'https://etapi.indiatimes.com/et-screener/v2/technical-data';
const INTRADAY_STATS_URL = 'https://etapi.indiatimes.com/et-screener/v2/intraday-stats';

const HEADERS = {
  'content-type': 'application/json',
  'referer': 'https://economictimes.indiatimes.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'isprime': 'false',
  'ssoid': '',
  'ticketid': '',
};

export interface EtMarketstatsScreenerDef {
  screenerKey: string;
  label: string;
  endpoint: 'technical-data' | 'intraday-stats';
  viewId: number | null;
  firstOperand: string | null;
  operationType: string | null;
  secondOperand: string | null;
  apiType: string | null;
  duration: string | null;
  timespan: string | null;
  screenerPageUrl: string | null;
}

export function computeScreenerKey(def: Omit<EtMarketstatsScreenerDef, 'screenerKey'>): string {
  const slug = def.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const identity = [
    def.endpoint, def.viewId, def.firstOperand, def.operationType, def.secondOperand,
    def.apiType, def.duration, def.timespan,
  ].join('|');
  const hash = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/** Four additional view IDs confirmed live via user-supplied captured payloads
 * (2026-07-23), beyond the 91 in et-marketstats-post-requests.json. All four share
 * the same operand tuple (R1DayReturn Below R5YearReturnSensex) but distinct viewIds —
 * consistent with the file's own pattern of viewId selecting column layout, not filter
 * identity (see computeScreenerKey), so each gets its own screener_key despite the
 * shared filter criteria. */
const CONFIRMED_EXTRA_DEFS: Array<Omit<EtMarketstatsScreenerDef, 'screenerKey'>> = [23236, 23235, 23234, 23217].map(viewId => ({
  label: `1-Day Return Below 5Y Return vs Sensex (view ${viewId})`,
  endpoint: 'technical-data' as const,
  viewId,
  firstOperand: 'R1DayReturn',
  operationType: 'Below',
  secondOperand: 'R5YearReturnSensex',
  apiType: null,
  duration: null,
  timespan: null,
  screenerPageUrl: null,
}));

function parseRequestsFromCapturedJson(filePath: string): Array<Omit<EtMarketstatsScreenerDef, 'screenerKey'>> {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const requests: any[] = data.requests || [];
  const defs: Array<Omit<EtMarketstatsScreenerDef, 'screenerKey'>> = [];

  for (const req of requests) {
    const payload = req.request?.payload;
    const label = req.label;
    if (!payload || !label) continue;

    const endpoint: 'technical-data' | 'intraday-stats' =
      req.request?.url?.includes('intraday-stats') ? 'intraday-stats' : 'technical-data';

    defs.push({
      label,
      endpoint,
      viewId: payload.viewId ?? null,
      firstOperand: payload.firstOperand ?? null,
      operationType: payload.operationType ?? null,
      secondOperand: payload.secondOperand ?? null,
      apiType: payload.apiType ?? null,
      duration: payload.duration ?? null,
      timespan: payload.timespan ?? null,
      screenerPageUrl: req.screenerPageUrl ?? null,
    });
  }
  return defs;
}

/** Seed et_marketstats_screeners from et-marketstats-post-requests.json (91 captured
 * requests) + CONFIRMED_EXTRA_DEFS. Safe to call on every server start (upsert). */
export async function initEtMarketstatsScreeners(): Promise<number> {
  const jsonPath = path.join(process.cwd(), 'et-marketstats-post-requests.json');
  let defs: Array<Omit<EtMarketstatsScreenerDef, 'screenerKey'>> = [];

  if (fs.existsSync(jsonPath)) {
    defs = parseRequestsFromCapturedJson(jsonPath);
  } else {
    console.warn('[ET_MARKETSTATS] et-marketstats-post-requests.json not found in project root; seeding CONFIRMED_EXTRA_DEFS only.');
  }
  defs.push(...CONFIRMED_EXTRA_DEFS);

  const upsertSql = `
    INSERT INTO et_marketstats_screeners
      (screener_key, label, endpoint, view_id, first_operand, operation_type, second_operand, api_type, duration, timespan, screener_page_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(screener_key) DO UPDATE SET
      label = excluded.label,
      screener_page_url = excluded.screener_page_url,
      last_updated = CURRENT_TIMESTAMP
  `;

  let count = 0;
  await dbTransaction(async (tx) => {
    for (const def of defs) {
      const screenerKey = computeScreenerKey(def);
      await tx.run(upsertSql, [
        screenerKey, def.label, def.endpoint, def.viewId,
        def.firstOperand, def.operationType, def.secondOperand,
        def.apiType, def.duration, def.timespan, def.screenerPageUrl,
      ]);
      count++;
    }
  });
  console.log(`[ET_MARKETSTATS] Seeded ${count} screener definitions.`);
  return count;
}

export async function getEtMarketstatsScreenerDefs(): Promise<Array<EtMarketstatsScreenerDef & { screenerKey: string }>> {
  const rows = await dbAll<any>(`
    SELECT screener_key AS "screenerKey", label, endpoint, view_id AS "viewId",
           first_operand AS "firstOperand", operation_type AS "operationType",
           second_operand AS "secondOperand", api_type AS "apiType",
           duration, timespan, screener_page_url AS "screenerPageUrl"
    FROM et_marketstats_screeners
    ORDER BY id
  `);
  return rows;
}

export interface EtMarketstatsRecord {
  assetName: string;
  assetSymbol: string;
  assetId: string;
  assetExchangeId: string;
  data: Array<{ keyId: string; keyText: string; value: string; filterFormatValue: string; valueType?: string }>;
}

export interface EtMarketstatsResponse {
  dataList: EtMarketstatsRecord[];
  headerFields: Array<{ keyId: string; keyText: string }>;
  pageSummary: { totalRecords: number; totalpages: number; pagesize: number; pageno: number };
}

/** Fetches page 1 (pagesize 100) of a screener — matches the pagesize baked into every
 * captured request; full pagination isn't attempted (same "top N" simplification the
 * existing etnow screener sync uses). */
export async function fetchEtMarketstatsScreener(
  def: Pick<EtMarketstatsScreenerDef, 'endpoint' | 'viewId' | 'firstOperand' | 'operationType' | 'secondOperand' | 'apiType' | 'duration' | 'timespan'>,
  pagesize = 100,
): Promise<EtMarketstatsResponse> {
  const url = def.endpoint === 'intraday-stats' ? INTRADAY_STATS_URL : TECHNICAL_DATA_URL;
  const body: Record<string, unknown> = {
    viewId: def.viewId,
    filterValue: [],
    filterType: 'index',
    sort: [],
    pagesize,
    pageno: 1,
  };
  if (def.endpoint === 'intraday-stats') {
    body.apiType = def.apiType;
    if (def.duration) body.duration = def.duration;
    if (def.timespan) body.timespan = def.timespan;
  } else {
    body.firstOperand = def.firstOperand;
    body.operationType = def.operationType;
    body.secondOperand = def.secondOperand;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`ET Marketstats fetch failed (${def.endpoint}): ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function getFieldValue(record: EtMarketstatsRecord, keyId: string): string | null {
  const field = record.data?.find(d => d.keyId === keyId);
  return field?.filterFormatValue ?? field?.value ?? null;
}

export function cleanNseSymbol(rawSymbol: string): string {
  return rawSymbol.replace(/-NSE$/i, '').replace(/EQ$/i, '').replace(/BE$/i, '').trim();
}

/**
 * Structured metric extraction — makes the data captured by every screener (existing
 * 91 + the 4 confirmed extra views) queryable without parsing the raw_data JSON blob.
 * Writes into the pre-existing generic mc_general_metrics table (symbol, source_api,
 * metric_group, metric_name, metric_value_num/text, fetched_at) already used by
 * moneycontrol_fetcher.py — same convention, source_api='et_marketstats'.
 */

// The 4 confirmed extra view IDs all share one filter (R1DayReturn Below
// R5YearReturnSensex) but carry genuinely distinct column sets (verified 2026-07-23) —
// grouped by their actual content rather than the shared filter criterion.
const EXTRA_DEF_METRIC_GROUPS: Record<number, string> = {
  23217: 'technical-oscillators-margins',
  23234: 'volatility-banking-valuation',
  23235: 'coverage-ratios-growth',
  23236: 'valuation-quality-scores',
};

export function deriveMetricGroup(
  def: Pick<EtMarketstatsScreenerDef, 'endpoint' | 'apiType' | 'screenerPageUrl' | 'viewId'>,
): string {
  if (def.viewId != null && EXTRA_DEF_METRIC_GROUPS[def.viewId]) return EXTRA_DEF_METRIC_GROUPS[def.viewId];
  if (def.endpoint === 'intraday-stats') return def.apiType || 'intraday-other';
  if (def.screenerPageUrl) {
    const match = def.screenerPageUrl.match(/marketstats-technicals\/([a-z-]+)/i);
    if (match) return match[1];
  }
  return 'other';
}

// Already captured in dedicated typed columns on et_marketstats_screener_stocks
// (last_traded_price, percent_change) or purely cosmetic (company name) — skip to
// avoid redundant duplication into the metrics table.
const METRIC_SKIP_KEYS = new Set(['shortName', 'lastTradedPrice', 'netChange', 'percentChange']);

export interface ParsedMetric { num: number | null; text: string | null }

/** Blank string and the literal text "null" (both seen live from ET for genuinely
 * missing values) are treated as "no value" and must not be written as 0 or "null" —
 * distinguishing blank-from-zero was flagged as a real data-quality gotcha in this
 * source (e.g. month1SD blank for one non-bank stock, "0.00%" for another). */
export function parseMetricField(field: { value: string; filterFormatValue: string; valueType?: string }): ParsedMetric | null {
  const raw = field.filterFormatValue ?? field.value;
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;

  if (field.valueType === 'number') {
    const num = parseFloat(trimmed);
    if (Number.isFinite(num)) return { num, text: null };
  }
  return { num: null, text: trimmed };
}

export function extractMetricRows(
  def: Pick<EtMarketstatsScreenerDef, 'endpoint' | 'apiType' | 'screenerPageUrl' | 'viewId'>,
  symbol: string,
  record: EtMarketstatsRecord,
  fetchedAt: string,
): Array<[string, string, string, string, number | null, string | null, string]> {
  const metricGroup = deriveMetricGroup(def);
  const rows: Array<[string, string, string, string, number | null, string | null, string]> = [];
  for (const field of record.data || []) {
    if (METRIC_SKIP_KEYS.has(field.keyId)) continue;
    const parsed = parseMetricField(field);
    if (!parsed) continue;
    rows.push([symbol, 'et_marketstats', metricGroup, field.keyId, parsed.num, parsed.text, fetchedAt]);
  }
  return rows;
}
