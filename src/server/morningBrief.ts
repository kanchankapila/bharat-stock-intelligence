/**
 * morningBrief.ts — the pre-open Telegram send (08:15 IST, Mon-Fri).
 *
 * Why a morning send exists at all, given `recommendations-digest` already runs at 22:40 IST:
 * the evening send lands after the close, when nothing in it can be acted on. Nothing re-ranks
 * overnight either (unified-ranker is the 22:30 slot), so the morning send carries the SAME
 * ranking — which is exactly why it must carry something the evening send cannot:
 *
 *   1. last session's GRADED scorecard (high_flyer_retrospective, written by ml-daily-ops at
 *      ~18:50 IST — i.e. the end-of-day accuracy analysis, now feeding the morning call);
 *   2. the frozen forward test's current verdict on whether these calls have any demonstrated
 *      edge (app_settings['forward_test_report'], forward_test_report.py, protocol frozen
 *      2026-10-06).
 *
 * Both honesty lines are READ from what the platform measured, never written here. There is no
 * hand-maintained number in this file, and nothing in it restates a result the measurement
 * harness has not reached — if the forward test has no closed windows yet, the brief says so
 * rather than implying the picks are validated (measurement.md; CLAUDE.md's "never hand-write
 * a count into a doc or comment").
 */
import { dbGet } from './dbAsync';
import { telegramService } from './telegramService';
import { buildAccuracyDigest, formatAccuracyScorecard } from './signalAccuracyDigest';
import {
  buildRecommendationsDigest,
  renderDigest,
  splitForTelegram,
} from './telegramRecommendations';

/** The horizon to report. 5d is the only one that can reach statistical power this decade —
 *  the protocol's own note: 5d hits 20 independent windows at ~100 sessions, 21d at ~420. */
const REPORT_HORIZON = '5';
const FORWARD_TEST_KEY = 'forward_test_report';

interface TierRow {
  tier: string | number;
  dates?: number;
  eff_dates?: number;
  hit_rate?: number;
  base_hit?: number;
  mean_excess_pct?: number;
  verdict?: string;
}

const pct = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 100)}%` : 'n/a';
};
const num = (v: unknown, dp: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dp) : 'n/a';
};

/**
 * One line stating what the frozen forward test currently knows. It RELAYS the harness's own
 * `verdict` field rather than re-deriving one: re-deriving would let this message and
 * forward_test_report.py disagree about what counts as evidence, which is the failure mode
 * signalAccuracyDigest.ts already carries a comment about for `wrong_call`.
 */
export function formatForwardTestLine(raw: string | null | undefined): string {
  let forward: Record<string, unknown> | null = null;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const blocks = (parsed?.blocks ?? {}) as Record<string, unknown>;
    forward = (blocks.forward ?? null) as Record<string, unknown> | null;
  } catch {
    forward = null;
  }
  if (!forward) return '⚠ Forward test: not yet measured — treat these calls as unvalidated.';

  const since = typeof forward.since === 'string' ? forward.since : 'the protocol start';
  const calls = Number(forward.calls);
  const tiers = (forward.tiers ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(tiers[REPORT_HORIZON]) ? (tiers[REPORT_HORIZON] as TierRow[]) : [];
  // The as-published row, not a coverage tier: the digest sends the Buy/Strong Buy calls, so
  // a top-1%-tier hit rate would describe a list nobody receives.
  const row = rows.find(r => r.tier === 'published');

  if (!calls || !row) {
    return `⚠ Forward test (frozen, since ${since}): no call has a closed window yet — ` +
      'these picks have **no verified edge yet**.';
  }

  const verdict = row.verdict ?? 'LOW-DATA';
  const head = `Forward test (frozen, since ${since}, ${num(row.eff_dates, 1)} independent windows): ` +
    `*${verdict}*`;
  const body = `beat the universe ${pct(row.hit_rate)} of the time vs ${pct(row.base_hit)} by chance, ` +
    `net excess ${num(row.mean_excess_pct, 2)}%/${REPORT_HORIZON}d after costs`;
  return verdict === 'LOW-DATA'
    ? `⚠ ${head} — ${body}. Not yet evidence either way.`
    : `${head} — ${body}.`;
}

/** Assembled separately from the sends so the ordering is testable without a DB or Telegram. */
export function composeMorningBrief(
  date: string,
  picksBody: string,
  scorecard: string | null,
  forwardLine: string,
): string {
  const out = [`🌅 *PRE-OPEN BRIEF* — ${date}`];
  out.push(picksBody.trim() || '_No qualifying picks in the latest ranking._');
  if (scorecard) out.push(`*Last session, graded:*\n${scorecard}`);
  out.push(forwardLine);
  return out.join('\n\n');
}

export async function buildMorningBrief(): Promise<{ text: string; picks: number }> {
  const digest = await buildRecommendationsDigest();
  const picks = digest.longTerm.length + digest.intraday.length;

  // Neither honesty block may fail the send: a brief without the scorecard is worse than no
  // brief only if it silently LOOKS validated, and formatForwardTestLine's fallback says the
  // opposite. So degrade, loudly in the log, never throw.
  let scorecard: string | null = null;
  try {
    const accuracy = await buildAccuracyDigest();
    if (accuracy) scorecard = formatAccuracyScorecard(accuracy);
  } catch (e) {
    console.warn('[MorningBrief] scorecard unavailable:', (e as Error).message);
  }
  let forwardRaw: string | null = null;
  try {
    forwardRaw = (await dbGet<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = ?`, [FORWARD_TEST_KEY]))?.value ?? null;
  } catch (e) {
    console.warn('[MorningBrief] forward test snapshot unavailable:', (e as Error).message);
  }

  return {
    text: composeMorningBrief(digest.date, renderDigest(digest), scorecard, formatForwardTestLine(forwardRaw)),
    picks,
  };
}

export async function sendMorningBrief(): Promise<{ sent: boolean; picks: number }> {
  const { text, picks } = await buildMorningBrief();
  const chunks = splitForTelegram(text);
  let allOk = true;
  for (const chunk of chunks) {
    if (!(await telegramService.sendMarkdownMessage(chunk))) allOk = false;
  }
  console.log(`[MorningBrief] Sent ${chunks.length} message(s) with ${picks} picks (ok=${allOk})`);
  return { sent: allOk, picks };
}
