import { dbAll, dbGet, dbRun, dbTransaction } from './dbAsync';

export const DEFAULT_AI_SIGNAL_MIN_CONFIDENCE = 65;

let _cachedMinConfidence: number | null = null;

export function invalidateAISignalCache(): void {
  _cachedMinConfidence = null;
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
  if (_cachedMinConfidence !== null) return _cachedMinConfidence;
  const row = await dbGet<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'ai_signal_min_confidence'",
  );
  const parsed = row ? Number(row.value) : NaN;
  _cachedMinConfidence = Number.isFinite(parsed) ? parsed : DEFAULT_AI_SIGNAL_MIN_CONFIDENCE;
  return _cachedMinConfidence;
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

  await dbRun(`
    INSERT INTO recommendation_log
      (symbol, rec_type, signal_date, generated_at, entry_price, stop_loss,
       target_1, confidence_score, reasoning, source, status, horizon_days)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, 'platform', 'ACTIVE', 15)
    ON CONFLICT DO NOTHING
  `, [signal.symbol, signal.type, today, signal.entry, signal.stopLoss, signal.target, signal.confidence, signal.reasoning]);
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
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
