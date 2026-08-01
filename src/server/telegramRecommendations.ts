/**
 * telegramRecommendations.ts — builds the daily stock-recommendation digest sent to Telegram.
 *
 * Replaces the per-signal alert path in websocketService.ts, which was gated on
 * `signalType === 'BUY' && confidence >= 85`. That gate became unreachable on 2026-07-12 when
 * commit 0609a49 ("demote LLM from signal generator to explainer") swapped the LLM's
 * self-reported confidence (85-98) for the quant win_probability (max 0.406 across the
 * universe today) -- the last alert fired on 2026-07-18 and nothing has been sent since.
 *
 * Reads the canonical ranking tables rather than individual signals:
 *   - unified_recommendations  (unified_ranker.py, 07:30 IST) -> swing / positional picks
 *   - intraday_recommendations (intraday_ranker.py, every 15m) -> intraday picks
 *
 * Every pick carries its horizon, the reason it was selected, and the screeners it appears in.
 */
import { dbAll } from './dbAsync';
import { telegramService } from './telegramService';

/** Picks shown per horizon. Telegram caps a message at 4096 chars; see splitForTelegram. */
export const MAX_PICKS_PER_HORIZON = 5;
/** Screener names listed per pick before overflow is summarised as "+N more". */
export const MAX_SCREENERS_PER_PICK = 4;

export type Horizon = 'INTRADAY' | 'SWING' | 'POSITIONAL';

export interface Pick {
  symbol: string;
  horizon: Horizon;
  action: string;
  score: number | null;
  conviction: string | null;
  entry: number | null;
  stopLoss: number | null;
  target: number | null;
  riskReward: number | null;
  sector: string | null;
  reason: string | null;
  screeners: string[];
  screenerCount: number;
  engineCoverage: number | null;
  source: 'unified' | 'intraday';
}

export interface DigestData {
  date: string;
  regime: string | null;
  longTerm: Pick[];
  intraday: Pick[];
  intradayGated: boolean;
  intradayGateReason: string | null;
  totalBuys: number;
}

/**
 * Horizon labels. `unified_recommendations.timeframe` is inherited from whichever source
 * supplied the entry/target levels (confluence_signals.suggested_timeframe or
 * recommendation_log.timeframe), so it carries the vendor's own casing -- normalise it.
 */
const HORIZON_LABEL: Record<Horizon, string> = {
  INTRADAY: 'INTRADAY (same session)',
  SWING: 'SWING (days to weeks)',
  POSITIONAL: 'LONG TERM (weeks to months)',
};

export function normaliseHorizon(raw: string | null | undefined): Horizon {
  const t = (raw ?? '').trim().toUpperCase();
  if (t === 'INTRADAY') return 'INTRADAY';
  if (t === 'SWING' || t === 'SHORT') return 'SWING';
  // POSITIONAL, LONG_TERM and NULL all mean a multi-day hold. NULL is the common case for
  // rows whose levels came from a source that never recorded a horizon, and defaulting those
  // to the longest bucket is the conservative read -- it never mislabels a multi-day idea
  // as an intraday one.
  return 'POSITIONAL';
}

/**
 * Telegram's legacy Markdown parser aborts the whole message on an unbalanced entity, so a
 * screener name containing `_` or `*` would silently drop the entire digest. Strip rather
 * than backslash-escape: these strings are display-only and the markers carry no meaning here.
 */
export function sanitizeMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/[_*`[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseScreeners(json: string | null | undefined): { names: string[]; count: number } {
  if (!json) return { names: [], count: 0 };
  try {
    const parsed = JSON.parse(json);
    const bull: string[] = Array.isArray(parsed?.bull_screeners) ? parsed.bull_screeners : [];
    const cleaned = bull.map((s) => sanitizeMarkdown(s)).filter(Boolean);
    return { names: cleaned, count: cleaned.length };
  } catch {
    return { names: [], count: 0 };
  }
}

/** Truncate on a word boundary so a reason never ends mid-word ("...with a PE ratio o"). */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:\s]+$/, '')}...`;
}

function fmtPrice(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return `${v.toFixed(2)}`;
}

/**
 * Rows the ranker classifies as actionable. `unified_ranker._classify` emits title-case
 * labels ('Strong Buy'/'Buy'), NOT the SCREAMING_CASE enum the table's name suggests --
 * querying for 'BUY' silently returns nothing.
 */
const BUY_CLASSIFICATIONS = ['Strong Buy', 'Buy'];

export async function fetchLongTermPicks(limit = MAX_PICKS_PER_HORIZON): Promise<Pick[]> {
  const rows = await dbAll<any>(
    `SELECT symbol, unified_score, conviction_level, classification, timeframe,
            entry_zone_low, entry_zone_high, stop_loss, target_1, risk_reward, sector,
            trade_reasoning, screener_names_json, engine_coverage_count, bullish_screener_count
       FROM unified_recommendations
      WHERE substring(computed_at, 1, 10) = (
              SELECT max(substring(computed_at, 1, 10)) FROM unified_recommendations)
        AND classification IN (?, ?)
        AND COALESCE(upper(timeframe), 'POSITIONAL') <> 'INTRADAY'
      ORDER BY unified_score DESC
      LIMIT ?`,
    [...BUY_CLASSIFICATIONS, limit],
  );
  return rows.map((r) => {
    const scr = parseScreeners(r.screener_names_json);
    return {
      symbol: r.symbol,
      horizon: normaliseHorizon(r.timeframe),
      action: r.classification,
      score: r.unified_score,
      conviction: r.conviction_level,
      entry: r.entry_zone_low,
      stopLoss: r.stop_loss,
      target: r.target_1,
      riskReward: r.risk_reward,
      sector: r.sector,
      reason: r.trade_reasoning,
      screeners: scr.names,
      screenerCount: r.bullish_screener_count ?? scr.count,
      engineCoverage: r.engine_coverage_count,
      source: 'unified' as const,
    };
  });
}

/**
 * Intraday-horizon picks from the unified ranker (`timeframe = 'INTRADAY'`, inherited from
 * whichever source supplied the levels). A separate engine from intraday_ranker.py, so its
 * emission gate does not apply -- but they are labelled by source in the digest so the two
 * are never conflated. Without this they would be dropped entirely: excluded from the
 * multi-day section for being intraday, and invisible to the intraday-engine query.
 */
export async function fetchUnifiedIntradayPicks(limit = MAX_PICKS_PER_HORIZON): Promise<Pick[]> {
  const rows = await dbAll<any>(
    `SELECT symbol, unified_score, conviction_level, classification,
            entry_zone_low, stop_loss, target_1, risk_reward, sector,
            trade_reasoning, screener_names_json, engine_coverage_count, bullish_screener_count
       FROM unified_recommendations
      WHERE substring(computed_at, 1, 10) = (
              SELECT max(substring(computed_at, 1, 10)) FROM unified_recommendations)
        AND classification IN (?, ?)
        AND upper(timeframe) = 'INTRADAY'
      ORDER BY unified_score DESC
      LIMIT ?`,
    [...BUY_CLASSIFICATIONS, limit],
  );
  return rows.map((r) => {
    const scr = parseScreeners(r.screener_names_json);
    return {
      symbol: r.symbol,
      horizon: 'INTRADAY' as const,
      action: r.classification,
      score: r.unified_score,
      conviction: r.conviction_level,
      entry: r.entry_zone_low,
      stopLoss: r.stop_loss,
      target: r.target_1,
      riskReward: r.risk_reward,
      sector: r.sector,
      reason: r.trade_reasoning,
      screeners: scr.names,
      screenerCount: r.bullish_screener_count ?? scr.count,
      engineCoverage: r.engine_coverage_count,
      source: 'unified' as const,
    };
  });
}

/**
 * Intraday picks come from the dedicated intraday engine. That engine downgrades every Buy to
 * Hold while its emission gate is closed (its own trailing realised PnL is not positive), so
 * filtering on Buy here inherits the gate rather than re-deriving it -- there is no way for
 * this digest to publish an intraday call the engine itself has suppressed.
 */
export async function fetchIntradayPicks(limit = MAX_PICKS_PER_HORIZON): Promise<Pick[]> {
  const rows = await dbAll<any>(
    `SELECT symbol, intraday_score, conviction_level, classification, cmp, entry_price,
            stop_loss, target_1, risk_reward, reasoning, bullish_count
       FROM intraday_recommendations
      WHERE substring(computed_at, 1, 10) = (
              SELECT max(substring(computed_at, 1, 10)) FROM intraday_recommendations)
        AND classification IN (?, ?)
      ORDER BY intraday_score DESC
      LIMIT ?`,
    [...BUY_CLASSIFICATIONS, limit],
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    horizon: 'INTRADAY' as const,
    action: r.classification,
    score: r.intraday_score,
    conviction: r.conviction_level,
    entry: r.entry_price ?? r.cmp,
    stopLoss: r.stop_loss,
    target: r.target_1,
    riskReward: r.risk_reward,
    sector: null,
    reason: r.reasoning,
    screeners: [],
    screenerCount: r.bullish_count ?? 0,
    engineCoverage: null,
    source: 'intraday' as const,
  }));
}

/**
 * Detect the closed gate from what the engine already writes, rather than recomputing the
 * trailing-PnL check here (two implementations of the same rule would drift).
 */
export async function fetchIntradayGateState(): Promise<{ gated: boolean; reason: string | null }> {
  const row = await dbAll<any>(
    `SELECT reasoning FROM intraday_recommendations
      WHERE substring(computed_at, 1, 10) = (
              SELECT max(substring(computed_at, 1, 10)) FROM intraday_recommendations)
        AND reasoning LIKE ?
      LIMIT 1`,
    ['%EMISSION GATED%'],
  );
  if (row.length === 0) return { gated: false, reason: null };
  return {
    gated: true,
    reason: "the intraday engine's trailing realised edge is not positive",
  };
}

export async function buildRecommendationsDigest(): Promise<DigestData> {
  const [longTerm, engineIntraday, unifiedIntraday, gate] = await Promise.all([
    fetchLongTermPicks(),
    fetchIntradayPicks(),
    fetchUnifiedIntradayPicks(),
    fetchIntradayGateState(),
  ]);

  // Dedicated intraday engine first, then top up from the unified ranker's intraday-horizon
  // rows (skipping any symbol already present) so the section is never silently empty while
  // real intraday-tagged picks exist.
  const seen = new Set(engineIntraday.map((p) => p.symbol));
  const intraday = [
    ...engineIntraday,
    ...unifiedIntraday.filter((p) => !seen.has(p.symbol)),
  ].slice(0, MAX_PICKS_PER_HORIZON);

  const meta = await dbAll<any>(
    `SELECT max(substring(computed_at, 1, 10)) AS d,
            max(regime) AS regime,
            count(*) FILTER (WHERE classification IN ('Strong Buy', 'Buy')) AS buys
       FROM unified_recommendations
      WHERE substring(computed_at, 1, 10) = (
              SELECT max(substring(computed_at, 1, 10)) FROM unified_recommendations)`,
  );

  return {
    date: meta[0]?.d ?? new Date().toISOString().slice(0, 10),
    regime: meta[0]?.regime ?? null,
    longTerm,
    intraday,
    intradayGated: gate.gated,
    intradayGateReason: gate.reason,
    totalBuys: Number(meta[0]?.buys ?? 0),
  };
}

function renderPick(p: Pick, idx: number): string {
  const lines: string[] = [];
  const sector = p.sector && p.sector !== 'Unknown' ? ` · ${sanitizeMarkdown(p.sector)}` : '';
  lines.push(`*${idx}. ${sanitizeMarkdown(p.symbol)}* — ${p.action}${sector}`);
  lines.push(`🕒 Horizon: *${HORIZON_LABEL[p.horizon]}*`);

  const scoreBits: string[] = [];
  if (p.score != null && Number.isFinite(p.score)) scoreBits.push(`Score ${p.score.toFixed(1)}/100`);
  if (p.conviction) scoreBits.push(`Conviction ${sanitizeMarkdown(p.conviction)}`);
  if (p.engineCoverage != null) scoreBits.push(`${p.engineCoverage}/7 engines`);
  if (scoreBits.length) lines.push(`📊 ${scoreBits.join(' · ')}`);

  if (p.entry != null || p.stopLoss != null || p.target != null) {
    const rr = p.riskReward != null && Number.isFinite(p.riskReward)
      ? ` · R:R ${p.riskReward.toFixed(2)}`
      : '';
    lines.push(`💰 Entry ${fmtPrice(p.entry)} · SL ${fmtPrice(p.stopLoss)} · Target ${fmtPrice(p.target)}${rr}`);
  }

  if (p.reason) lines.push(`💡 Why: _${truncateWords(sanitizeMarkdown(p.reason), 320)}_`);

  if (p.screeners.length) {
    const shown = p.screeners.slice(0, MAX_SCREENERS_PER_PICK);
    const extra = p.screenerCount - shown.length;
    lines.push(`🔎 Screeners: ${shown.join('; ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
  } else if (p.screenerCount > 0) {
    lines.push(`🔎 Screeners: ${p.screenerCount} bullish matches`);
  }

  return lines.join('\n');
}

export function renderDigest(d: DigestData): string {
  const out: string[] = [];
  out.push('📈 *BHARAT STOCK INTELLIGENCE — DAILY PICKS*');
  out.push(`_${d.date}${d.regime ? ` · Market regime: ${sanitizeMarkdown(d.regime)}` : ''}_`);

  out.push('\n━━━━━━━━━━━━━━━━━━━━\n*🗓 LONG TERM / SWING*');
  if (d.longTerm.length === 0) {
    out.push('_No qualifying multi-day picks today._');
  } else {
    d.longTerm.forEach((p, i) => out.push(renderPick(p, i + 1)));
  }

  out.push('\n━━━━━━━━━━━━━━━━━━━━\n*⚡ INTRADAY*');
  if (d.intraday.length > 0) {
    if (d.intradayGated) {
      // Be explicit about provenance: the dedicated intraday engine is suppressed, so these
      // are the unified ranker's intraday-horizon picks — a different engine, not a bypass.
      out.push(`_Dedicated intraday engine is paused (${d.intradayGateReason}). Below are the unified ranker's intraday-horizon picks._`);
    }
    d.intraday.forEach((p, i) => out.push(renderPick(p, i + 1)));
  } else if (d.intradayGated) {
    // Say why, rather than showing an unexplained empty section. Publishing intraday calls
    // the engine has measured as negative-expectancy would be worse than publishing none.
    out.push(`_No intraday calls published — ${d.intradayGateReason}, so the engine is holding fire._`);
  } else {
    out.push('_No qualifying intraday picks in the latest scan._');
  }

  out.push('\n━━━━━━━━━━━━━━━━━━━━');
  out.push(`_${d.totalBuys} buy-rated stocks in today's full ranking._`);
  out.push('_Research output, not investment advice. Verify before trading._');
  return out.join('\n\n');
}

/**
 * Telegram rejects messages over 4096 chars. Split on the blank-line boundaries the renderer
 * already produces so a pick is never cut in half.
 */
export function splitForTelegram(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const blocks = text.split('\n\n');
  const chunks: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > limit) {
      chunks.push(cur);
      cur = b;
    } else {
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export async function sendRecommendationsDigest(): Promise<{ sent: boolean; picks: number }> {
  const data = await buildRecommendationsDigest();
  const picks = data.longTerm.length + data.intraday.length;

  if (picks === 0 && !data.intradayGated) {
    // Nothing to say and no gate to explain -- stay quiet rather than send an empty digest.
    console.log('[TelegramRecs] No picks and no gate to report; skipping send.');
    return { sent: false, picks: 0 };
  }

  const chunks = splitForTelegram(renderDigest(data));
  let allOk = true;
  for (const chunk of chunks) {
    const ok = await telegramService.sendMarkdownMessage(chunk);
    if (!ok) allOk = false;
  }
  console.log(`[TelegramRecs] Sent ${chunks.length} message(s) with ${picks} picks (ok=${allOk})`);
  return { sent: allOk, picks };
}
