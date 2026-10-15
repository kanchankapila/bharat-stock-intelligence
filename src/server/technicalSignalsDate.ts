import { dbGet } from './dbAsync';

// MAX(date) on technical_signals returns a day whose first partial scan may hold only a few
// hundred rows with NULL win_probability (live 2026-10-08: 392 of ~2,165). Readers that join
// "the latest day" then show blank or heuristic confidence all session. A day is complete once
// it holds at least half the largest daily count of the last 14 days.
export const LATEST_COMPLETE_TS_DATE_SQL = `(
  SELECT MAX(c.date) FROM (
    SELECT date, COUNT(*) AS n FROM technical_signals WHERE date >= CURRENT_DATE - 14 GROUP BY date
  ) c
  WHERE c.n >= 0.5 * (SELECT MAX(m.n) FROM (
    SELECT COUNT(*) AS n FROM technical_signals WHERE date >= CURRENT_DATE - 14 GROUP BY date
  ) m)
)`;

// AF-20261008-45: win_probability ranks stocks but is not a probability (out of sample, no
// recalibration beat a constant base rate). Readers show its percentile within the latest
// complete day's scored universe instead: 0-100, 100 = highest, ties share the lower rank,
// absent when the stock has no win_probability that day. Level-free, so drift cannot move it.
export const ML_RANK_PCT_SQL = `(
  SELECT symbol, ROUND((100 * percent_rank() OVER (ORDER BY wp))::numeric, 1)::float8 AS "mlRankPct"
  FROM (
    SELECT symbol, NULLIF(win_probability, 'NaN'::float8) AS wp
    FROM technical_signals WHERE date = ${LATEST_COMPLETE_TS_DATE_SQL}
  ) s
  WHERE wp IS NOT NULL
)`;

export async function mlRankPctFor(symbol: string): Promise<number | null> {
  const row = await dbGet<{ mlRankPct: number | null }>(`SELECT "mlRankPct" FROM ${ML_RANK_PCT_SQL} r WHERE symbol = ?`, [symbol]);
  return row?.mlRankPct ?? null;
}

export async function latestCompleteSignalDate(): Promise<string | null> {
  const row = await dbGet<{ d: string | null }>(`SELECT ${LATEST_COMPLETE_TS_DATE_SQL}::text AS d`);
  return row?.d ?? null;
}
