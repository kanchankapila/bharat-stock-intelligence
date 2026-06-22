/**
 * News → stock entity tagger.
 *
 * The old approach matched the NSE *ticker* as a whole word in article text
 * (`\bINFY\b`), but prose names the *company* ("Infosys", "HDFC Bank", "Bajaj Auto"),
 * so ~99% of stock-relevant articles went untagged. This module matches company
 * NAMES (+ curated short forms) instead, which is what actually appears in news.
 */

// Legal-entity suffixes that never appear in prose references — stripped from names.
const LEGAL_SUFFIX = /\b(limited|ltd|private|pvt|corporation|corp|incorporated|inc|company|the)\b/gi;

// Single generic words that, alone, would mass-false-match. A name that reduces to
// just one of these is dropped (multi-word names containing them are kept).
const GENERIC_SINGLE = new Set([
  'india', 'power', 'energy', 'finance', 'financial', 'industries', 'motors',
  'steel', 'cement', 'bank', 'life', 'general', 'national', 'infrastructure',
  'capital', 'technologies', 'technology', 'enterprises', 'international', 'global',
  'products', 'chemicals', 'textiles', 'holdings', 'services', 'auto', 'paper',
]);

/** Normalize to space-delimited lowercase tokens (keeps & for "L&T"/"M&M"). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Aliases derived from a company name (currently the cleaned full name, or none). */
export function companyAliases(name: string): string[] {
  if (!name) return [];
  let s = name.replace(/\(.*?\)/g, ' ').replace(/[.,]/g, ' ');
  s = s.replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 4) return [];
  if (!s.includes(' ') && GENERIC_SINGLE.has(s.toLowerCase())) return [];
  return [s];
}

// Curated short forms that appear in headlines but aren't derivable from the legal name.
export const NEWS_ALIAS_OVERRIDES: Record<string, string[]> = {
  TCS: ['TCS'], RELIANCE: ['RIL'], LT: ['L&T'], 'M&M': ['M&M'], MARUTI: ['Maruti'],
  SBIN: ['SBI', 'State Bank'], HINDUNILVR: ['HUL'], ICICIBANK: ['ICICI Bank', 'ICICI'],
  KOTAKBANK: ['Kotak'], AXISBANK: ['Axis Bank'], BAJFINANCE: ['Bajaj Finance'],
  ONGC: ['ONGC'], NTPC: ['NTPC'], BPCL: ['BPCL'], IOC: ['IOC', 'Indian Oil'],
  COALINDIA: ['Coal India'], POWERGRID: ['Power Grid'], ULTRACEMCO: ['UltraTech'],
  ADANIENT: ['Adani Enterprises'], ADANIPORTS: ['Adani Ports'], TATASTEEL: ['Tata Steel'],
  TATAMOTORS: ['Tata Motors'], JSWSTEEL: ['JSW Steel'], WIPRO: ['Wipro'], HCLTECH: ['HCL Tech'],
};

export interface AliasEntry { symbol: string; alias: string; len: number; }

/**
 * Build a match index from {symbol,name} rows plus optional curated short forms
 * (e.g. TCS, RIL, L&T). Sorted longest-alias-first so specific names win the cap.
 */
export function buildAliasIndex(
  stocks: { symbol: string; name: string }[],
  extra: Record<string, string[]> = {},
): AliasEntry[] {
  const out: AliasEntry[] = [];
  const push = (symbol: string, raw: string) => {
    const a = norm(raw);
    if (a.length >= 2) out.push({ symbol, alias: a, len: a.length });
  };
  for (const { symbol, name } of stocks) {
    for (const a of companyAliases(name)) push(symbol, a);
    for (const a of (extra[symbol] ?? [])) push(symbol, a);
  }
  return out.sort((a, b) => b.len - a.len);
}

/** Symbols whose company name/alias appears (whole-token) in the text, capped at `max`. */
export function extractSymbolsByName(text: string, index: AliasEntry[], max = 5): string[] {
  if (!text) return [];
  const t = ` ${norm(text)} `;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const e of index) {
    if (seen.has(e.symbol)) continue;
    if (t.includes(` ${e.alias} `)) {
      found.push(e.symbol);
      seen.add(e.symbol);
      if (found.length >= max) break;
    }
  }
  return found;
}
