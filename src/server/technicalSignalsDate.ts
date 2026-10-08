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

export async function latestCompleteSignalDate(): Promise<string | null> {
  const row = await dbGet<{ d: string | null }>(`SELECT ${LATEST_COMPLETE_TS_DATE_SQL}::text AS d`);
  return row?.d ?? null;
}
