// Task 3.5: symbol -> companyid (ET Stats) / stockid (MarketsMojo) resolution.
// Per spec §2.5/§2.6 this comes directly from scripts/stocklist.json, not a
// DB table -- Stage 2 never populated provider_security_id with these ids.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('../../../../../scripts/stocklist.json', import.meta.url));

export interface StocklistEntry {
  symbol: string;
  companyid?: string;
  stockid?: string;
  [key: string]: unknown;
}

export function loadStocklist(path: string = process.env.STOCKLIST_JSON_PATH ?? DEFAULT_PATH): StocklistEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as StocklistEntry[];
}

export function buildSymbolIdMaps(entries: StocklistEntry[]): { companyIdBySymbol: Map<string, string>; stockIdBySymbol: Map<string, string> } {
  const companyIdBySymbol = new Map<string, string>();
  const stockIdBySymbol = new Map<string, string>();
  for (const e of entries) {
    const symbol = (e.symbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    if (e.companyid) companyIdBySymbol.set(symbol, String(e.companyid));
    if (e.stockid) stockIdBySymbol.set(symbol, String(e.stockid));
  }
  return { companyIdBySymbol, stockIdBySymbol };
}
