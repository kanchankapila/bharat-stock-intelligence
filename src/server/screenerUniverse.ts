import db from './db';

// All NSE/BSE index symbols that may appear in stock_ohlcv.
// These are always included in the scan universe regardless of screener membership.
export const INDEX_SYMBOLS = new Set([
  'NIFTY', 'NIFTY50', 'NIFTY 50', '^NSEI', 'INDIA50',
  'BANKNIFTY', 'NIFTY BANK', '^NSEBANK',
  'FINNIFTY', 'NIFTY FIN SERVICE',
  'MIDCPNIFTY', 'NIFTY MIDCAP 100', 'MIDCAP100',
  'NIFTYIT', 'NIFTY IT',
  'SENSEX', '^BSESN',
  'NIFTY NEXT 50', 'NIFTYNXT50',
  'NIFTY 500', 'NIFTY500',
  'NIFTY AUTO', 'NIFTY FMCG', 'NIFTY PHARMA',
  'NIFTY METAL', 'NIFTY REALTY', 'NIFTY ENERGY',
  'NIFTY INFRA', 'NIFTY MEDIA',
]);

export interface ScreenerUniverse {
  tier1: Set<string>; // ≥2 distinct screeners — full AI + technical scoring
  tier2: Set<string>; // exactly 1 screener — technical scoring only
  all: Set<string>;   // tier1 ∪ tier2
  counts: Map<string, number>;
}

// Each source uses different column names for screener ID and symbol
const SCREENER_SOURCES = [
  { table: 'trendlyne_screener_stocks',   scanCol: 'screener_id' },
  { table: 'moneycontrol_screener_stocks', scanCol: 'scan_id' },
  { table: 'etnow_screener_stocks',        scanCol: 'screener_id' },
] as const;

/**
 * Build a tiered stock universe from all screener tables.
 *
 * Tier 1 (≥2 distinct screeners): eligible for full AI + technical scoring.
 * Tier 2 (exactly 1 screener):    eligible for technical-only scoring.
 * Tier 3 (0 screeners):           skipped unless the user has watchlisted the stock.
 *
 * A "distinct screener" is counted per (source_table, scan_id) pair so that
 * 5 stocks from the same Trendlyne screener still count as 1, while a stock
 * appearing in both a Trendlyne screener and a MoneyControl screener counts as 2.
 *
 * Returns an empty universe (all sets empty) if the screener tables are unpopulated,
 * so callers can fall back to the unfiltered behaviour on a fresh install.
 */
export function getScreenerUniverse(): ScreenerUniverse {
  // symbol → set of unique screener keys across all sources
  const screenersBySymbol = new Map<string, Set<string>>();

  for (const { table, scanCol } of SCREENER_SOURCES) {
    try {
      const rows = db.prepare(
        `SELECT DISTINCT ${scanCol} AS sid, symbol
         FROM ${table}
         WHERE symbol IS NOT NULL AND symbol != '' AND symbol != '#N/A'`
      ).all() as { sid: string; symbol: string }[];

      for (const { sid, symbol } of rows) {
        // Prefix with table name so the same scan_id from different sources stays distinct
        const key = `${table}:${sid}`;
        if (!screenersBySymbol.has(symbol)) screenersBySymbol.set(symbol, new Set());
        screenersBySymbol.get(symbol)!.add(key);
      }
    } catch {
      // Table may not exist on a fresh install; skip silently
    }
  }

  const counts = new Map<string, number>();
  const tier1 = new Set<string>();
  const tier2 = new Set<string>();

  for (const [symbol, screeners] of screenersBySymbol) {
    const n = screeners.size;
    counts.set(symbol, n);
    if (n >= 2) tier1.add(symbol);
    else         tier2.add(symbol);
  }

  return {
    tier1,
    tier2,
    all: new Set([...tier1, ...tier2]),
    counts,
  };
}

/** Convenience: returns all symbols that are watchlisted by any user. */
export function getWatchlistedSymbols(): Set<string> {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT symbol FROM watchlist WHERE symbol IS NOT NULL`
    ).all() as { symbol: string }[];
    return new Set(rows.map(r => r.symbol));
  } catch {
    return new Set();
  }
}
