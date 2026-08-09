/**
 * unifiedSignalBroadcast.ts — pushes the canonical ranker's highest-conviction picks over
 * WebSocket right after unified_ranker.py finishes each run.
 *
 * Closes a real gap identified in the 2026-08-05 pipeline review: websocketService.ts's
 * `broadcastNewSignal` was only ever called from two minor sources -- the AI-signal path
 * (processAISignal, gated to ~14/2264 stocks/day) and the raw technical scanner (any
 * signalScore > 0, noisy) -- never from `unified_recommendations`, the platform's own
 * canonical ranking (see the "Scoring Authority" section of CLAUDE.md). A WebSocket client
 * subscribed for "a new high-conviction signal" never actually saw the picks the rest of the
 * app treats as authoritative.
 *
 * Deliberately restricted to conviction_level IN ('S_ELITE', 'A_HIGH') -- the platform's own
 * two highest tiers -- so this stays a small, meaningful set (typically single digits to a
 * few dozen symbols/day) rather than reproducing the ~1000-alert/day firehose the AI-signal
 * path was demoted away from on 2026-07-12.
 *
 * Does NOT set `source: 'AI'`, so it never triggers the legacy per-signal Telegram side effect
 * nested inside broadcastNewSignal -- telegramRecommendations.ts's once-daily digest is
 * already the canonical Telegram delivery path for these same picks; triggering both would
 * double-notify. This module is WebSocket-only.
 */
import { dbAll } from './dbAsync';

export interface CanonicalPickRow {
  symbol: string;
  classification: string | null;
  conviction_level: string | null;
  unified_score: number;
  entry_zone_low: number | null;
  target_1: number | null;
  stop_loss: number | null;
  trade_reasoning: string | null;
}

export interface BroadcastTarget {
  broadcastNewSignal: (alert: any) => void;
}

/**
 * Rows the ranker classifies as actionable (see telegramRecommendations.ts's own note on
 * this -- `unified_ranker._classify` emits title-case 'Strong Buy'/'Buy', not SCREAMING_CASE).
 */
const BROADCASTABLE_CLASSIFICATION = ['Strong Buy', 'Buy'];
/** The two highest conviction tiers (S_ELITE, A_HIGH) out of unified_ranker.py's five --
 * see CONVICTION_TIERS in unified_ranker.py. Keeps this channel selective. */
const BROADCASTABLE_CONVICTION = ['S_ELITE', 'A_HIGH'];

export async function fetchBroadcastablePicks(limit = 30): Promise<CanonicalPickRow[]> {
  return dbAll<CanonicalPickRow>(
    `SELECT symbol, classification, conviction_level, unified_score,
            entry_zone_low, target_1, stop_loss, trade_reasoning
       FROM unified_recommendations
      WHERE substring(computed_at, 1, 10) = (
              SELECT max(substring(computed_at, 1, 10)) FROM unified_recommendations)
        AND classification IN (?, ?)
        AND conviction_level IN (?, ?)
      ORDER BY unified_score DESC
      LIMIT ?`,
    [...BROADCASTABLE_CLASSIFICATION, ...BROADCASTABLE_CONVICTION, limit],
  );
}

/**
 * The actual `unified_recommendations.computed_at` calendar day whose picks are currently the
 * latest -- the SAME subquery fetchBroadcastablePicks() already uses, exposed separately so the
 * dedup guard below can key off it directly (2026-08-06 fix, see broadcastCanonicalPicks' own
 * comment for why wall-clock UTC was wrong here).
 */
export async function getLatestUnifiedRecommendationsDay(): Promise<string | null> {
  const row = await dbAll<{ d: string | null }>(
    `SELECT max(substring(computed_at, 1, 10)) AS d FROM unified_recommendations`,
  );
  return row[0]?.d ?? null;
}

// Dedup so a BullMQ retry/catchup re-running unified-ranker doesn't re-broadcast the same
// snapshot's picks a second (or third) time. Module-level state is fine -- exactly one process
// owns the WebSocket server.
let lastBroadcastDay: string | null = null;
let broadcastedSymbols = new Set<string>();

/** Test-only: reset the per-day dedup guard between test cases. */
export function resetBroadcastDedupForTests(): void {
  lastBroadcastDay = null;
  broadcastedSymbols = new Set();
}

/**
 * Broadcasts the latest snapshot's S_ELITE/A_HIGH Buy/Strong Buy rows over WebSocket. Call
 * after unified_ranker.py completes. Never throws -- a broadcast failure must not fail the
 * ranker job itself, since the canonical DB write already succeeded by the time this runs.
 *
 * `day` should normally be omitted -- it then defaults to `unified_recommendations`' own latest
 * `computed_at` day (2026-08-06 fix: the previous default, `new Date().toISOString()`, used the
 * server's UTC wall-clock date while `computed_at` is an IST-trading-day-scoped string; a call
 * straddling a UTC midnight boundary could reset the dedup guard mid-IST-day and re-broadcast,
 * or fail to reset for a genuinely new IST trading day. Keying off the data itself removes the
 * ambiguity entirely -- pass an explicit `day` only from a test that wants to simulate a
 * specific calendar day.
 *
 * Returns the number of symbols actually broadcast (excludes ones already sent for this day).
 */
export async function broadcastCanonicalPicks(
  ws: BroadcastTarget,
  day?: string,
): Promise<number> {
  let rows: CanonicalPickRow[];
  try {
    rows = await fetchBroadcastablePicks();
  } catch (e) {
    console.warn('[UnifiedSignalBroadcast] fetch failed:', (e as Error).message);
    return 0;
  }

  const today = day ?? (await getLatestUnifiedRecommendationsDay().catch(() => null));
  if (today && today !== lastBroadcastDay) {
    lastBroadcastDay = today;
    broadcastedSymbols = new Set();
  }

  const now = new Date().toISOString();
  let sent = 0;
  for (const r of rows) {
    if (broadcastedSymbols.has(r.symbol)) continue;
    broadcastedSymbols.add(r.symbol);
    try {
      ws.broadcastNewSignal({
        type: 'new_signal',
        symbol: r.symbol,
        timestamp: now,
        source: 'UNIFIED',
        generatedAt: now,
        signal: {
          signalType: 'BUY',
          entryPrice: r.entry_zone_low ?? 0,
          targetPrice: r.target_1 ?? 0,
          stopLoss: r.stop_loss ?? 0,
          confidence: Math.round(r.unified_score),
          reasoning: r.trade_reasoning ?? `${r.classification} — ${r.conviction_level} conviction`,
        },
      });
      sent++;
    } catch (e) {
      console.warn(`[UnifiedSignalBroadcast] broadcast failed for ${r.symbol}:`, (e as Error).message);
    }
  }
  return sent;
}
