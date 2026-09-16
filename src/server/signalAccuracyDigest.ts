/**
 * Signal-accuracy digest — pushes the reverse-engineering result nobody was reading.
 *
 * `high_flyer_retrospective.py` already runs nightly inside ml-daily-ops and answers the
 * question that matters: of the stocks that actually flew today, how many did any of our
 * systems flag in advance, and how many did we call the WRONG WAY (a flyer we rated Sell, a
 * diver we rated Buy — the CELLO failure, sharper than a plain miss).
 *
 * It writes `high_flyer_daily_stats` / `high_flyer_retrospective`, whose only reader was a
 * widget on the v4 dashboard — and v4 is not the default shell (v6 is). So the numbers were
 * computed every night and landed somewhere nobody opens. This module sends them.
 *
 * Deliberately NOT a new BullMQ queue: it is called at the tail of ml-daily-ops, immediately
 * after the retrospective writes, so it can never report a stale day.
 */
import { dbAll } from './dbAsync';
import { telegramService, sanitizeMarkdown } from './telegramService';

/** Recall below this is worth shouting about rather than reporting flatly. */
export const RECALL_ALERT_FLOOR = 0.10;
/** How many named wrong-direction calls to list before truncating. */
const MAX_NAMED = 5;
/** Trailing window for the recall trend line. */
const TREND_DAYS = 7;

/** Directional prior-call split for one movers class (flyers or divers). The "correct"
 *  bucket always means "the prior call agreed with the move that happened": for flyers
 *  that is a prior Buy/Strong Buy, for divers a prior Sell/Strong Sell. */
export interface PriorCallBuckets {
  correct: number;
  wrong: number;
  neutral: number; // Hold / NULL / anything else the engine did not take a side on
}

export interface AccuracyDigest {
  date: string;
  flyers: number;
  divers: number;
  recallAny: number | null;
  wrongBearish: number;
  wrongBullish: number;
  trend: Array<{ date: string; recall: number | null }>;
  worstCalls: Array<{ symbol: string; returnPct: number; priorClassification: string }>;
  flyerCalls: PriorCallBuckets;
  diverCalls: PriorCallBuckets;
  confirmedCalls: Array<{ symbol: string; returnPct: number; priorClassification: string }>;
}

/** Same vocabulary the engine uses (unified_ranker._classify emits these title-case
 *  strings, and the class sets are pinned by test_high_flyer_retrospective.py). */
const BUY_SET = new Set(['Buy', 'Strong Buy']);
const SELL_SET = new Set(['Sell', 'Strong Sell']);

function priorBucket(prior: string | null, isFlyer: boolean): 'correct' | 'wrong' | 'neutral' {
  if (!prior || prior === 'Hold') return 'neutral';
  if (isFlyer) return BUY_SET.has(prior) ? 'correct' : SELL_SET.has(prior) ? 'wrong' : 'neutral';
  return SELL_SET.has(prior) ? 'correct' : BUY_SET.has(prior) ? 'wrong' : 'neutral';
}

function parseRecall(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** NaN is truthy, so `Number(x) || 0` is not a guard here — see .claude/rules/recurring-bugs.md */
function finiteOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function buildAccuracyDigest(): Promise<AccuracyDigest | null> {
  const stats = await dbAll<{
    date: string;
    universe_n: number | null;
    flyer_n: number | null;
    recall_json: string | null;
  }>(
    `SELECT date, universe_n, flyer_n, recall_json
     FROM high_flyer_daily_stats
     ORDER BY date DESC
     LIMIT ?`,
    [TREND_DAYS]
  );
  if (!stats.length) return null;

  const today = stats[0];
  const recall = parseRecall(today.recall_json);

  // Only rows the retrospective itself marked wrong_call — don't re-derive the rule here,
  // or this digest and the engine can drift into disagreeing about what "wrong" means.
  const worst = await dbAll<{
    symbol: string;
    return_pct: number;
    prior_classification: string | null;
  }>(
    `SELECT symbol, return_pct, prior_classification
     FROM high_flyer_retrospective
     WHERE date = ? AND wrong_call = 1
     ORDER BY ABS(return_pct) DESC
     LIMIT ?`,
    [today.date, MAX_NAMED]
  );

  // Direction split — of today's flyers/divers, how many had a prior Buy vs Sell call.
  // Bucketed HERE from the engine's own retrospective rows (not re-derived): a row with
  // return_pct >= 0 is a flyer ('up'), < 0 a diver ('down') — the sign of a detected move.
  const todayRows = await dbAll<{
    return_pct: number | null;
    prior_classification: string | null;
  }>(
    `SELECT return_pct, prior_classification
     FROM high_flyer_retrospective
     WHERE date = ?`,
    [today.date]
  );
  const empty: PriorCallBuckets = { correct: 0, wrong: 0, neutral: 0 };
  const flyerCalls: PriorCallBuckets = { ...empty };
  const diverCalls: PriorCallBuckets = { ...empty };
  for (const row of todayRows) {
    const isFlyer = finiteOr(row.return_pct, 0) >= 0;
    const target = isFlyer ? flyerCalls : diverCalls;
    target[priorBucket(row.prior_classification, isFlyer)]++;
  }

  // The reciprocal of worstCalls: the flyers we RATED Buy/Strong Buy in advance and that
  // then made high — "as recommended", so the report shows both halves of the confusion.
  const confirmed = await dbAll<{
    symbol: string;
    return_pct: number;
    prior_classification: string | null;
  }>(
    `SELECT symbol, return_pct, prior_classification
     FROM high_flyer_retrospective
     WHERE date = ? AND prior_classification IN ('Buy', 'Strong Buy') AND return_pct >= 0
     ORDER BY return_pct DESC
     LIMIT ?`,
    [today.date, MAX_NAMED]
  );

  return {
    date: today.date,
    flyers: finiteOr(today.flyer_n, 0),
    divers: finiteOr(recall.diver_n, 0),
    recallAny: Number.isFinite(Number(recall.any)) ? Number(recall.any) : null,
    wrongBearish: finiteOr(recall.wrong_bearish_miss, 0),
    wrongBullish: finiteOr(recall.wrong_bullish_miss, 0),
    trend: stats.map(s => {
      const r = parseRecall(s.recall_json);
      return {
        date: s.date,
        recall: Number.isFinite(Number(r.any)) ? Number(r.any) : null,
      };
    }),
    worstCalls: worst.map(w => ({
      symbol: w.symbol,
      returnPct: finiteOr(w.return_pct, 0),
      priorClassification: w.prior_classification ?? 'unrated',
    })),
    flyerCalls,
    diverCalls,
    confirmedCalls: confirmed.map(c => ({
      symbol: c.symbol,
      returnPct: finiteOr(c.return_pct, 0),
      priorClassification: c.prior_classification ?? 'unrated',
    })),
  };
}

export function formatAccuracyDigest(d: AccuracyDigest): string {
  const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
  const lines: string[] = [];

  const alarm = d.recallAny !== null && d.recallAny < RECALL_ALERT_FLOOR;
  lines.push(`${alarm ? '🚨' : '📊'} *Signal Accuracy* — ${sanitizeMarkdown(d.date)}`);
  lines.push('');
  lines.push(`Flyers today: ${d.flyers}  ·  Divers: ${d.divers}`);
  lines.push(`Flagged in advance: *${pct(d.recallAny)}*${alarm ? '  ← below floor' : ''}`);

  const hasDir = (b: PriorCallBuckets) => b.correct + b.wrong > 0;

  if (hasDir(d.flyerCalls) || hasDir(d.diverCalls)) {
    lines.push('');
    const splitLine = (
      label: string, total: number, b: PriorCallBuckets,
      agree: string, opposite: string,
    ) => {
      const sh = (n: number) => (total > 0 ? Math.round(100 * n / total) : 0);
      return `${label} ${total}: ✅ ${agree} ${b.correct} (${sh(b.correct)}%) · ` +
        `❌ ${opposite} ${b.wrong} (${sh(b.wrong)}%) · unrated ${b.neutral} (${sh(b.neutral)}%)`;
    };
    lines.push(splitLine('Made high (flyers)', d.flyers, d.flyerCalls, 'as recommended (Buy/Strong Buy)', 'we said Sell/Strong Sell'));
    lines.push(splitLine('Made low (divers)', d.divers, d.diverCalls, 'as recommended (Sell/Strong Sell)', 'we said Buy/Strong Buy'));
  }

  if (d.wrongBearish || d.wrongBullish) {
    lines.push('');
    lines.push(`Wrong-direction calls: *${d.wrongBearish + d.wrongBullish}*`);
    lines.push(`  ${d.wrongBearish} rated Sell then rallied · ${d.wrongBullish} rated Buy then fell`);
  }

  if (d.worstCalls.length) {
    lines.push('');
    for (const w of d.worstCalls) {
      const sign = w.returnPct >= 0 ? '+' : '';
      lines.push(
        `  ${sanitizeMarkdown(w.symbol)} ${sign}${w.returnPct.toFixed(1)}% ` +
          `(we said ${sanitizeMarkdown(w.priorClassification)})`
      );
    }
  }

  if (d.confirmedCalls.length) {
    lines.push('');
    lines.push('*Confirmed as recommended:*');
    for (const c of d.confirmedCalls) {
      const sign = c.returnPct >= 0 ? '+' : '';
      lines.push(
        `  ${sanitizeMarkdown(c.symbol)} ${sign}${c.returnPct.toFixed(1)}% ` +
          `(we said ${sanitizeMarkdown(c.priorClassification)})`
      );
    }
  }

  const trend = d.trend
    .slice()
    .reverse()
    .map(t => (t.recall === null ? '·' : `${Math.round(t.recall * 100)}`))
    .join(' ');
  lines.push('');
  lines.push(`${TREND_DAYS}d recall: ${trend}`);

  return lines.join('\n');
}

/** Build + send. Never throws — an accuracy report must not fail the daily ML chain. */
export async function sendAccuracyDigest(): Promise<boolean> {
  try {
    const digest = await buildAccuracyDigest();
    if (!digest) {
      console.warn('[ACCURACY] no high_flyer_daily_stats rows — retrospective may not have run');
      return false;
    }
    return await telegramService.sendMarkdownMessage(formatAccuracyDigest(digest));
  } catch (e) {
    console.error('[ACCURACY] digest failed:', (e as Error).message);
    return false;
  }
}
