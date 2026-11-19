/**
 * Scheduled events that fall inside a published plan's life (AF-20261117-14).
 *
 * Owner decision 2026-11-18: tag only -- no score change. The ranker penalised only results
 * already filed; a corporate-action ex-date or the monthly F&O expiry inside the hold window can
 * move the stock more than the plan's own stop/target distance. Results dates are already shown
 * from `technical_signals.days_to_next_results`, so this adds ex-dates and expiry. An event is
 * tagged only when it falls on or before the plan's own `valid_until`, so no new cutoff is
 * invented. Expiry is the last-Tuesday rule (no holiday shift, see fnoService.lastTuesdayExpiry).
 */
import { dbAll } from './dbAsync';
import { lastTuesdayExpiry } from './fnoService';

const IST_MS = 19_800_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ACTION_LABEL: Record<string, string> = {
  dividend: 'Ex-dividend', bonus: 'Bonus ex-date', split: 'Split ex-date', rights: 'Rights ex-date',
};

export interface PlanWindow { symbol: string; validUntil: unknown }
export interface CorporateActionRow { symbol: string; action_type: string; event_date: string }

/** The IST calendar day of a timestamp / date value, or null when it cannot be read. */
export function istDay(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? new Date(d.getTime() + IST_MS).toISOString().slice(0, 10) : null;
}

const short = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** Pure: event labels per symbol, ordered by date, each inside [today, the plan's valid_until]. */
export function buildPlanEvents(
  plans: PlanWindow[], actions: CorporateActionRow[], fnoSymbols: Set<string>, today: string, expiry: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of plans) {
    const until = istDay(p.validUntil);
    if (!until) continue;
    const events: Array<[string, string]> = [];
    for (const a of actions) {
      if (a.symbol !== p.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(String(a.event_date ?? ''))) continue;
      if (a.event_date < today || a.event_date > until) continue;
      events.push([a.event_date, `${ACTION_LABEL[a.action_type] ?? `${a.action_type} ex-date`} ${short(a.event_date)}`]);
    }
    if (fnoSymbols.has(p.symbol) && expiry >= today && expiry <= until) {
      events.push([expiry, `F&O expiry ${short(expiry)}`]);
    }
    if (events.length) out.set(p.symbol, [...new Set(events.sort().map(e => e[1]))]);
  }
  return out;
}

export async function fetchPlanEvents(plans: PlanWindow[], now: Date = new Date()): Promise<Map<string, string[]>> {
  const symbols = [...new Set(plans.filter(p => p.validUntil != null).map(p => p.symbol))];
  if (!symbols.length) return new Map();
  const today = new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
  const ph = symbols.map(() => '?').join(',');
  const [actions, fno] = await Promise.all([
    dbAll<CorporateActionRow>(
      // record_date is a DATE column: compare its ISO text (LIKE/substring on a DATE raises).
      `SELECT symbol, action_type, record_date::text AS event_date
         FROM stock_corporate_action_history
        WHERE symbol IN (${ph}) AND record_date IS NOT NULL
          AND record_date::text >= ?`,
      [...symbols, today],
    ),
    dbAll<{ symbol: string }>(`SELECT symbol FROM nse_stocks WHERE fno_eligible = 1 AND symbol IN (${ph})`, symbols),
  ]);
  const expiry = lastTuesdayExpiry(new Date(now.getTime() + IST_MS));
  return buildPlanEvents(plans, actions, new Set(fno.map(r => r.symbol)), today, expiry);
}
