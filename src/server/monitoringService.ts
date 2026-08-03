import { dbAll, dbRun } from './dbAsync';
import { recordHeartbeat } from './jobHeartbeat';

/**
 * Compute simple screener reliability metrics using `screener_appearances` and `signal_outcomes`.
 * Updates `screener_reliability` table.
 */
export async function updateScreenerReliability(screenerId: string, horizonDays = 7) {
  try {
    // Get recent appearances for this screener
    const appearancesRaw = await dbAll<{ symbol: string; appeared_date: unknown }>(`
      SELECT symbol, appeared_date FROM screener_appearances WHERE screener_id = ? ORDER BY appeared_date DESC LIMIT 500
    `, [screenerId]);

    if (!appearancesRaw || appearancesRaw.length === 0) return { updated: false, reason: 'no_appearances' };

    // appeared_date is timestamptz on Postgres (comes back as a JS Date, local-midnight) while
    // signal_outcomes.signal_date is TEXT — normalize via local date parts (NOT toISOString(),
    // which shifts the calendar day for timezones ahead of UTC) so the join actually matches.
    const toDateStr = (d: unknown): string => {
      if (d instanceof Date) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
      return String(d).slice(0, 10);
    };
    const appearances = appearancesRaw.map(a => ({ symbol: a.symbol, appeared_date: toDateStr(a.appeared_date) }));

    // Pre-load matching outcomes for the whole batch once (was one dbGet per appearance).
    const symbols = [...new Set(appearances.map(a => a.symbol))];
    const placeholders = symbols.map(() => '?').join(',');
    // signal_source='confluence' (2026-08): the default horizonDays=7 is exclusively written
    // by confluence_outcome_tracker.py (outcome_resolver.py never resolves h7) -- this function
    // matches screener_appearances (any screener source) against signal_outcomes by symbol+date
    // as a loose proxy, same pattern as screener_performance.py's phase_a_bootstrap.
    const outcomeRows = await dbAll<{ symbol: string; signal_date: string; outcome: string }>(`
      SELECT symbol, signal_date, outcome FROM signal_outcomes
      WHERE symbol IN (${placeholders}) AND horizon_days = ? AND signal_source = 'confluence'
    `, [...symbols, horizonDays]);
    const outcomeMap = new Map(outcomeRows.map(r => [`${r.symbol}|${r.signal_date}`, r.outcome]));

    let total = 0, wins = 0;
    for (const a of appearances) {
      const outcome = outcomeMap.get(`${a.symbol}|${a.appeared_date}`);
      if (!outcome) continue;
      total += 1;
      if (outcome === 'WIN' || outcome === 'PROFIT') wins += 1;
    }

    const winRate = total === 0 ? 0 : (wins / total);

    await dbRun(`INSERT INTO screener_reliability (scan_id, screener_name, source, total_signals, wins_7d, win_rate_7d, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scan_id) DO UPDATE SET total_signals=excluded.total_signals, wins_7d=excluded.wins_7d, win_rate_7d=excluded.win_rate_7d, last_updated=CURRENT_TIMESTAMP
    `, [screenerId, screenerId, 'platform', total, wins, winRate]);

    return { updated: true, total, wins, winRate };
  } catch (e) {
    console.error('Error updating screener reliability', e);
    return { updated: false, error: e.message };
  }
}

export function triggerRetrainIfNeeded() {
  // Placeholder: real implementation would check dl_model_performance and drift
  console.log('[monitor] triggerRetrainIfNeeded called — not implemented');
  return { triggered: false };
}

export default { updateScreenerReliability, triggerRetrainIfNeeded };
export function updateMonitorState(taskName: string, state: 'success' | 'failed', message?: string) {
  // Fire-and-forget: recordHeartbeat already swallows its own errors and this function's
  // callers (queues.ts worker event handlers) are synchronous void calls.
  void recordHeartbeat(taskName, state, message);
}
