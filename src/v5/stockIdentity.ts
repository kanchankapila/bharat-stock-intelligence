import stockData from '../data/stocklist';

const NAME_BY_SYMBOL = new Map<string, string>(
  stockData.map((s) => [String(s.symbol || '').toUpperCase(), String(s.name || '').trim()])
);

export function stockDisplayName(symbol?: string | null, fallback = '—'): string {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return fallback;
  return NAME_BY_SYMBOL.get(sym) || sym;
}
