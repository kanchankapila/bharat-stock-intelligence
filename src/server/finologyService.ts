/**
 * Finology (ticker.finology.in) — unlocked per-stock valuation + peers, keyed by `fincode`
 * (already present on StockMapping). Adds a daily PE/PB valuation trail and a ready peer table
 * that MoneyControl doesn't expose cleanly. Used by the stock-detail peers tab.
 */
import { getStockMapping } from './stockMapping';
import { fetchWithCache } from './cacheService';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://ticker.finology.in/',
};

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export interface FinologyPeer {
  symbol: string | null; name: string | null; pe: number | null; pb: number | null;
  eps: number | null; evEbitda: number | null; mcapCr: number | null; close: number | null;
  chgPct: number | null; w52High: number | null; w52Low: number | null;
}
export interface FinologyData {
  fincode: number;
  peers: FinologyPeer[];
  peHistory: { date: string; pe: number | null }[];
  brief: string | null;
}

export async function getFinologyData(symbol: string): Promise<FinologyData | null> {
  const fincode = getStockMapping(symbol)?.fincode;
  if (!fincode) return null;

  return fetchWithCache<FinologyData | null>(`finology:${fincode}`, async () => {
    const [peersRaw, valRaw, briefRaw] = await Promise.all([
      fJson(`https://ticker.finology.in/peers.ashx?fincode=${fincode}&mode=S&peercount=10`),
      fJson(`https://ticker.finology.in/GetValuation.ashx?fincode=${fincode}&exc=BSE&top=1&type=Y`),
      fJson(`https://ticker.finology.in/GetCompanybrief.ashx?fincode=${fincode}`),
    ]);

    const peers: FinologyPeer[] = Array.isArray(peersRaw) ? peersRaw.map((p: any) => ({
      symbol: p.SYMBOL ?? null,
      name: p.COMPNAME ?? p.SNAME ?? null,
      pe: num(p.PE), pb: num(p.PB), eps: num(p.EPS), evEbitda: num(p.EV_EBITDA),
      mcapCr: num(p.mcap), close: num(p.CLOSE_PRICE), chgPct: num(p.perchg),
      w52High: num(p['52WeekHigh']), w52Low: num(p['52WeekLow']),
    })) : [];

    const peHistory = Array.isArray(valRaw)
      ? valRaw.map((v: any) => ({ date: String(v.Date).slice(0, 10), pe: num(v.PE) })).filter(x => x.pe != null)
      : [];

    const briefHtml = Array.isArray(briefRaw) ? briefRaw[0]?.COMPANY_BRIEF : null;
    const brief = briefHtml ? String(briefHtml).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;

    if (!peers.length && !peHistory.length && !brief) return null;
    return { fincode, peers, peHistory, brief };
  }, 3600);
}
