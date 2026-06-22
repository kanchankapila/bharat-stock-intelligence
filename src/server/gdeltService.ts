/**
 * GDELT 2.0 DOC API — free historical news TONE per company (no API key).
 *
 * `mode=timelinetone` returns a daily average-tone time series for a query, with
 * history back to 2015 — so it can backfill per-stock sentiment over the ML training
 * window, which RSS/Google-News cannot. Tone is GDELT's own measure (roughly -100..+100,
 * typically -10..+10; positive = positive coverage).
 *
 * Rate limit: GDELT throttles to ~1 request / 5 s and blocks bursty/cloud IPs (returning a
 * plain-text limit message instead of JSON — parseGdeltTimeline handles that as []). Run the
 * backfill from a normal IP with >=5 s spacing.
 */
import { dbAll, dbRun } from './dbAsync';
import { buildAliasIndex, extractSymbolsByName, companyAliases, NEWS_ALIAS_OVERRIDES } from './newsEntityTagger';

export interface GdeltTonePoint { date: string; tone: number; }

/** Parse a GDELT timelinetone JSON body into {date:'YYYY-MM-DD', tone} points.
 *  Returns [] for the throttle text response or any unexpected shape. */
export function parseGdeltTimeline(body: string): GdeltTonePoint[] {
  let j: any;
  try { j = JSON.parse(body); } catch { return []; }
  const data = j?.timeline?.[0]?.data;
  if (!Array.isArray(data)) return [];
  const out: GdeltTonePoint[] = [];
  for (const pt of data) {
    const m = String(pt?.date ?? '').match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m || typeof pt?.value !== 'number') continue;
    out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, tone: pt.value });
  }
  return out;
}

const YMD = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '') + '000000';

/** Fetch the daily average-tone series for one company over [start,end]. */
export async function fetchGdeltTone(company: string, start: Date, end: Date): Promise<GdeltTonePoint[]> {
  const q = encodeURIComponent(`"${company}"`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}`
    + `&mode=timelinetone&format=json&startdatetime=${YMD(start)}&enddatetime=${YMD(end)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BharatStockIntel/1.0' } });
    clearTimeout(timer);
    return parseGdeltTimeline(await res.text());
  } catch { return []; }
}

async function ensureTable(): Promise<void> {
  await dbRun(`CREATE TABLE IF NOT EXISTS gdelt_sentiment (
    symbol TEXT NOT NULL, date TEXT NOT NULL, avg_tone REAL,
    computed_at TEXT, PRIMARY KEY (symbol, date)
  )`);
}

/**
 * Backfill GDELT daily tone for the top-market-cap universe over [start,end].
 * Rate-limited to one request / 5 s. Returns rows written.
 * NOTE: validate from a non-throttled IP — cloud/shared IPs get blocked by GDELT.
 */
export async function runGdeltBackfill(start: Date, end: Date, limit = 150): Promise<{ companies: number; rows: number }> {
  await ensureTable();
  const universe = await dbAll(
    `SELECT ns.symbol, ns.name FROM nse_stocks ns
     JOIN stock_fundamentals sf ON sf.symbol = ns.symbol
     WHERE ns.status = 'ACTIVE' AND ns.name IS NOT NULL AND sf.market_cap IS NOT NULL
     ORDER BY sf.market_cap DESC LIMIT ?`, [limit],
  ) as { symbol: string; name: string }[];

  let rows = 0;
  for (const { symbol, name } of universe) {
    const company = companyAliases(name)[0] ?? name;
    const series = await fetchGdeltTone(company, start, end);
    for (const pt of series) {
      await dbRun(
        `INSERT INTO gdelt_sentiment (symbol, date, avg_tone, computed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(symbol, date) DO UPDATE SET avg_tone = excluded.avg_tone, computed_at = excluded.computed_at`,
        [symbol, pt.date, pt.tone, new Date().toISOString()],
      );
      rows++;
    }
    await new Promise(r => setTimeout(r, 5200)); // GDELT rate limit
  }
  return { companies: universe.length, rows };
}

// (alias index kept available for future per-article GDELT artlist tagging)
export const _gdeltAliasIndex = () =>
  dbAll(`SELECT symbol, name FROM nse_stocks WHERE status='ACTIVE' AND name IS NOT NULL`)
    .then((rows: any) => buildAliasIndex(rows, NEWS_ALIAS_OVERRIDES))
    .then(idx => (text: string) => extractSymbolsByName(text, idx));
