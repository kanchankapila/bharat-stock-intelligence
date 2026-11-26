/**
 * Live check of a published plan against the session it was published for (AF-20261119-21).
 *
 * The canonical plans are written at ~22:30 IST for the next session, and nothing looked at them again
 * until the next night: a Buy whose stock opened below its stop, or that ran through its target, or that
 * got a negative price-sensitive filing at 11:00, still read "ACTIVE" all day. This classifies each plan
 * from the 5-minute live quote (open / day high / day low / last) and flags high-impact bearish news
 * published after the plan. Display and alerting only: it changes no score, weight or ranking, and the
 * plan's own entry zone, stop and target are the only thresholds used.
 */
import { dbAll } from './dbAsync';
import type { LiveQuote, LiveQuoteSnapshot } from './liveQuotes';

export type LivePlanState =
  | 'GAPPED_BELOW_STOP' | 'STOP_HIT' | 'STOP_AND_TARGET_TOUCHED' | 'TARGET_HIT'
  | 'GAPPED_ABOVE_ENTRY' | 'IN_ENTRY_ZONE' | 'ABOVE_ENTRY' | 'BELOW_ENTRY' | 'ACTIVE';

export interface PlanLevels {
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  target: number | null;
}

export interface LivePlanCheck {
  state: LivePlanState;
  label: string;
  /** true for states where the published plan should not be acted on as written. */
  invalidated: boolean;
}

const IST_MS = 19_800_000;

const LABEL: Record<LivePlanState, [string, boolean]> = {
  GAPPED_BELOW_STOP: ['Opened below the stop: plan invalid', true],
  STOP_HIT: ['Stop touched today: plan invalid', true],
  STOP_AND_TARGET_TOUCHED: ['Stop and target both touched today', true],
  TARGET_HIT: ['Target touched today', true],
  GAPPED_ABOVE_ENTRY: ['Opened above the entry zone and never came back: do not chase', true],
  IN_ENTRY_ZONE: ['Trading inside the entry zone', false],
  ABOVE_ENTRY: ['Above the entry zone', false],
  BELOW_ENTRY: ['Below the entry zone, above the stop', false],
  ACTIVE: ['Active', false],
};

const n = (v: unknown): number | null => {
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;
};

export function planLevels(row: Record<string, unknown>): PlanLevels {
  return {
    entryLow: n(row.entry_zone_low), entryHigh: n(row.entry_zone_high),
    stop: n(row.stop_loss), target: n(row.target_1),
  };
}

/**
 * True when the snapshot was taken during a session that opened after the plan was published. Before
 * that, the quote's open/high/low belong to the session the plan was BUILT from, and judging the plan
 * against them would use information the plan already priced in.
 */
export function sessionAfterPublish(publishedAt: unknown, snap: Pick<LiveQuoteSnapshot, 'asOf' | 'marketOpen'>): boolean {
  if (snap.marketOpen !== true || !snap.asOf || publishedAt == null) return false;
  const asOf = new Date(snap.asOf).getTime();
  const pub = new Date(publishedAt instanceof Date ? publishedAt : String(publishedAt)).getTime();
  if (!Number.isFinite(asOf) || !Number.isFinite(pub)) return false;
  const istDay = new Date(asOf + IST_MS).toISOString().slice(0, 10);
  const sessionOpen = Date.parse(`${istDay}T09:15:00+05:30`);
  return sessionOpen > pub && asOf >= sessionOpen;
}

/** Pure: the plan's state against today's live quote, or null when there is no usable price. */
export function livePlanCheck(levels: PlanLevels, q: LiveQuote | undefined | null): LivePlanCheck | null {
  const price = q?.price ?? null;
  if (price == null) return null;
  const low = q?.low ?? price;
  const high = q?.high ?? price;
  const open = q?.open ?? null;
  const { entryLow, entryHigh, stop, target } = levels;
  const stopHit = stop != null && low <= stop;
  const targetHit = target != null && high >= target;

  let state: LivePlanState = 'ACTIVE';
  if (stop != null && open != null && open <= stop) state = 'GAPPED_BELOW_STOP';
  else if (stopHit && targetHit) state = 'STOP_AND_TARGET_TOUCHED';
  else if (stopHit) state = 'STOP_HIT';
  else if (targetHit) state = 'TARGET_HIT';
  else if (entryHigh != null && open != null && open > entryHigh && low > entryHigh) state = 'GAPPED_ABOVE_ENTRY';
  else if (entryLow != null && entryHigh != null && price >= entryLow && price <= entryHigh) state = 'IN_ENTRY_ZONE';
  else if (entryHigh != null && price > entryHigh) state = 'ABOVE_ENTRY';
  else if (entryLow != null && price < entryLow) state = 'BELOW_ENTRY';

  const [label, invalidated] = LABEL[state];
  return { state, label, invalidated };
}

export interface NewsRow { title: string; published_at: unknown; symbols_json: string | null }

const MACRO_DISQUALIFIERS = ['gold import', 'anti-drone missile', 'supermoon', 'gta 6', 'marathon', 'nitish setu'];
const ROUNDUP_HEADLINE_RE = /\b(stock picks|stocks to watch|top picks|buzzing stocks|stocks in news|market wrap|sector wrap|gainers\b.*\blosers)\b|\bnifty\s*(?:500|50)\s*:/i;

/** Pure: high-impact bearish headlines per symbol published after each plan, newest first, at most 2. */
export function eventRisk(
  plans: Array<{ symbol: string; publishedAt: unknown }>, news: NewsRow[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sorted = [...news].sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  for (const p of plans) {
    const pub = new Date(p.publishedAt instanceof Date ? p.publishedAt : String(p.publishedAt)).getTime();
    if (!Number.isFinite(pub)) continue;
    const hits: string[] = [];
    const symRe = new RegExp(`\\b${p.symbol}\\b`, 'i');
    for (const item of sorted) {
      const t = new Date(item.published_at instanceof Date ? item.published_at : String(item.published_at)).getTime();
      if (!Number.isFinite(t) || t <= pub) continue;
      let syms: unknown = [];
      try { syms = JSON.parse(item.symbols_json ?? '[]'); } catch { syms = []; }
      if (!Array.isArray(syms) || !syms.includes(p.symbol)) continue;
      // Filter out obvious syndicated macro news mismatches and multi-stock roundups that lack the stock's symbol
      if (MACRO_DISQUALIFIERS.some((d) => item.title.toLowerCase().includes(d)) && !symRe.test(item.title)) continue;
      if (ROUNDUP_HEADLINE_RE.test(item.title) && !symRe.test(item.title)) continue;
      if (syms.length >= 3 && !symRe.test(item.title)) continue;
      if (!hits.includes(item.title)) hits.push(item.title);
      if (hits.length === 2) break;
    }
    if (hits.length) out.set(p.symbol, hits);
  }
  return out;
}

/** High-impact bearish news published after the earliest plan; a failed read is an empty map. */
export async function fetchEventRisk(plans: Array<{ symbol: string; publishedAt: unknown }>): Promise<Map<string, string[]>> {
  const times = plans.map((p) => new Date(p.publishedAt instanceof Date ? p.publishedAt : String(p.publishedAt)).getTime())
    .filter(Number.isFinite);
  if (!times.length) return new Map();
  try {
    const news = await dbAll<NewsRow>(
      `SELECT title, published_at, symbols_json FROM news_sentiment_items
        WHERE impact = 'HIGH' AND sentiment = 'BEARISH' AND published_at > ?
        ORDER BY published_at DESC LIMIT 500`,
      [new Date(Math.min(...times)).toISOString()],
    );
    return eventRisk(plans, news);
  } catch (e) {
    console.warn('[planGuard] event-risk news unavailable:', (e as Error).message);
    return new Map();
  }
}

