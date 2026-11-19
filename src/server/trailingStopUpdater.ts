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
 * points at): for every ACTIVE BUY / STRONG_BUY position, recompute the chandelier stop from the
 * highest high since entry and the current 14-day Wilder ATR (same wilderATR() used by
 * atrBarriers.ts for entry-time barriers, so the live and at-entry ATR conventions match),
 * and ratchet trailing_stop UP if the new level clears the current one. Never lowers a stop.
 * stop_loss itself is immutable after publication (AF-20261117).
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
  trailing_stop: number | null;
}

interface Bar { symbol: string; date: string; high: number; low: number; close: number; }

// One bounded read for every open position (AF-20261119-14), instead of two stock_ohlcv queries
// per position. The window starts at the earliest open signal_date, and never later than enough
// calendar days to hold ATR_LOOKBACK_BARS sessions. Symbols are read in chunks to bound the IN list.
const ATR_WINDOW_CALENDAR_DAYS = 75;
const SYMBOL_CHUNK = 500;

async function loadBars(symbols: string[], from: string): Promise<Map<string, Bar[]>> {
  const bySymbol = new Map<string, Bar[]>();
  for (let i = 0; i < symbols.length; i += SYMBOL_CHUNK) {
    const chunk = symbols.slice(i, i + SYMBOL_CHUNK);
    const rows = await dbAll<Bar>(
      `SELECT symbol, date, high, low, close FROM stock_ohlcv
       WHERE symbol IN (${chunk.map(() => '?').join(',')}) AND date >= ?
         AND COALESCE(is_suspect, 0) = 0
       ORDER BY symbol, date`,
      [...chunk, from]
    );
    for (const r of rows) {
      const list = bySymbol.get(r.symbol) ?? [];
      list.push({ ...r, date: String(r.date).slice(0, 10), high: +r.high, low: +r.low, close: +r.close });
      bySymbol.set(r.symbol, list);
    }
  }
  return bySymbol;
}

export async function updateTrailingStops(): Promise<{ updated: number; checked: number }> {
  const positions = await dbAll<ActivePosition>(
    `SELECT id, symbol, signal_date, entry_price, stop_loss, trailing_stop
     FROM recommendation_log
     WHERE status = 'ACTIVE' AND rec_type IN ('BUY', 'STRONG_BUY')
       AND entry_price IS NOT NULL AND entry_price > 0`
  );
  if (positions.length === 0) {
    console.log('[TrailingStop] Checked 0 active BUY positions, ratcheted 0 stops.');
    return { updated: 0, checked: 0 };
  }

  const atrFloor = new Date(Date.now() - ATR_WINDOW_CALENDAR_DAYS * 86_400_000).toISOString().slice(0, 10);
  const earliestSignal = positions.map(p => String(p.signal_date).slice(0, 10)).sort()[0];
  const from = earliestSignal < atrFloor ? earliestSignal : atrFloor;
  const bars = await loadBars([...new Set(positions.map(p => p.symbol))], from);

  let updated = 0;
  for (const pos of positions) {
    try {
      const series = bars.get(pos.symbol) ?? [];
      // Highest high since entry -- the chandelier anchor. Entry is the session AFTER the
      // signal date, so the signal-day high is pre-entry (matches outcome_resolver's window).
      const signalDate = String(pos.signal_date).slice(0, 10);
      const sinceEntry = series.filter(b => b.date > signalDate);
      if (sinceEntry.length === 0) continue;
      const highestHighSinceEntry = Math.max(pos.entry_price, ...sinceEntry.map(b => b.high));

      // Current ATR from the most recent bars (same window atrBarriers.ts uses).
      const recent = series.slice(-ATR_LOOKBACK_BARS);
      if (recent.length < 15) continue; // wilderATR's own minimum, mirrored here
      const atr = wilderATR(recent.map(b => ({ high: b.high, low: b.low, close: b.close })));
      if (!(atr > 0)) continue;

      const currentStop = pos.trailing_stop ?? pos.stop_loss ?? -Infinity;
      const chandelierStop = highestHighSinceEntry - CHANDELIER_ATR_MULT * atr;
      const newStop = Math.max(currentStop, chandelierStop);

      // Never write a stop above the highest high (degenerate) or a non-improvement.
      if (newStop > currentStop && newStop < highestHighSinceEntry) {
        // stop_loss is the published plan and the resolver's initial stop; never rewrite it
        // (AF-20261117: overwriting it graded trailed winners as STOP_LOSS -> LOSS).
        await dbRun(
          `UPDATE recommendation_log SET trailing_stop = ? WHERE id = ?`,
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
