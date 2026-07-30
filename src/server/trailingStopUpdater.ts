/**
 * Trailing Stop Updater
 * =====================
 * Added 2026-07-30 (Finding #29, full-stack audit): a correct ATR chandelier trailing
 * stop (`max(current_stop, highest_high_since_entry - chandelier_mult*ATR)`, ratcheting
 * up, never below the prior stop) already existed and was proven correct in
 * exit_labeler.py/outcome_resolver.py -- but only for OFFLINE backtest/label grading. No
 * live-signal code path ever revisited a stop after entry: atrBarriers.ts computes it once
 * at signal creation and it's written once. A confirmed full-tree grep for
 * `UPDATE ... SET stop_loss` outside the two label-generation modules found none.
 *
 * This closes that gap for `recommendation_log` (the table the audit's own suggested fix
 * points at): for every ACTIVE BUY position, recompute the chandelier stop from the
 * highest high since entry and the current 14-day Wilder ATR (same wilderATR() used by
 * atrBarriers.ts for entry-time barriers, so the live and at-entry ATR conventions match),
 * and ratchet stop_loss UP if the new level clears the current one. Never lowers a stop.
 *
 * Long-only, matching outcome_resolver.py's own documented scope ("long-only — matches
 * the resolver's math") -- this platform has no short (SELL-direction) positions to trail.
 *
 * Run: npx tsx src/server/trailingStopUpdater.ts
 */
import { fileURLToPath } from 'url';
import { dbAll, dbRun } from './dbAsync';
import { wilderATR } from './atrBarriers';

const CHANDELIER_ATR_MULT = 3.0; // mirrors exit_labeler.py / outcome_resolver.py exactly
const ATR_LOOKBACK_BARS = 30;    // matches atrBarriers.ts's getAtrBarriers() convention

interface ActivePosition {
  id: number;
  symbol: string;
  signal_date: string;
  entry_price: number;
  stop_loss: number | null;
}

interface Bar { date: string; high: number; low: number; close: number; }

export async function updateTrailingStops(): Promise<{ updated: number; checked: number }> {
  const positions = await dbAll<ActivePosition>(
    `SELECT id, symbol, signal_date, entry_price, stop_loss
     FROM recommendation_log
     WHERE status = 'ACTIVE' AND rec_type = 'BUY'
       AND entry_price IS NOT NULL AND entry_price > 0`
  );

  let updated = 0;
  for (const pos of positions) {
    try {
      // Highest high since entry (inclusive) -- the chandelier anchor.
      const sinceEntryBars = await dbAll<{ high: number }>(
        `SELECT high FROM stock_ohlcv
         WHERE symbol = ? AND date >= ? AND COALESCE(is_suspect, 0) = 0`,
        [pos.symbol, pos.signal_date]
      );
      if (sinceEntryBars.length === 0) continue;
      const highestHighSinceEntry = Math.max(pos.entry_price, ...sinceEntryBars.map(r => +r.high));

      // Current ATR from the most recent bars (same source/window atrBarriers.ts uses).
      const recentBars = await dbAll<Bar>(
        `SELECT date, high, low, close FROM stock_ohlcv
         WHERE symbol = ? AND COALESCE(is_suspect, 0) = 0
         ORDER BY date DESC LIMIT ?`,
        [pos.symbol, ATR_LOOKBACK_BARS]
      );
      if (recentBars.length < 15) continue; // wilderATR's own minimum, mirrored here
      const ascending = recentBars
        .map(r => ({ high: +r.high, low: +r.low, close: +r.close }))
        .reverse();
      const atr = wilderATR(ascending);
      if (!(atr > 0)) continue;

      const currentStop = pos.stop_loss ?? -Infinity;
      const chandelierStop = highestHighSinceEntry - CHANDELIER_ATR_MULT * atr;
      const newStop = Math.max(currentStop, chandelierStop);

      // Never write a stop above the highest high (degenerate) or a non-improvement.
      if (newStop > currentStop && newStop < highestHighSinceEntry) {
        await dbRun(
          `UPDATE recommendation_log SET stop_loss = ? WHERE id = ?`,
          [Math.round(newStop * 100) / 100, pos.id]
        );
        updated++;
      }
    } catch (e) {
      console.error(`[TrailingStop] Failed for ${pos.symbol} (id=${pos.id}):`, e);
    }
  }

  console.log(`[TrailingStop] Checked ${positions.length} active BUY positions, ratcheted ${updated} stops.`);
  return { updated, checked: positions.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  updateTrailingStops()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
