import db from './db';

/**
 * Compute simple screener reliability metrics using `screener_appearances` and `signal_outcomes`.
 * Updates `screener_reliability` table.
 */
export function updateScreenerReliability(screenerId: string, horizonDays = 7) {
  try {
    // Get recent appearances for this screener
    const appearances = db.prepare(`
      SELECT symbol, appeared_date FROM screener_appearances WHERE screener_id = ? ORDER BY appeared_date DESC LIMIT 500
    `).all(screenerId) as Array<{ symbol: string; appeared_date: string }>;

    if (!appearances || appearances.length === 0) return { updated: false, reason: 'no_appearances' };

    let total = 0, wins = 0;
    for (const a of appearances) {
      // Find a matching outcome within horizonDays after appeared_date
      const checkDate = new Date(a.appeared_date);
      checkDate.setDate(checkDate.getDate() + horizonDays);
      const checkDateStr = checkDate.toISOString().slice(0,10);

      const outcome = db.prepare(`SELECT outcome FROM signal_outcomes WHERE symbol = ? AND signal_date = ? AND horizon_days = ?`).get(a.symbol, a.appeared_date, horizonDays) as any;
      if (!outcome) continue;
      total += 1;
      if (outcome.outcome === 'WIN' || outcome.outcome === 'PROFIT') wins += 1;
    }

    const winRate = total === 0 ? 0 : (wins / total);

    db.prepare(`INSERT INTO screener_reliability (scan_id, screener_name, source, total_signals, wins_7d, win_rate_7d, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scan_id) DO UPDATE SET total_signals=excluded.total_signals, wins_7d=excluded.wins_7d, win_rate_7d=excluded.win_rate_7d, last_updated=CURRENT_TIMESTAMP
    `).run(screenerId, screenerId, 'platform', total, wins, winRate);

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
