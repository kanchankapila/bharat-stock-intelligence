// Task 3.5 / spec §2.6: MarketsMojo get-financials. The spec table describes
// GET query params, but the real working call (confirmed against the live
// endpoint and matching src/server/marketsmojo_financials_fetcher.py, the
// existing production fetcher) is a POST with a JSON body -- a GET with
// those query params returns HTTP 405. Verified live before writing this
// parser, per data-sources.md's live-shape mandate.
export const MARKETSMOJO_FINANCIALS_URL = 'https://frapi.marketsmojo.com/apiv1/financials/get-financials';

export const MARKETSMOJO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
  Referer: 'https://www.marketsmojo.com/',
  'Content-Type': 'application/json',
};

export function marketsMojoRequestBody(sid: string, page: number, qtype = 'qoq'): string {
  return JSON.stringify({ sid, exchange: '0', period: 'q', card: 1, page, type: 0, qtype });
}

const MONTH_TO_QUARTER_END: Record<string, string> = {
  mar: '03-31', jun: '06-30', sep: '09-30', dec: '12-31',
};

/** "jun26" -> "2026-06-30". Returns null if the label isn't a recognized
 * quarter-end slug -- never guesses. */
export function parseMarketsMojoPeriodKey(key: string): string | null {
  const m = /^(mar|jun|sep|dec)(\d{2})$/i.exec(key);
  if (!m) return null;
  const [, mon, yy] = m;
  const monthDay = MONTH_TO_QUARTER_END[mon!.toLowerCase()];
  if (!monthDay) return null;
  return `20${yy}-${monthDay}`;
}

function parseNumeric(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/,/g, '').replace(/%/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface MarketsMojoFact {
  metric: string;
  periodEnd: string;
  value: number;
}

interface StatementRow {
  items?: StatementRow[];
  [key: string]: unknown;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function flattenStatement(stmtKey: string, rows: StatementRow[], periodKeys: string[], out: MarketsMojoFact[]): void {
  for (const row of rows) {
    const lineItem = row[stmtKey];
    if (typeof lineItem === 'string' && lineItem.trim()) {
      const metricBase = `mm_${stmtKey}_${slugify(lineItem)}`;
      for (const pk of periodKeys) {
        if (!(pk in row)) continue;
        const periodEnd = parseMarketsMojoPeriodKey(pk);
        const value = parseNumeric(row[pk]);
        if (!periodEnd || value === null) continue;
        out.push({ metric: metricBase, periodEnd, value });
      }
    }
    if (Array.isArray(row.items)) flattenStatement(stmtKey, row.items, periodKeys, out);
  }
}

export interface MarketsMojoParseResult {
  accepted: MarketsMojoFact[];
  isEmpty: boolean;
  rejectReason?: string;
}

export function parseMarketsMojoResponse(body: string): MarketsMojoParseResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { accepted: [], isEmpty: true, rejectReason: 'response body is not valid JSON' };
  }
  const envelope = json as { code?: unknown; data?: { snapshot?: Record<string, unknown> } };
  if (String(envelope.code) !== '200') {
    return { accepted: [], isEmpty: true, rejectReason: `code != '200' (got ${JSON.stringify(envelope.code)})` };
  }
  const snapshot = envelope.data?.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return { accepted: [], isEmpty: true, rejectReason: 'missing data.snapshot object' };
  }

  const accepted: MarketsMojoFact[] = [];
  for (const [stmtKey, block] of Object.entries(snapshot)) {
    const b = block as { data?: { period_dates?: Array<{ key?: unknown }>; [k: string]: unknown } };
    const periodDates = b.data?.period_dates;
    if (!Array.isArray(periodDates)) continue;
    const periodKeys = periodDates.map((pd) => pd.key).filter((k): k is string => typeof k === 'string' && k !== stmtKey);
    const rows = b.data?.[stmtKey];
    if (!Array.isArray(rows) || periodKeys.length === 0) continue;
    flattenStatement(stmtKey, rows as StatementRow[], periodKeys, accepted);
  }

  return { accepted, isEmpty: accepted.length === 0 };
}
