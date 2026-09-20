/**
 * Index PE/PB chart reads -- platform history first, MoneyControl live only as fallback.
 *
 * Why not straight MoneyControl (the old source): its fundamentals graph has been observed
 * carrying gross junk on isolated sessions (P/B 26.00/25.00 and P/E ~1.1 around 2025-12-29
 * against a ~3.3/~22.6 median), and the chart page had to render a vendor-data-quality flag
 * to stay honest. The platform's OWN `index_valuation` table (nifty_pe_fetcher.py: daily MC
 * append at 18:00 IST + Trendlyne full-history backfill) holds the repaired series -- verified
 * live 2026-09-19: NIFTY50 2025-12-24..2026-01-05 reads pe 22.6-22.9 / pb 3.53-3.58 where the
 * MC live graph still carries the junk, with 5,865 sessions back to 2003 and every index the
 * frontend offers covered through yesterday.
 *
 * The fallback keeps the page working for an index/window the table does not cover (e.g. a
 * newly mapped index before its first backfill) -- it returns the same shape with
 * source: 'moneycontrol' so the UI can disclose which feed produced the numbers.
 */
import { pgQuery } from './pgClient';

export type IndexValuationPoint = { date: string; value: number; indexValue: number | null };

export type IndexValuationChart = {
  points: IndexValuationPoint[];
  /** 'index_valuation' = repaired platform history; 'moneycontrol' = live vendor graph fallback. */
  source: 'index_valuation' | 'moneycontrol';
  /** Date of the last returned session, so the UI can say how fresh the series is. */
  asOf: string | null;
};

/** Router duration ids -> lookback days (matches nifty_pe_fetcher.py's MC_DURATIONS). */
export function durationToDays(duration: string): number {
  switch (duration) {
    case '1M': return 31;
    case '3M': return 92;
    case '6M': return 183;
    case '3Y': return 1096;
    case '5Y': return 1826;
    case '1Y':
    default: return 365;
  }
}

// Only consulted when index_provider_map has no mc_pe row for an id (a new index mapped
// upstream before the mapping table catches up). Same names nifty_pe_fetcher.py's own
// fallback uses, extended with the two broad indices the frontend offers.
export const MC_PE_ID_FALLBACK: Record<string, string> = {
  '9': 'NIFTY50',
  '23': 'NIFTYBANK',
  '19': 'NIFTYIT',
  '41': 'NIFTYPHARMA',
  '52': 'NIFTYAUTO',
  '39': 'NIFTYFMCG',
  '51': 'NIFTYMETAL',
  '27': 'NIFTYMIDCAP',
  '53': 'NIFTYSMALLCAP',
  '4': 'SENSEX',
  '6': 'NIFTYNEXT50',
  '7': 'NIFTY500',
  '38': 'NIFTYENERGY',
};

/**
 * A window with fewer stored sessions than this is treated as "the table does not really
 * cover this index+window" and the caller falls back to the live vendor graph. Ten is far
 * below anything statistically useful (percentile bands need history) but comfortably above
 * the noise of a holiday-shortened 1M window with a few missing prints.
 */
export const MIN_DB_SESSIONS = 10;

export function hasEnoughCoverage(points: IndexValuationPoint[]): boolean {
  return points.length >= MIN_DB_SESSIONS;
}

/**
 * index_valuation rows -> chart points for one ratio column. NULL ratio cells are ABSENCE
 * (some indices lack early pb/pe prints), not zeros, so those sessions are skipped rather
 * than plotted as 0; finite values pass through verbatim -- outliers included. The page's
 * 3xIQR data-quality flag remains the safety net for anything odd, in any source.
 */
export function rowsToPoints(
  rows: Array<{ date: string; pe: number | null; pb: number | null }>,
  col: 'pe' | 'pb',
): IndexValuationPoint[] {
  const out: IndexValuationPoint[] = [];
  for (const row of rows) {
    const value = row[col];
    if (value == null || !Number.isFinite(value)) continue;
    out.push({ date: row.date, value, indexValue: null });
  }
  return out;
}

/** mc_pe provider id -> canonical index_valuation.index_name, per index_provider_map. */
export async function resolveIndexName(indId: string): Promise<string | null> {
  const rows = await pgQuery<{ index_name: string }>(
    `SELECT index_name FROM index_provider_map WHERE provider = 'mc_pe' AND provider_id = $1 LIMIT 1`,
    [indId],
  );
  return rows[0]?.index_name ?? MC_PE_ID_FALLBACK[indId] ?? null;
}

/**
 * PE/PB history for one index+window: platform index_valuation first, live MoneyControl
 * graph only when the table lacks coverage (or the DB read fails outright).
 */
export async function fetchIndexValuationChart(
  indId: string,
  duration: string,
  col: 'pe' | 'pb',
): Promise<IndexValuationChart> {
  try {
    const indexName = await resolveIndexName(indId);
    if (indexName) {
      const rows = await pgQuery<{ date: string; pe: number | null; pb: number | null }>(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, pe, pb
           FROM index_valuation
          WHERE index_name = $1
            AND date >= CURRENT_DATE - $2::int
          ORDER BY date ASC`,
        [indexName, durationToDays(duration)],
      );
      const points = rowsToPoints(rows, col);
      if (hasEnoughCoverage(points)) {
        return { points, source: 'index_valuation', asOf: points[points.length - 1].date };
      }
    }
  } catch (err) {
    console.warn('[indexValuation] platform history unavailable, falling back to MoneyControl live:', (err as Error).message);
  }

  const { fetchIndexPeChart, fetchIndexPbChart } = await import('./indexApiService');
  const mcPoints = await (col === 'pe'
    ? fetchIndexPeChart(indId, duration)
    : fetchIndexPbChart(indId, duration));
  const points: IndexValuationPoint[] = (mcPoints ?? []).map(p => ({
    date: p.date,
    value: p.value,
    indexValue: typeof p.indexValue === 'number' && Number.isFinite(p.indexValue) ? p.indexValue : null,
  }));
  return {
    points,
    source: 'moneycontrol',
    asOf: points.length > 0 ? points[points.length - 1].date : null,
  };
}
