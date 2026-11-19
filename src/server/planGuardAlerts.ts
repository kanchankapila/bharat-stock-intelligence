/**
 * Intraday alerts for published plans that today's session has invalidated (AF-20261119-21).
 *
 * Runs inside the 15-minute intraday pipeline (market hours only). Sends one Telegram message listing
 * plans that newly opened below their stop, touched the stop or target, opened above the entry zone
 * and never came back, or got high-impact bearish news after publication. Each (symbol, state) and
 * each headline is sent at most once per IST day. Report only: nothing here changes a score.
 */
import { dbAll, dbGet, dbRun } from './dbAsync';
import { loadLiveQuotes } from './liveQuotes';
import { fetchEventRisk, livePlanCheck, planLevels, sessionAfterPublish } from './planGuard';
import { sanitizeMarkdown, telegramService } from './telegramService';

const IST_MS = 19_800_000;
const KEY_PREFIX = 'plan_guard_alerted:';

interface PlanRow {
  symbol: string; computed_at: unknown; entry_zone_low: number | null; entry_zone_high: number | null;
  stop_loss: number | null; target_1: number | null;
}

/** Pure: the alert lines not yet sent today, and the updated sent-set. */
export function newAlertLines(
  items: Array<{ key: string; line: string }>, alreadySent: string[],
): { lines: string[]; sent: string[] } {
  const seen = new Set(alreadySent);
  const lines: string[] = [];
  for (const it of items) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    lines.push(it.line);
  }
  return { lines, sent: [...seen] };
}

export async function sendPlanGuardAlerts(now: Date = new Date()): Promise<{ skipped?: string; sent: number }> {
  const live = await loadLiveQuotes();
  // Same TOP tier the Best Picks page and the evening digest publish.
  const plans = await dbAll<PlanRow>(
    `SELECT symbol, computed_at, entry_zone_low, entry_zone_high, stop_loss, target_1
       FROM unified_recommendations
      WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
        AND classification IN ('Buy', 'Strong Buy') AND conviction_level IN ('S_ELITE', 'A_HIGH')
      ORDER BY unified_score DESC LIMIT 60`,
  );
  if (!plans.length) return { skipped: 'no published plans', sent: 0 };
  if (!sessionAfterPublish(plans[0].computed_at, live)) return { skipped: 'no live session since publication', sent: 0 };

  const risk = await fetchEventRisk(plans.map((p) => ({ symbol: p.symbol, publishedAt: p.computed_at })));
  const items: Array<{ key: string; line: string }> = [];
  for (const p of plans) {
    const quote = live.quotes.get(p.symbol);
    const check = livePlanCheck(planLevels(p as unknown as Record<string, unknown>), quote);
    if (check?.invalidated) {
      const px = quote?.price != null ? ` (₹${quote.price})` : '';
      items.push({ key: `${p.symbol}:${check.state}`, line: `• *${sanitizeMarkdown(p.symbol)}* ${sanitizeMarkdown(check.label)}${px}` });
    }
    for (const h of risk.get(p.symbol) ?? []) {
      items.push({ key: `${p.symbol}:news:${h}`, line: `• *${sanitizeMarkdown(p.symbol)}* news since plan: ${sanitizeMarkdown(h)}` });
    }
  }

  const key = KEY_PREFIX + new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
  const row = await dbGet<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]);
  let already: string[] = [];
  try { already = row?.value ? JSON.parse(row.value) : []; } catch { already = []; }
  const { lines, sent } = newAlertLines(items, Array.isArray(already) ? already : []);
  if (!lines.length) return { sent: 0 };

  await telegramService.sendMarkdownMessage(
    ['⚠️ *Published plans changed in today\'s session*', ...lines,
     '_Plan levels are the published ones; nothing here re-scores a stock._'].join('\n'),
  );
  await dbRun(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(sent)],
  );
  return { sent: lines.length };
}
