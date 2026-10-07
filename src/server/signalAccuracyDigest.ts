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

/** Recall below this is worth shouting about rather than reporting flatly. Applied to OUR
 *  ranking's recall (recall.unified), never to recall.any — see buildAccuracyDigest. */
export const RECALL_ALERT_FLOOR = 0.10;
/** How many named wrong-direction calls to list before truncating. */
const MAX_NAMED = 5;
/** Trailing window for the recall trend line. */
const TREND_DAYS = 7;
/**
 * Rs 10cr trailing-20d ADT — the bar above which the ranker's bucket spread measurably
 * disappears (AF-20261007-05: Buy minus Hold is +7.7bps at the repo's Rs 1cr floor and
 * -5.4bps at this one, over the same 38 sessions). The flyer definition has a price floor
 * and no liquidity floor, so this is reported rather than applied — changing the definition
 * would break the trend line's comparability with its own history.
 */
export const TRADEABLE_ADT = 100_000_000;

/** Directional prior-call split for one movers class (flyers or divers). The "correct"
 *  bucket always means "the prior call agreed with the move that happened": for flyers
 *  that is a prior Buy/Strong Buy, for divers a prior Sell/Strong Sell. */
export interface PriorCallBuckets {
  correct: number;
  wrong: number;
  hold: number;    // the ranker HAD an opinion and it was "stand aside"
  unrated: number; // no unified_recommendations row at all — a coverage gap, not an abstention
}

/** AF-20261007-02: these were one `neutral` bucket, and the report rendered it as "unrated".
 *  Measured 2026-10-06: of 158 flyers, 77 were rated Hold and only 37 had no row — so 49%
 *  of what read as "we had no view" was the ranker deliberately standing aside. The two
 *  need different fixes (calibration vs coverage), so they cannot share a bucket. */

export interface AccuracyDigest {
  date: string;
  flyers: number;
  divers: number;
  /** Ranked universe size — the denominator of the mover base rate. */
  universeN: number;
  /** recall.unified: share of today's flyers OUR ranking had rated Buy beforehand. NOT
   *  recall.any — see buildAccuracyDigest for why the union is uninformative. */
  recallOwn: number | null;
  /** recall.precision.unified: share of our Buy calls that flew. Read against the base rate. */
  precisionOwn: number | null;
  /** How many names the prior run rated Sell/Strong Sell and Buy/Strong Buy — the
   *  denominators the wrong-direction counts have to be judged against. */
  sellRatedN: number;
  buyRatedN: number;
  /** Of today's flyers, how many trade at or above TRADEABLE_ADT. The rest are names the
   *  measurement can see and a reader cannot buy. */
  liquidFlyers: number;
  /** For the flyers we HAD rated Buy/Strong Buy: mean close-to-close move, and mean move from
   *  that session's OPEN — the earliest entry a reader of the previous evening's digest could
   *  take. The difference is the overnight gap, which is not capturable (AF-20261007-06). */
  confirmedMeanReturnPct: number | null;
  confirmedMeanOpenToClosePct: number | null;
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

function priorBucket(prior: string | null, isFlyer: boolean): keyof PriorCallBuckets {
  if (!prior) return 'unrated';
  if (prior === 'Hold') return 'hold';
  if (isFlyer) return BUY_SET.has(prior) ? 'correct' : SELL_SET.has(prior) ? 'wrong' : 'hold';
  return SELL_SET.has(prior) ? 'correct' : BUY_SET.has(prior) ? 'wrong' : 'hold';
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
  const empty: PriorCallBuckets = { correct: 0, wrong: 0, hold: 0, unrated: 0 };
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

  // Denominators for the wrong-direction counts. Same run the retrospective's
  // _load_prior_classification used (MAX(computed_at) < day), so the counts and the named
  // wrong calls describe the same ranking. AF-20261007-03: without these, "15 wrong calls"
  // is a number with no scale — 298 Sell-rated names at a 6.5% base flyer rate are EXPECTED
  // to throw ~19 rallies, so 15 was better than chance and the report called it a failure.
  const rated = await dbAll<{ classification: string | null; c: number }>(
    `SELECT classification, COUNT(*)::int AS c
       FROM unified_recommendations
      WHERE computed_at = (SELECT MAX(computed_at) FROM unified_recommendations WHERE computed_at < ?)
      GROUP BY classification`,
    [today.date]
  );
  let sellRatedN = 0;
  let buyRatedN = 0;
  for (const r of rated) {
    if (r.classification && SELL_SET.has(r.classification)) sellRatedN += finiteOr(r.c, 0);
    if (r.classification && BUY_SET.has(r.classification)) buyRatedN += finiteOr(r.c, 0);
  }

  // The capturable half of today's confirmed calls, plus how much of the mover population is
  // tradeable. One query, FILTERed, because both numbers are read off the same rows.
  const capturable = await dbAll<{
    confirmed_n: number | null;
    c2c: number | null;
    o2c: number | null;
    liquid_flyers: number | null;
  }>(
    `SELECT COUNT(*) FILTER (WHERE prior_classification IN ('Buy','Strong Buy'))::int AS confirmed_n,
            AVG(return_pct)        FILTER (WHERE prior_classification IN ('Buy','Strong Buy')) AS c2c,
            AVG(open_to_close_pct) FILTER (WHERE prior_classification IN ('Buy','Strong Buy')) AS o2c,
            COUNT(*) FILTER (WHERE adt_20d >= ?)::int AS liquid_flyers
       FROM high_flyer_retrospective
      WHERE date = ? AND direction = 'up'`,
    [TRADEABLE_ADT, today.date]
  );
  const cap = capturable[0] ?? { confirmed_n: null, c2c: null, o2c: null, liquid_flyers: null };
  // `Number(null)` is 0 and 0 IS finite, so a bare Number.isFinite guard turns SQL's NULL
  // (an AVG over no rows, or over rows written before AF-20261007-06) into a reported 0.00% —
  // the recurring-bugs.md NaN/null-coercion class in its null form. Check for null first.
  const finiteOrNull = (v: unknown) =>
    v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

  const precision = (recall.precision ?? {}) as Record<string, unknown>;
  return {
    date: today.date,
    flyers: finiteOr(today.flyer_n, 0),
    divers: finiteOr(recall.diver_n, 0),
    universeN: finiteOr(today.universe_n, 0),
    // recall.unified, NOT recall.any (AF-20261007-01). `any` unions four sources, one of
    // which is `signals` = DISTINCT symbols in unified_signals over a trailing 5 sessions:
    // measured 2026-10-06 that set held 2,101 of 2,424 ranked names, so recall.any was 1.0
    // on all seven days of the trend line. A metric pinned at its maximum cannot fail, so
    // it cannot inform. recall.unified moved 0.139-0.219 over the same week.
    recallOwn: Number.isFinite(Number(recall.unified)) ? Number(recall.unified) : null,
    precisionOwn: Number.isFinite(Number(precision.unified)) ? Number(precision.unified) : null,
    sellRatedN,
    buyRatedN,
    liquidFlyers: finiteOr(cap.liquid_flyers, 0),
    confirmedMeanReturnPct: finiteOrNull(cap.c2c),
    confirmedMeanOpenToClosePct: finiteOrNull(cap.o2c),
    wrongBearish: finiteOr(recall.wrong_bearish_miss, 0),
    wrongBullish: finiteOr(recall.wrong_bullish_miss, 0),
    trend: stats.map(s => {
      const r = parseRecall(s.recall_json);
      return {
        date: s.date,
        recall: Number.isFinite(Number(r.unified)) ? Number(r.unified) : null,
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

/** Share of the ranked universe that moved enough to count as a mover. The null hypothesis
 *  every count in this report has to be read against. */
function baseRate(movers: number, universeN: number): number | null {
  return universeN > 0 ? movers / universeN : null;
}

/** How many of a rated bucket would have moved against us by chance alone. */
function expectedByChance(ratedN: number, movers: number, universeN: number): number | null {
  const p = baseRate(movers, universeN);
  return p === null ? null : ratedN * p;
}

/** The chance expectation for the TOTAL wrong-direction count — both halves, because the count
 *  it is printed beside is `wrongBearish + wrongBullish`. Shared by the digest and the compact
 *  scorecard: computing it in two places is how the two drift into quoting different nulls. */
function expectedWrongByChance(d: AccuracyDigest): number | null {
  const bear = expectedByChance(d.sellRatedN, d.flyers, d.universeN);
  const bull = expectedByChance(d.buyRatedN, d.divers, d.universeN);
  return bear === null || bull === null ? null : bear + bull;
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);

/**
 * The compact form — our ranking's hit rate against the base rate, in at most four lines.
 * Embedded in the pre-open morning brief (morningBrief.ts) so the picks arrive next to the
 * measured track record of the previous session rather than on their own.
 */
/**
 * The line that keeps this report honest about what was buyable. `return_pct` is
 * close(D-1) -> close(D); a call published the evening before can only be entered at D's open,
 * so `c2c - o2c` is the overnight gap and is not available to anyone reading the digest.
 * Returns null when the columns are unpopulated (rows written before AF-20261007-06) — an
 * absent line is honest, an `n/a` beside a real figure invites reading the gap as zero.
 */
function capturableLine(d: AccuracyDigest): string | null {
  if (d.confirmedMeanReturnPct === null || d.confirmedMeanOpenToClosePct === null) return null;
  const gap = d.confirmedMeanReturnPct - d.confirmedMeanOpenToClosePct;
  return `Of that move, ${d.confirmedMeanOpenToClosePct.toFixed(2)}% was available *from the open* ` +
    `(close-to-close ${d.confirmedMeanReturnPct.toFixed(2)}%; ${gap.toFixed(2)}% was the overnight gap, ` +
    'which a reader of last evening\'s digest could not buy).';
}

/** How much of the mover population a reader could actually trade. */
function tradeableLine(d: AccuracyDigest): string | null {
  if (!d.flyers) return null;
  return `Tradeable: ${d.liquidFlyers} of ${d.flyers} flyers were above ` +
    `Rs ${(TRADEABLE_ADT / 1e7).toFixed(0)}cr/day ADT; the rest are names this report can see ` +
    'and a reader cannot size.';
}

export function formatAccuracyScorecard(d: AccuracyDigest): string {
  const base = baseRate(d.flyers, d.universeN);
  const lines = [
    `Last session: ${d.flyers} stocks made a high, ${d.divers} made a low ` +
      `(${pct(base)} of ${d.universeN} ranked names).`,
    `Our Buy list: ${d.flyerCalls.correct} of them were rated Buy beforehand ` +
      `(caught ${pct(d.recallOwn)} of the movers; ${pct(d.precisionOwn)} of our Buy calls ` +
      `flew vs a ${pct(base)} base rate).`,
  ];
  const wrong = d.wrongBearish + d.wrongBullish;
  const exp = expectedWrongByChance(d);
  lines.push(
    `Called the wrong way: ${wrong}` +
      (exp === null ? '' : ` (≈${Math.round(exp)} expected by chance)`) + '.'
  );
  return lines.join('\n');
}

export function formatAccuracyDigest(d: AccuracyDigest): string {
  const lines: string[] = [];
  const base = baseRate(d.flyers, d.universeN);

  const alarm = d.recallOwn !== null && d.recallOwn < RECALL_ALERT_FLOOR;
  lines.push(`${alarm ? '🚨' : '📊'} *Signal Accuracy* — ${sanitizeMarkdown(d.date)}`);
  lines.push('');
  lines.push(`Flyers today: ${d.flyers}  ·  Divers: ${d.divers}  ·  base rate ${pct(base)}`);
  // Our own ranking only. The union over all four sources was 100% every day (AF-20261007-01).
  lines.push(
    `Our ranking caught: *${pct(d.recallOwn)}* of them` +
      `  ·  precision ${pct(d.precisionOwn)} of ${d.buyRatedN} Buy calls` +
      (alarm ? '  ← below floor' : '')
  );

  const hasDir = (b: PriorCallBuckets) => b.correct + b.wrong > 0;

  if (hasDir(d.flyerCalls) || hasDir(d.diverCalls)) {
    lines.push('');
    const splitLine = (
      label: string, total: number, b: PriorCallBuckets,
      agree: string, opposite: string,
    ) => {
      const sh = (n: number) => (total > 0 ? Math.round(100 * n / total) : 0);
      return `${label} ${total}: ✅ ${agree} ${b.correct} (${sh(b.correct)}%) · ` +
        `❌ ${opposite} ${b.wrong} (${sh(b.wrong)}%) · ` +
        // Hold is a CALL (stand aside); only `unrated` is a coverage gap (AF-20261007-02).
        `Hold ${b.hold} (${sh(b.hold)}%) · not ranked ${b.unrated} (${sh(b.unrated)}%)`;
    };
    lines.push(splitLine('Made high (flyers)', d.flyers, d.flyerCalls, 'as recommended (Buy/Strong Buy)', 'we said Sell/Strong Sell'));
    lines.push(splitLine('Made low (divers)', d.divers, d.diverCalls, 'as recommended (Sell/Strong Sell)', 'we said Buy/Strong Buy'));
  }

  const cap = capturableLine(d);
  const trade = tradeableLine(d);
  if (cap || trade) {
    lines.push('');
    if (cap) lines.push(cap);
    if (trade) lines.push(trade);
  }

  if (d.wrongBearish || d.wrongBullish) {
    lines.push('');
    const exp = expectedWrongByChance(d);
    const observed = d.wrongBearish + d.wrongBullish;
    // AF-20261007-03: the count alone reads as a failure at any value. A Sell rating on a
    // name with a 6.5% daily chance of a +4% pop is EXPECTED to be "wrong" 6.5% of the time;
    // only an excess over that is evidence of anything.
    const verdict = exp === null ? ''
      : observed > exp ? `  ← worse than chance (≈${Math.round(exp)})`
      : `  (≈${Math.round(exp)} expected by chance)`;
    lines.push(`Wrong-direction calls: *${observed}*${verdict}`);
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
  lines.push(`${TREND_DAYS}d recall (our ranking): ${trend}`);

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
