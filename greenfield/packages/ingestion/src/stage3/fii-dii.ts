// Task 3.4 / spec §2.8: NSE FII/DII cash-market flow. The API returns one
// row per (date, category) with category in {'DII','FII/FPI'} -- this
// module pivots that into one row per date with fii_net/dii_net, matching
// market_flow's shape (scope='market', segment='cash', one row per date).
export const NSE_FII_DII_URL = 'https://www.nseindia.com/api/fiidiiTradeReact';

export const NSE_SESSION_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

export const NSE_FII_DII_HEADERS = {
  ...NSE_SESSION_HEADERS,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.nseindia.com/market-data/fii-dii-activity',
  DNT: '1',
};

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** "12-Aug-2026" -> "2026-08-12". Returns null if the format doesn't match --
 * never guesses. */
export function parseNseFlowDate(raw: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [, day, mon, year] = m;
  const month = MONTHS[mon as keyof typeof MONTHS];
  if (!month) return null;
  return `${year}-${month}-${day!.padStart(2, '0')}`;
}

export interface FlowDay {
  flowDate: string;
  fiiNet: number | null;
  diiNet: number | null;
}

export interface FiiDiiParseResult {
  accepted: FlowDay[];
  rejected: Array<{ raw: unknown; reason: string }>;
}

export function parseFiiDiiResponse(body: string): FiiDiiParseResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { accepted: [], rejected: [{ raw: body.slice(0, 500), reason: 'response body is not valid JSON' }] };
  }
  if (!Array.isArray(json)) {
    return { accepted: [], rejected: [{ raw: json, reason: 'response is not a JSON array' }] };
  }

  const byDate = new Map<string, { fiiNet: number | null; diiNet: number | null; rawDate: string }>();
  const rejected: Array<{ raw: unknown; reason: string }> = [];

  for (const raw of json) {
    const r = raw as Record<string, unknown>;
    const rawDate = typeof r.date === 'string' ? r.date : '';
    const flowDate = parseNseFlowDate(rawDate);
    const category = typeof r.category === 'string' ? r.category : '';
    const netValue = typeof r.netValue === 'string' ? Number(r.netValue) : typeof r.netValue === 'number' ? r.netValue : NaN;

    if (!flowDate) {
      rejected.push({ raw, reason: `unparseable date '${rawDate}'` });
      continue;
    }
    if (category !== 'DII' && category !== 'FII/FPI') {
      rejected.push({ raw, reason: `unrecognized category '${category}'` });
      continue;
    }
    if (!Number.isFinite(netValue)) {
      rejected.push({ raw, reason: `non-finite netValue '${String(r.netValue)}'` });
      continue;
    }

    const entry = byDate.get(flowDate) ?? { fiiNet: null, diiNet: null, rawDate };
    if (category === 'DII') entry.diiNet = netValue;
    else entry.fiiNet = netValue;
    byDate.set(flowDate, entry);
  }

  const accepted: FlowDay[] = Array.from(byDate.entries()).map(([flowDate, v]) => ({ flowDate, fiiNet: v.fiiNet, diiNet: v.diiNet }));
  return { accepted, rejected };
}
