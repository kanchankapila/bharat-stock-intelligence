/**
 * Portfolio view of the published Buy list (AF-20261119-12, display only).
 *
 * The ranker caps weights per name / sector / correlation cluster, but nothing showed the list
 * as one book. This computes, for the CURRENT list held equal-weight over the last
 * LOOKBACK_SESSIONS sessions: beta to NIFTY 50, annualised volatility, average pairwise
 * correlation, maximum drawdown and sector weights. It is a look-back on today's holdings, not a
 * track record (the forward test and paper book are the track record), and it changes no score.
 */
import { dbAll } from './dbAsync';

export const LOOKBACK_SESSIONS = 120;
export const MIN_RETURNS = 60;
const INDEX = 'NIFTY50';

export interface Close { date: string; close: number }
export interface BookRisk {
  names: number;
  excluded: string[];
  sessions: number;
  beta: number | null;
  annualVolPct: number | null;
  avgPairCorr: number | null;
  maxDrawdownPct: number | null;
  sectorWeights: Array<{ sector: string; weightPct: number }>;
  weighting: 'equal';
}

const returnsByDate = (series: Close[]): Map<string, number> => {
  const out = new Map<string, number>();
  const s = [...series].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1].close;
    if (prev > 0 && s[i].close > 0) out.set(s[i].date, s[i].close / prev - 1);
  }
  return out;
};

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const cov = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  return a.reduce((acc, v, i) => acc + (v - ma) * (b[i] - mb), 0) / (a.length - 1);
};
const corr = (a: number[], b: number[]) => {
  const d = Math.sqrt(cov(a, a) * cov(b, b));
  return d > 0 ? cov(a, b) / d : null;
};
const r = (v: number | null, dp: number) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/** Pure: closes per symbol + index closes -> book statistics on the index's trading calendar. */
export function bookRisk(closes: Map<string, Close[]>, index: Close[], sectors: Record<string, string | null | undefined> = {}): BookRisk {
  const idx = returnsByDate(index);
  const dates = [...idx.keys()].sort().slice(-LOOKBACK_SESSIONS);
  const names: Array<{ symbol: string; ret: Map<string, number> }> = [];
  const excluded: string[] = [];
  for (const [symbol, series] of closes) {
    const ret = returnsByDate(series);
    const n = dates.filter(d => ret.has(d)).length;
    if (n >= MIN_RETURNS) names.push({ symbol, ret }); else excluded.push(symbol);
  }
  const empty: BookRisk = { names: 0, excluded: excluded.sort(), sessions: 0, beta: null, annualVolPct: null,
    avgPairCorr: null, maxDrawdownPct: null, sectorWeights: [], weighting: 'equal' };
  if (names.length === 0) return empty;

  // Equal-weight book return per session over the names that traded that session.
  const book: number[] = [], mkt: number[] = [];
  for (const d of dates) {
    const day = names.map(n => n.ret.get(d)).filter((v): v is number => v != null);
    if (day.length) { book.push(mean(day)); mkt.push(idx.get(d)!); }
  }
  let peak = 1, nav = 1, mdd = 0;
  for (const x of book) { nav *= 1 + x; peak = Math.max(peak, nav); mdd = Math.min(mdd, nav / peak - 1); }

  const pairs: number[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const common = dates.filter(d => names[i].ret.has(d) && names[j].ret.has(d));
      if (common.length < MIN_RETURNS) continue;
      const c = corr(common.map(d => names[i].ret.get(d)!), common.map(d => names[j].ret.get(d)!));
      if (c != null) pairs.push(c);
    }
  }
  const varM = book.length > 1 ? cov(mkt, mkt) : 0;
  const counts = new Map<string, number>();
  for (const n of names) {
    const s = sectors[n.symbol] || 'Unknown';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return {
    names: names.length,
    excluded: excluded.sort(),
    sessions: book.length,
    beta: varM > 0 ? r(cov(book, mkt) / varM, 2) : null,
    annualVolPct: book.length > 1 ? r(Math.sqrt(cov(book, book)) * Math.sqrt(252) * 100, 1) : null,
    avgPairCorr: pairs.length ? r(mean(pairs), 2) : null,
    maxDrawdownPct: r(mdd * 100, 1),
    sectorWeights: [...counts].map(([sector, c]) => ({ sector, weightPct: r((100 * c) / names.length, 1)! }))
      .sort((a, b) => b.weightPct - a.weightPct),
    weighting: 'equal',
  };
}

export async function fetchBookRisk(symbols: string[], sectors: Record<string, string | null | undefined>): Promise<BookRisk> {
  const syms = [...new Set(symbols)].filter(Boolean);
  // ~LOOKBACK_SESSIONS sessions fit in 200 calendar days with holidays to spare.
  const from = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
  const rows = syms.length
    ? await dbAll<{ symbol: string; date: string; close: number }>(
      `SELECT symbol, date, close FROM stock_ohlcv
       WHERE symbol IN (${[...syms, INDEX].map(() => '?').join(',')}) AND date >= ?
         AND COALESCE(is_suspect, 0) = 0 AND close > 0`,
      [...syms, INDEX, from])
    : [];
  const closes = new Map<string, Close[]>(syms.map(s => [s, []]));
  const index: Close[] = [];
  for (const row of rows) {
    const c = { date: String(row.date).slice(0, 10), close: Number(row.close) };
    if (row.symbol === INDEX) index.push(c); else closes.get(row.symbol)?.push(c);
  }
  return bookRisk(closes, index, sectors);
}
