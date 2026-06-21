import { dbGet, dbAll, dbRun } from './dbAsync';

/**
 * Compute simple screener reliability metrics using `screener_appearances` and `signal_outcomes`.
 * Updates `screener_reliability` table.
 */
export async function updateScreenerReliability(screenerId: string, horizonDays = 7) {
  try {
    // Get recent appearances for this screener
    const appearances = await dbAll<{ symbol: string; appeared_date: string }>(`
      SELECT symbol, appeared_date FROM screener_appearances WHERE screener_id = ? ORDER BY appeared_date DESC LIMIT 500
    `, [screenerId]);

    if (!appearances || appearances.length === 0) return { updated: false, reason: 'no_appearances' };

    let total = 0, wins = 0;
    for (const a of appearances) {
      const outcome = await dbGet<any>(`SELECT outcome FROM signal_outcomes WHERE symbol = ? AND signal_date = ? AND horizon_days = ?`, [a.symbol, a.appeared_date, horizonDays]);
      if (!outcome) continue;
      total += 1;
      if (outcome.outcome === 'WIN' || outcome.outcome === 'PROFIT') wins += 1;
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
  // no-op for now to fix typescript
}
