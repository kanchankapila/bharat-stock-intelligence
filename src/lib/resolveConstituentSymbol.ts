import stockData from '../data/stocklist';

// Resolves a provider's opaque per-stock identifier (MC marketmap's `id`, an MC scId, etc.)
// back to the canonical NSE symbol, falling back to a company-name match. Shared by
// MCIndexDetailPanel.tsx/IndexDetailPage.tsx (index constituents) and SectorIntelligence.tsx
// (sector constituents) rather than each keeping its own copy of the same lookup.
export function resolveConstituentSymbol(s: any): string | null {
  // s.id from MC marketmap is the NSE/BSE ticker (e.g. "RELIANCE")
  if (s.id) {
    const bySymbol = stockData.find(st => st.symbol.toUpperCase() === String(s.id).toUpperCase());
    if (bySymbol) return bySymbol.symbol;
    // also try matching against mcsymbol
    const byMc = stockData.find(st => st.mcsymbol?.toUpperCase() === String(s.id).toUpperCase());
    if (byMc) return byMc.symbol;
  }
  // fallback: match company name
  if (s.shortname) {
    const nameLower = String(s.shortname).toLowerCase();
    const byName = stockData.find(st => st.name.toLowerCase() === nameLower);
    if (byName) return byName.symbol;
    const firstWord = nameLower.split(' ')[0];
    if (firstWord.length >= 4) {
      const partial = stockData.find(st => st.name.toLowerCase().startsWith(firstWord));
      if (partial) return partial.symbol;
    }
  }
  return null;
}
