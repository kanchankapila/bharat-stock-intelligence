# AI Signal Actionability Gate — Design

**Date:** 2026-06-22
**Branch:** prod-readiness-phase1
**Status:** Approved

## Problem

The `AI` signal producer writes a row to `unified_signals` for **every stock in the
universe** with no actionability gate. On 2026-06-21/22 this produced ~1,015–1,464 BUY
signals/day across as many distinct symbols, with only 1–2 SELLs and ~500 HOLDs — a
near-universal BUY firehose driven by the optimism bias of the Ollama LLM scorer.

Root causes (in `src/server/queues.ts` `processAISignal`):
1. **No gate** — every analysis is persisted regardless of conviction.
2. **No confidence floor** — rows with `confidence = 0` are stored.
3. **Phantom BUY** — `signalType: analysis.signal ?? 'BUY'` defaults a missing verdict to BUY.
4. **UI/DB mismatch** — the frontend only toasts `confidence > 70` BUY/SELL, but the DB
   persists the full firehose, so the backtester ingests unfiltered noise.

The `win_probability >= 0.40` gate described in CLAUDE.md belongs to the
`scoring_engine → stock_scores` pipeline; this LLM → `unified_signals` path bypasses it.

## Approach (chosen: A — confidence floor + drop HOLD)

A per-job gate. Keeps producers independent so `unified_ranker` remains the single
confluence authority. Rejected alternatives: relative daily ranking (needs a batch
redesign; false precision on an uncalibrated score) and confluence gating (couples
producers, duplicates the ranker).

## Components

### 1. `gateAISignal(analysis, threshold)` — pure function (`src/server/signals.ts`)

```
gateAISignal(analysis, threshold) -> { persist: boolean; signalType: 'BUY'|'SELL'|'HOLD'; reason: string }
```

- `signalType = normalize(analysis.signal ?? 'HOLD')` — missing verdict → HOLD (phantom-BUY fix).
- `signalType === 'HOLD'` → `{ persist: false, reason: 'hold' }`.
- `(analysis.confidence ?? 0) < threshold` → `{ persist: false, reason: 'low_confidence' }`.
- otherwise → `{ persist: true, reason: 'ok' }`. Boundary inclusive: `confidence === threshold` persists.

Pure and dependency-free → fully unit-testable without Ollama or the DB.

### 2. `getAISignalMinConfidence()` helper (`src/server/signals.ts`)

Reads `app_settings.value WHERE key = 'ai_signal_min_confidence'` via `dbGet`; parses to
number; returns **65** if absent or unparseable. Confidence is the AI 0–100 scale (the
aiService prompt requests 0–100), so the threshold is on the correct scale.

### 3. Wire into `processAISignal` (`src/server/queues.ts`)

After `generateStockAnalysis`, read the threshold, call `gateAISignal`. If `!persist`,
return early — **no `upsertUnifiedSignal` and no WebSocket broadcast**. Use the gate's
normalized `signalType` for the upsert (replacing `analysis.signal ?? 'BUY'`). The
WebSocket broadcast moves inside the gate so the UI only hears about persisted signals.

### 4. Retro-prune existing data (one-off script, backup-first)

`scripts/prune_ai_signals.cjs`: back up to timestamped JSON, then in a transaction delete
`unified_signals WHERE signal_source = 'AI' AND (signal_type = 'HOLD' OR confidence_score < 65)`,
deleting matching `unified_signal_outcomes` first (FK is non-cascading);
`signal_actions` / `signal_portfolio_correlation` cascade automatically. Aligns the
Jun 21–22 data already in the DB with the new gate so backtests are clean immediately.

## Out of scope (deliberate)

- The enqueue-the-universe trigger is unchanged — it is compute only; the gate governs
  what is *persisted*. Pre-filtering the enqueue is a later perf optimization.
- Relative ranking / outcome-calibration of the confidence score is the natural
  follow-up once clean post-gate outcomes accumulate.

## Testing

TDD `gateAISignal` (vitest):
- BUY conf 80, thr 65 → persist
- BUY conf 50 → skip (low_confidence)
- HOLD conf 90 → skip (hold)
- SELL conf 70 → persist
- missing `signal`, conf 90 → HOLD → skip (no phantom BUY)
- null/undefined confidence → skip (low_confidence)
- BUY conf exactly 65 → persist (inclusive boundary)
- lowercase/whitespace verdict normalizes correctly

`getAISignalMinConfidence` default-65 behaviour gets a light check.

## Files touched

- `src/server/signals.ts` — `gateAISignal` + `getAISignalMinConfidence`
- `src/server/queues.ts` — wire gate into `processAISignal`
- `src/server/__tests__/gateAISignal.test.ts` — new
- `scripts/prune_ai_signals.cjs` — new one-off
