/**
 * Read side of the live quote cache written by liveStockData.runBulkRefresh (every 5 min in market hours).
 *
 * The cache holds a MarketData[] ARRAY, and cacheGet already returns it parsed. Three readers
 * (getBuyRecommendations, getCommandCenter, getStrategyPicks) ran JSON.parse on that array, which throws,
 * was swallowed, and left them on the stored EOD close every time: the "live" price on Best Picks was
 * never live, and they read `changePercent` where the quote field is `changePct` (AF-20261119-21).
 */
import { cacheGet } from './cacheService';

export const LIVE_BULK_KEY = 'live-stocks-bulk';
export const LIVE_META_KEY = 'live-stocks-bulk:meta';

export interface LiveQuote {
  symbol: string;
  price: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
}

export interface LiveQuoteSnapshot {
  quotes: Map<string, LiveQuote>;
  /** When the snapshot was fetched, and whether the market was open then (null if unknown). */
  asOf: string | null;
  marketOpen: boolean | null;
}

// A quote source returns 0 for a field it does not have; a price of 0 is never real.
const pos = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Pure: any cached shape (array, symbol-keyed object, or a JSON string of either) -> quotes by symbol. */
export function toQuoteMap(raw: unknown): Map<string, LiveQuote> {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return new Map(); }
  }
  const items: any[] = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as object) : [];
  const out = new Map<string, LiveQuote>();
  for (const q of items) {
    const symbol = typeof q?.symbol === 'string' ? q.symbol : null;
    if (!symbol) continue;
    out.set(symbol, {
      symbol,
      price: pos(q.price ?? q.lastPrice),
      changePct: num(q.changePct ?? q.changePercent),
      open: pos(q.open),
      high: pos(q.high),
      low: pos(q.low),
      prevClose: pos(q.prevClose),
    });
  }
  return out;
}

/** Never throws: a missing or unreadable cache is an empty snapshot, and callers fall back to EOD. */
export async function loadLiveQuotes(): Promise<LiveQuoteSnapshot> {
  try {
    const [raw, meta] = await Promise.all([
      cacheGet<unknown>(LIVE_BULK_KEY),
      cacheGet<{ asOf?: string; marketOpen?: boolean }>(LIVE_META_KEY),
    ]);
    return {
      quotes: toQuoteMap(raw),
      asOf: typeof meta?.asOf === 'string' ? meta.asOf : null,
      marketOpen: typeof meta?.marketOpen === 'boolean' ? meta.marketOpen : null,
    };
  } catch {
    return { quotes: new Map(), asOf: null, marketOpen: null };
  }
}
