/**
 * Intraday stop/target-hit alerts for open recommendation_log plans (AF-20261117-15).
 *
 * A published plan's stop or target used to surface only at EOD grading. After each 15-minute
 * intraday-fetcher run this compares today's intraday low/high with each ACTIVE BUY plan's
 * effective stop (`COALESCE(trailing_stop, stop_loss)`, AF-20261117-03) and `target_1`, and sends
 * one Telegram message per tick listing newly touched levels. `stop_alerted_at` /
 * `target_alerted_at` make each event alert once; they are stamped only after delivery succeeds,
 * so a failed send retries on the next tick. Alerts only -- grading stays with outcome_resolver.
 */
import { dbAll, dbRun } from './dbAsync';
import { sanitizeMarkdown, telegramService } from './telegramService';

const MAX_LINES = 40;

export interface PlanBarRow {
  id: number;
  symbol: string;
  stop_loss: number | null;
  trailing_stop: number | null;
  target_1: number | null;
  stop_alerted_at: string | null;
  target_alerted_at: string | null;
  day_low: number | null;
  day_high: number | null;
}

export interface PlanHit {
  id: number;
  symbol: string;
  kind: 'STOP' | 'TRAILING_STOP' | 'TARGET';
  level: number;
  price: number;
}

const num = (v: unknown): number | null => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Newly touched levels. A plan already stopped out gets no later target alert. */
export function detectPlanHits(rows: PlanBarRow[]): PlanHit[] {
  const hits: PlanHit[] = [];
  for (const r of rows) {
    const low = num(r.day_low);
    const high = num(r.day_high);
    const published = num(r.stop_loss);
    const trail = num(r.trailing_stop);
    const stop = trail ?? published;
    const target = num(r.target_1);
    const stopHit = stop != null && low != null && low <= stop && !r.stop_alerted_at;
    if (stopHit) {
      const trailing = trail != null && (published == null || trail > published);
      hits.push({ id: r.id, symbol: r.symbol, kind: trailing ? 'TRAILING_STOP' : 'STOP', level: stop!, price: low! });
    }
    if (target != null && high != null && high >= target && !r.target_alerted_at && !r.stop_alerted_at) {
      hits.push({ id: r.id, symbol: r.symbol, kind: 'TARGET', level: target, price: high });
    }
  }
  return hits;
}

const LABEL: Record<PlanHit['kind'], string> = {
  STOP: 'stop', TRAILING_STOP: 'trailing stop', TARGET: 'target',
};

export function formatPlanHits(hits: PlanHit[], istDate: string): string {
  const both = new Set(
    hits.filter(h => h.kind === 'TARGET').map(h => h.id)
      .filter(id => hits.some(h => h.id === id && h.kind !== 'TARGET')),
  );
  const lines = hits.slice(0, MAX_LINES).map(h => {
    const verb = h.kind === 'TARGET' ? `reached (high ₹${h.price.toFixed(2)})` : `touched (low ₹${h.price.toFixed(2)})`;
    return `• *${sanitizeMarkdown(h.symbol)}* — ${LABEL[h.kind]} ₹${h.level.toFixed(2)} ${verb}`;
  });
  const more = hits.length - lines.length;
  return [
    `🔔 *Plan levels touched* — ${istDate} (15-min bars)`,
    ...lines,
    ...(more > 0 ? [`…and ${more} more`] : []),
    ...(both.size ? ['_Stop and target both touched today: 15-min bars cannot tell which came first._'] : []),
    '_Alert only; EOD grading decides the outcome._',
  ].join('\n');
}

export async function checkRecPlanHits(now: Date = new Date()): Promise<{ checked: number; alerted: number }> {
  const istDate = new Date(now.getTime() + 19_800_000).toISOString().slice(0, 10);
  const sessionStart = `${istDate}T09:15:00+05:30`;
  // Entry is the session after signal_date, so only plans signalled before today are open today.
  const rows = await dbAll<PlanBarRow>(
    `SELECT r.id, r.symbol, r.stop_loss, r.trailing_stop, r.target_1,
            r.stop_alerted_at, r.target_alerted_at, b.day_low, b.day_high
       FROM recommendation_log r
       JOIN (SELECT symbol, MIN(low) AS day_low, MAX(high) AS day_high
               FROM intraday_ohlcv
              WHERE datetime >= ?::timestamptz
              GROUP BY symbol) b ON b.symbol = r.symbol
      WHERE r.status = 'ACTIVE' AND r.rec_type IN ('BUY', 'STRONG_BUY')
        AND r.signal_date < ?::date
        AND r.stop_alerted_at IS NULL`,
    [sessionStart, istDate],
  );
  const hits = detectPlanHits(rows);
  if (!hits.length) return { checked: rows.length, alerted: 0 };

  const delivered = await telegramService.sendMarkdownMessage(formatPlanHits(hits, istDate));
  if (!delivered) throw new Error(`Telegram delivery failed for ${hits.length} plan-level alert(s)`);

  const stopIds = hits.filter(h => h.kind !== 'TARGET').map(h => h.id);
  const targetIds = hits.filter(h => h.kind === 'TARGET').map(h => h.id);
  if (stopIds.length) {
    await dbRun(`UPDATE recommendation_log SET stop_alerted_at = now() WHERE id IN (${stopIds.map(() => '?').join(',')})`, stopIds);
  }
  if (targetIds.length) {
    await dbRun(`UPDATE recommendation_log SET target_alerted_at = now() WHERE id IN (${targetIds.map(() => '?').join(',')})`, targetIds);
  }
  return { checked: rows.length, alerted: hits.length };
}
