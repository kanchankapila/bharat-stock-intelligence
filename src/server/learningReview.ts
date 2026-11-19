/**
 * Weekly learning review (AF-20261119): what went wrong with last week's published Buys, and whether any
 * challenger arm has earned promotion. Reads the two snapshots ml-daily-ops just wrote
 * (call_attribution.py -> 'call_attribution_summary', ranker_challenger_gate.py -> 'ranker_challenger_gate')
 * and sends one Telegram message on Fridays. Report only: nothing here changes a score or a weight.
 */
import { dbAll } from './dbAsync';
import { parsePythonJson } from './parsePythonJson';
import { sanitizeMarkdown, telegramService } from './telegramService';

const CAUSE_LABEL: Record<string, string> = {
  WRONG_PICK: 'wrong pick (lagged its own sector)',
  SECTOR_DRAG: 'sector drag (beat its sector, sector lagged)',
  STOP_TOO_TIGHT: 'stop too tight (stopped, then recovered)',
  TOO_SLOW: 'too slow (worked after the window)',
  COST: 'cost (won gross, lost net)',
  EVENT: 'event (ex-date inside the hold)',
  UNFILLABLE: 'unfillable (locked limit-up at entry)',
};

interface Bucket { calls?: number; hit_rate?: number; mean_excess_pct?: number; eff_dates?: number; low_data?: boolean; t_eff?: number }
interface AttributionSummary {
  horizon?: number; calls?: number; hits?: number; misses?: number; overall?: Bucket;
  cause_share?: Record<string, number | null>; buckets?: Record<string, Record<string, Bucket>>;
  stops?: { winner_mae_p80_pct?: number; median_stop_dist_pct?: number; winners_whose_mae_crossed_stop?: number };
}
interface GateSnapshot { status?: string; candidates?: string[]; arms?: Record<string, { verdict?: string }> }

const pct = (v: unknown, dp = 0) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : 'n/a');
const num = (v: unknown, dp = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : 'n/a');

export function formatLearningReview(att: AttributionSummary | null, gate: GateSnapshot | null, date: string): string {
  const lines = [`🧭 *Weekly learning review* — ${sanitizeMarkdown(date)}`];
  if (!att || !att.calls) {
    lines.push('No published Buy has a closed window yet.');
  } else {
    const o = att.overall ?? {};
    lines.push(`${att.calls} Buy calls graded at ${att.horizon ?? 5} sessions vs the liquid universe after costs: ` +
      `hit ${pct(o.hit_rate)}, mean excess ${num(o.mean_excess_pct)}% ` +
      `(${num(o.eff_dates, 1)} independent windows${o.low_data ? ', LOW-DATA' : ''})`);
    const share = Object.entries(att.cause_share ?? {})
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => (b[1] as number) - (a[1] as number));
    if (share.length) {
      lines.push('', `*Why the ${att.misses} misses missed:*`);
      for (const [c, v] of share) lines.push(`• ${pct(v)} ${CAUSE_LABEL[c] ?? c}`);
    }
    const s = att.stops;
    if (s && typeof s.winner_mae_p80_pct === 'number') {
      lines.push('', `*Stops:* 80% of winners dipped no more than ${num(-s.winner_mae_p80_pct, 1)}%; ` +
        `the median published stop sits ${num(-(s.median_stop_dist_pct ?? NaN), 1)}% away; ` +
        `${pct(s.winners_whose_mae_crossed_stop)} of winners crossed their stop on the way.`);
    }
    const worst = Object.entries(att.buckets ?? {}).flatMap(([dim, b]) =>
      Object.entries(b).map(([k, v]) => ({ dim, k, ...v })))
      .filter(b => !b.low_data && typeof b.t_eff === 'number' && b.t_eff <= -2)
      .slice(0, 3);
    if (worst.length) {
      lines.push('', '*Where calls reliably lost (abstention candidates):*');
      for (const b of worst) lines.push(`• ${b.dim} ${sanitizeMarkdown(b.k)}: excess ${num(b.mean_excess_pct)}%, t ${num(b.t_eff)}`);
    }
  }
  lines.push('');
  if (!gate) {
    lines.push('Challenger gate: no snapshot yet.');
  } else if (gate.status === 'INVALID') {
    lines.push('⚠ Challenger gate INVALID: the shuffled-score control beat the ranking. No arm can be trusted until fixed.');
  } else if (gate.candidates?.length) {
    lines.push(`✅ *Promotion candidate:* ${sanitizeMarkdown(gate.candidates.join(', '))} beat the published ranking ` +
      'on the pre-registered test. Owner decision needed; nothing changes automatically.');
  } else {
    const v = Object.entries(gate.arms ?? {}).map(([a, r]) => `${a}: ${r?.verdict ?? 'n/a'}`).join(' · ');
    lines.push(`Challenger gate: no arm has earned promotion. ${sanitizeMarkdown(v)}`);
  }
  lines.push('_Descriptive: a rule built on any of this is graded by the challenger gate before it ships._');
  return lines.join('\n');
}

/** Sends on Fridays (IST). Never throws: a report must not fail the ML chain. */
export async function sendLearningReview(now: Date = new Date()): Promise<boolean> {
  const ist = new Date(now.getTime() + 19_800_000);
  if (ist.getUTCDay() !== 5) return false;
  try {
    const rows = await dbAll<{ key: string; value: string | null }>(
      `SELECT key, value FROM app_settings WHERE key IN ('call_attribution_summary', 'ranker_challenger_gate')`);
    const get = (k: string) => rows.find(r => r.key === k)?.value ?? null;
    const text = formatLearningReview(parsePythonJson<AttributionSummary>(get('call_attribution_summary')),
      parsePythonJson<GateSnapshot>(get('ranker_challenger_gate')), ist.toISOString().slice(0, 10));
    return await telegramService.sendMarkdownMessage(text);
  } catch (e) {
    console.error('[LearningReview] not sent:', (e as Error).message);
    return false;
  }
}
