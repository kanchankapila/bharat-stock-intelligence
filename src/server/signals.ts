import { dbAll, dbGet, dbRun, dbTransaction } from './dbAsync';

export const DEFAULT_AI_SIGNAL_MIN_CONFIDENCE = 65;
// Quant-endorsement floor for the AI path: the scoring engine only writes a win_probability
// for stocks it itself blessed (>=0.40), so requiring one ≥ this floor means an LLM-proposed
// signal only persists when the quant model independently agrees. Matches scoring_engine's gate.
//
// FIXED 2026-08-06 (was 0.40): 0.40 sits exactly on a real degenerate-calibration plateau
// discovered 2026-08-02 -- on most days ~95% of the whole universe shares one identical
// calibrated_win_probability (observed 0.4064) because the base ensemble's raw predictions are
// non-monotonic outside BEAR regime, so isotonic calibration collapses a wide raw range into
// one flat value that sits just above 0.40. At floor=0.40 that value clears the gate for
// virtually every stock instead of the intended handful/day, and every one of those still gets
// an LLM call -- so any day the LLM's own (uncorrelated, routinely overconfident)
// self-reported score clears getAISignalMinConfidence()'s separate 65 floor for a BUY on a
// meaningful fraction of them produces a burst of persisted signals and, since 2026-08-05,
// Telegram notifications (see websocketService.ts's AI_SIGNAL_TELEGRAM_DAILY_CAP). 0.42 clears
// the plateau with margin (verified live 2026-08-02: narrows the pass rate to ~14/2264
// stocks/day). That verification was previously applied only as a one-off `UPDATE app_settings`
// on a single running deployment -- never committed anywhere -- so it silently reverted to this
// stale 0.40 default on any fresh/reset DB (a new environment, a disaster-recovery restore, a
// second deployment) with no error or warning. Codifying the safe value as the default here, and
// via migrations/1786300000000_ai-signal-min-win-prob-seed.sql seeding the row itself, closes
// that gap -- an app_settings override still wins over both if an operator sets one deliberately.
export const DEFAULT_AI_SIGNAL_MIN_WIN_PROB = 0.42;

let _cachedMinConfidence: number | null = null;
let _cachedMinConfidenceExp = 0;
let _cachedMinWinProb: number | null = null;
let _cachedMinWinProbExp = 0;

export function invalidateAISignalCache(): void {
  _cachedMinConfidence = null;
  _cachedMinConfidenceExp = 0;
  _cachedMinWinProb = null;
  _cachedMinWinProbExp = 0;
}

export interface QuantGateResult {
  persist: boolean;
  reason: 'ok' | 'no_quant' | 'low_win_prob';
}

/**
 * Quant-endorsement gate for the AI signal path (LLM demotion). An LLM-proposed BUY/SELL only
 * persists if the stock's model win_probability clears the floor. The LLM's self-reported
 * confidence is uncorrelated with realized outcomes (measured ~2.3% decisive win rate regardless
 * of its confidence bucket), so the quant model — not the LLM — decides actionability. A missing
 * win_probability means the scoring engine did not endorse the stock → drop. Pure/unit-testable.
 */
export function gateOnQuant(winProbability: number | null | undefined, floor: number): QuantGateResult {
  if (winProbability === null || winProbability === undefined || Number.isNaN(winProbability)) {
    return { persist: false, reason: 'no_quant' };
  }
  if (winProbability < floor) return { persist: false, reason: 'low_win_prob' };
  return { persist: true, reason: 'ok' };
}

export interface AISignalGateResult {
  persist: boolean;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  reason: 'ok' | 'hold' | 'low_confidence';
}

/**
 * Actionability gate for the AI signal path. Pure (no DB/Ollama) so it is unit-testable.
 * Drops HOLD and sub-threshold verdicts; a missing verdict normalizes to HOLD so a blank
 * analysis can never become a phantom BUY. Confidence is the AI 0-100 scale.
 */
export function gateAISignal(
  analysis: { signal?: string | null; confidence?: number | null },
  threshold: number,
): AISignalGateResult {
  const raw = String(analysis.signal ?? 'HOLD').trim().toUpperCase();
  const signalType: 'BUY' | 'SELL' | 'HOLD' =
    raw === 'BUY' || raw === 'SELL' ? raw : 'HOLD';

  if (signalType === 'HOLD') return { persist: false, signalType, reason: 'hold' };

  const confidence = analysis.confidence ?? 0;
  if (confidence < threshold) return { persist: false, signalType, reason: 'low_confidence' };

  return { persist: true, signalType, reason: 'ok' };
}

export interface SurveillanceGateResult {
  gated: true;
  reason: string;
}

/**
 * Checks if a symbol is under SEBI surveillance (ASM/GSM).
 * Returns a gated result if signals should be suppressed, null if clear.
 */
export async function checkSurveillanceGate(symbol: string): Promise<SurveillanceGateResult | null> {
  const surv = await dbGet<{ is_asm: number; gsm_stage: number }>(
    'SELECT is_asm, gsm_stage FROM nse_stocks WHERE symbol = ?',
    [symbol]
  );
  if (surv?.is_asm === 1 || (surv?.gsm_stage ?? 0) >= 2) {
    return { gated: true, reason: `Surveillance: ASM=${surv?.is_asm} GSM stage=${surv?.gsm_stage}` };
  }
  return null;
}

/** Confidence floor for persisting AI signals (app_settings override, default 65). */
export async function getAISignalMinConfidence(): Promise<number> {
  if (_cachedMinConfidence !== null && Date.now() < _cachedMinConfidenceExp) return _cachedMinConfidence;
  const row = await dbGet<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'ai_signal_min_confidence'",
  );
  const parsed = row ? Number(row.value) : NaN;
  _cachedMinConfidence = Number.isFinite(parsed) ? parsed : DEFAULT_AI_SIGNAL_MIN_CONFIDENCE;
  _cachedMinConfidenceExp = Date.now() + 5 * 60_000;
  return _cachedMinConfidence;
}

/** Quant win_probability floor for persisting AI signals (app_settings override, default 0.40). */
export async function getAISignalMinWinProb(): Promise<number> {
  if (_cachedMinWinProb !== null && Date.now() < _cachedMinWinProbExp) return _cachedMinWinProb;
  const row = await dbGet<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'ai_signal_min_win_prob'",
  );
  const parsed = row ? Number(row.value) : NaN;
  _cachedMinWinProb = Number.isFinite(parsed) ? parsed : DEFAULT_AI_SIGNAL_MIN_WIN_PROB;
  _cachedMinWinProbExp = Date.now() + 5 * 60_000;
  return _cachedMinWinProb;
}

export interface Signal {
  id?: number;
  symbol: string;
  type: "BUY" | "SELL" | "HOLD";
  entry: number;
  target: number;
  stopLoss: number;
  confidence: number;
  reasoning: string;
  status: "ACTIVE" | "COMPLETED" | "EXPIRED" | "FAILED";
  createdAt: string;
  updatedAt: string;
  result?: "PROFIT" | "LOSS" | "NEUTRAL";
}

export async function createSignal(signal: Omit<Signal, "id" | "createdAt" | "updatedAt" | "status">) {
  const today = new Date().toISOString().split('T')[0];

  await upsertUnifiedSignal('platform', {
    symbol: signal.symbol,
    signalDate: today,
    signalType: signal.type,
    entryPrice: signal.entry,
    targetPrice: signal.target,
    stopLoss: signal.stopLoss,
    confidenceScore: signal.confidence,
    reasoning: signal.reasoning,
  });

  // target_2/target_3/quant_score/sentiment_score fix (2026-08-07, dead-column sweep): none of
  // recommendation_log's 3 writers ever populated these 4 columns. target_2/target_3 extend
  // target_1's own excess-over-entry move again (2x/3x), direction-agnostic (works for both a
  // BUY target above entry and a SELL target below it). quant_score/sentiment_score are a cheap
  // best-effort lookup against already-computed values -- this is a low-volume, on-demand
  // single-signal path, so one extra query per call is negligible.
  const target2 = signal.target + 2 * (signal.target - signal.entry);
  const target3 = signal.target + 3 * (signal.target - signal.entry);
  const extra = await dbGet<{ rank_composite: number | null; news_sentiment_score: number | null }>(`
    SELECT
      (SELECT qs.rank_composite FROM quant_scores qs WHERE qs.symbol = ? AND qs.rank_composite IS NOT NULL ORDER BY qs.date DESC LIMIT 1) AS rank_composite,
      (SELECT ts.news_sentiment_score FROM technical_signals ts WHERE ts.symbol = ? AND ts.news_sentiment_score IS NOT NULL ORDER BY ts.date DESC LIMIT 1) AS news_sentiment_score
  `, [signal.symbol, signal.symbol]).catch(() => null);

  await dbRun(`
    INSERT INTO recommendation_log
      (symbol, rec_type, signal_date, generated_at, entry_price, stop_loss,
       target_1, target_2, target_3, confidence_score, quant_score, sentiment_score,
       reasoning, source, status, horizon_days)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'platform', 'ACTIVE', 15)
    ON CONFLICT DO NOTHING
  `, [
    signal.symbol, signal.type, today, signal.entry, signal.stopLoss, signal.target,
    target2, target3, signal.confidence,
    extra?.rank_composite ?? null, extra?.news_sentiment_score ?? null,
    signal.reasoning,
  ]);
}

export async function updateSignalAccuracy(symbol: string, currentPrice: number) {
  const rows = await dbAll<any>('SELECT id, signal_type, target_price, stop_loss, status FROM unified_signals WHERE symbol = ? AND status = ?', [symbol, 'ACTIVE']);

  await dbTransaction(async (tx) => {
    for (const row of rows) {
      let newStatus = row.status;

      if (row.signal_type === "BUY") {
        if (currentPrice >= row.target_price) {
          newStatus = "COMPLETED";
        } else if (currentPrice <= row.stop_loss) {
          newStatus = "FAILED";
        }
      } else if (row.signal_type === "SELL") {
        if (currentPrice <= row.target_price) {
          newStatus = "COMPLETED";
        } else if (currentPrice >= row.stop_loss) {
          newStatus = "FAILED";
        }
      }

      if (newStatus !== "ACTIVE") {
        await tx.run(`UPDATE unified_signals SET status = ? WHERE id = ?`, [newStatus, row.id]);
      }
    }
  });
}

export interface UnifiedSignalInput {
  symbol: string;
  signalDate: string;
  signalType: string;
  entryPrice?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  confidenceScore?: number | null;
  reasoning?: string | null;
  technicalScore?: number | null;
  quantScore?: number | null;
  aiReasoning?: string | null;
  generatedAt?: string;
}

export async function upsertUnifiedSignal(source: string, s: UnifiedSignalInput): Promise<void> {
  const generatedAt = s.generatedAt ?? new Date().toISOString();
  await dbRun(`
    INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type,
       entry_price, target_price, stop_loss, confidence_score,
       reasoning, technical_score, quant_score, ai_reasoning,
       status, signal_generated_at)
    VALUES (?, ?::timestamptz, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
      entry_price=excluded.entry_price, target_price=excluded.target_price,
      stop_loss=excluded.stop_loss, confidence_score=excluded.confidence_score,
      reasoning=excluded.reasoning, technical_score=excluded.technical_score,
      quant_score=excluded.quant_score, ai_reasoning=excluded.ai_reasoning,
      signal_generated_at=excluded.signal_generated_at
  `, [s.symbol, s.signalDate, source, s.signalType,
      s.entryPrice ?? null, s.targetPrice ?? null, s.stopLoss ?? null, s.confidenceScore ?? null,
      s.reasoning ?? null, s.technicalScore ?? null, s.quantScore ?? null, s.aiReasoning ?? null,
      generatedAt]);
}
