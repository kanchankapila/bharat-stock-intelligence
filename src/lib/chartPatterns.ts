import stockData, { type StockMapping } from '../data/stocklist';

/**
 * Moneycontrol "MC Pro" chart-pattern technical picks
 * (https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns).
 *
 * Response shape (live-verified 2026-09-03): { status: 'success', list: { total, currentCount,
 * closedCount, data: [...] } } where each item carries its trading details inside a JSON *string*
 * column (`meta_data`) and its chart images inside that string's `timeline[]` entries
 * (`pattern_img` keyed by pixel size, e.g. '1200x600'). The API sends
 * `Access-Control-Allow-Origin: *`, so the browser fetches it directly -- same pattern as
 * EtCallsPage.tsx for the ET recommendations feed.
 *
 * Honesty rules honored here (see src/lib/format.ts): missing/null fields parse to null and
 * render as "—" upstream -- never coerced to 0. `end_date: '1970-01-01'` is the API's "no
 * validity date" sentinel and is normalized to null.
 */

export const CHART_PATTERN_PAGE_SIZE = 12;

export function buildChartPatternsUrl(start: number, limit: number = CHART_PATTERN_PAGE_SIZE): string {
  return `https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns?deviceType=W&version=174&start=${start}&limit=${limit}&pattern_type=all`;
}

export interface McChartPatternRaw {
  pattern_id: number;
  exchange?: string;
  pattern_name?: string;
  comment?: string;
  time_frame?: string;
  p_status?: string;
  is_closed?: string;
  end_date?: string;
  created_at?: string;
  updated_at?: string;
  created_at_epoch?: number;
  updated_at_epoch?: number;
  meta_data?: string;
  analyst_name?: string;
  analyst_image?: string;
  symbol?: string;
  sc_name?: string;
}

interface McPatternTimelineEntry {
  pattern_img?: Record<string, string> | null;
  rationale?: string;
  action_type?: string;
  created_at?: string;
}

interface McPatternMeta {
  pattern_type?: string;
  entry_price?: string | number | null;
  cmp?: string | number | null;
  target_price?: string | number | null;
  target_return_prcnt?: string | number | null;
  stoploss_price?: string | number | null;
  stoploss_prcnt?: string | number | null;
  price_key?: string;
  timeline?: McPatternTimelineEntry[];
}

export type PatternDirection = 'buy' | 'sell';


export interface ParsedChartPattern {
  id: number;
  patternName: string;
  comment: string;
  timeframe: string;
  /** 'Active' (is_closed 'N' / p_status 'New') or 'Closed'. */
  status: 'Active' | 'Closed';
  direction: PatternDirection | null;
  entryPrice: number | null;
  cmp: number | null;
  targetPrice: number | null;
  targetReturnPct: number | null;
  stoplossPrice: number | null;
  stoplossPct: number | null;
  /** Validity date from end_date, or null for the 1970 sentinel / missing. */
  validTill: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  /** Latest (most recent action) chart image URL. */
  imageUrl: string | null;
  /** Latest timeline rationale (entry thesis on 'add', close note on 'close'). */
  rationale: string | null;
  /** action_type of the latest timeline entry ('add' | 'close' | ...). */
  latestAction: string | null;
  timelineCount: number;
  analystName: string;
  analystImage: string | null;
  instrument: ChartPatternInstrument;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** MC `created_at` strings are IST wall-clock ("2026-09-02 11:40:49"); epoch seconds preferred. */
function toMsFromISTString(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const ms = utcMs - 5.5 * 60 * 60 * 1000;
  return Number.isFinite(ms) ? ms : null;
}

function toMs(value: string | undefined, epoch: number | undefined): number | null {
  if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0) return epoch * 1000;
  return toMsFromISTString(value);
}


/**
 * price_key shapes observed: `stk_RB02_N` (equity; trailing `_N`/`_B` is the exchange) and
 * `indices_i_in;NSX` (index). Only equities are resolvable to name/symbol via stocklist's
 * `mcsymbol`; anything else keeps its raw code and is labeled honestly.
 */
export function resolveInstrument(
  priceKey: string | null | undefined,
  stockByMcSymbol: Map<string, StockMapping>,
): ChartPatternInstrument {
  if (!priceKey) return { kind: 'unknown', code: null, name: null, symbol: null };
  if (priceKey.startsWith('stk_')) {
    const code = priceKey.replace(/^stk_/, '').replace(/_[A-Za-z]{1,2}$/, '') || null;
    const hit = code ? stockByMcSymbol.get(code) : undefined;
    return {
      kind: 'stock',
      code,
      name: hit?.name ?? null,
      symbol: hit?.symbol ?? null,
    };
  }
  if (priceKey.startsWith('indices_')) {
    const code = priceKey.includes(';') ? priceKey.split(';')[1] : null;
    return { kind: 'index', code: code || priceKey, name: null, symbol: null };
  }
  return { kind: 'unknown', code: priceKey, name: null, symbol: null };
}

function pickImage(entry: McPatternTimelineEntry | undefined): string | null {
  const img = entry?.pattern_img;
  if (!img) return null;
  return img['1200x600'] ?? Object.values(img)[0] ?? null;
}

/** First-wins map of stocklist by MoneyControl scrip code (`mcsymbol`). */
export function buildMcSymbolMap(): Map<string, StockMapping> {
  const map = new Map<string, StockMapping>();
  for (const item of stockData) {
    if (item.mcsymbol && !map.has(item.mcsymbol)) map.set(item.mcsymbol, item);
  }
  return map;
}

export function parseChartPatternItem(
  raw: McChartPatternRaw,
  stockByMcSymbol: Map<string, StockMapping>,
): ParsedChartPattern {
  let meta: McPatternMeta = {};
  try {
    meta = raw.meta_data ? (JSON.parse(raw.meta_data) as McPatternMeta) : {};
  } catch {
    meta = {};
  }

  const timeline = Array.isArray(meta.timeline) ? meta.timeline : [];
  const latest = timeline.length > 0 ? timeline[timeline.length - 1] : undefined;
  const direction: PatternDirection | null =
    meta.pattern_type === 'buy' || meta.pattern_type === 'sell' ? meta.pattern_type : null;
  const validTill = raw.end_date && raw.end_date.startsWith('1970') ? null : raw.end_date || null;

  return {
    id: raw.pattern_id,
    patternName: raw.pattern_name?.trim() || 'Unnamed pattern',
    comment: raw.comment?.trim() || '',
    timeframe: raw.time_frame?.trim() || '',
    status: raw.is_closed === 'Y' || raw.p_status === 'Closed' ? 'Closed' : 'Active',
    direction,
    entryPrice: toNumber(meta.entry_price),
    cmp: toNumber(meta.cmp),
    targetPrice: toNumber(meta.target_price),
    targetReturnPct: toNumber(meta.target_return_prcnt),
    stoplossPrice: toNumber(meta.stoploss_price),
    stoplossPct: toNumber(meta.stoploss_prcnt),
    validTill,
    createdAtMs: toMs(raw.created_at, raw.created_at_epoch),
    updatedAtMs: toMs(raw.updated_at, raw.updated_at_epoch),
    imageUrl: pickImage(latest) ?? timeline.map(pickImage).find(Boolean) ?? null,
    rationale: latest?.rationale?.trim() || null,
    latestAction: latest?.action_type || null,
    timelineCount: timeline.length,
    analystName: raw.analyst_name?.trim() || '',
    analystImage: raw.analyst_image || null,
    instrument: resolveInstrument(meta.price_key, stockByMcSymbol),
  };
}

export interface ChartPatternsPageData {
  patterns: ParsedChartPattern[];
  sourceTotal: number | null;
}

export async function fetchChartPatternsPage(
  start: number,
  limit: number = CHART_PATTERN_PAGE_SIZE,
): Promise<ChartPatternsPageData> {
  const response = await fetch(buildChartPatternsUrl(start, limit));
  if (!response.ok) {
    throw new Error(`Moneycontrol chart-patterns API returned HTTP ${response.status}`);
  }
  const json = await response.json();
  if (json?.status !== 'success' || !json?.list || !Array.isArray(json.list.data)) {
    throw new Error('Unexpected response shape from Moneycontrol chart-patterns API');
  }
  const stockByMcSymbol = buildMcSymbolMap();
  return {
    patterns: (json.list.data as McChartPatternRaw[]).map(raw => parseChartPatternItem(raw, stockByMcSymbol)),
    sourceTotal: toNumber(json.list.total),
  };
}

export interface ChartPatternInstrument {
  kind: 'stock' | 'index' | 'unknown';
  /** Raw instrument code extracted from price_key (MC scrip code, or index code). */
  code: string | null;
  /** Resolved company name (stocklist lookup) — null when unresolved. */
  name: string | null;
  /** Resolved NSE symbol (stocklist lookup) — null when unresolved. */
  symbol: string | null;
}
