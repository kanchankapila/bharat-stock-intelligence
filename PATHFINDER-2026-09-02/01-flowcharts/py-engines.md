# Feature: py-engines (scoring → blend → unified_recommendations)

Canonical blend: 8 engine maps (unified_ranker.py:2424-2433) → `_normalize_to_100` percentile
(:470, blend view only at :2473) → `drop_zero_dispersion_engines` (:564, MIN_SD 5.0) → `_blend`
renormalized (:582-589). `REGIME_WEIGHTS` (:195-218) now zeroes **three** engines (screener, cs,
smart_money — cs+smart_money zeroed 2026-08-31, newer than CLAUDE.md's text). Write: upsert
:2775-2821, append-only history :2846-2858, stale-row purge :2866-2881. Promotion chain:
`ml_ensemble.run` → CV/test gates → label-change + live-edge + staleness overrides →
`register_model` deactivates prior (:3274-3282). Shared SQL: `full_feature_train_sql`
(ml_ensemble.py:1051) / `full_feature_score_sql` (:1312); importers cs_ranker:34, exit_policy:32,
online_learner:64.

```mermaid
flowchart TD
  TS[("technical_signals")] --> UR["unified_ranker.run :2343"]
  CSIG[("confluence_signals")] --> CONFL["confluence_ml_engine :437"]
  SO[("signal_outcomes/excursions")] --> MLE["ml_ensemble score_pending :3624"]
  SO --> CONFL
  FS[("feature_store")] --> DL["dl_engine run_inference :640"]
  QM[("quant_scores/stock_scores")] --> SCD["scoring_engine via /api/v1/score<br/>backend-python/main.py:183"]
  MLE --> UR
  CS["cs_ranker — NO scheduler since 2026-08-31<br/>(queues.ts:1153 removed)"] -.frozen cs_score.-> UR
  DL --> UR
  SCD --> QM
  CONFL --> UR
  UR --> BLEND["normalize → drop_zero_dispersion → _blend<br/>:470,:564,:582 (call :2473,:2448,:2517)"]
  BLEND --> W["INSERT unified_recommendations :2775"] --> WH["history :2846"] & WS["WS broadcast queues.ts:2908"]
  MLEP["promote_or_register :3365"] --> LP["live_edge gate<br/>model_promotion.py:191"] --> MR[("model_registry")]
  DRIFT["drift_detector :119"] -.0.85x haircut.-> MLE
```

Key findings: [RISK] `cs_score` is now writerless — the ranker still averages + persists it
(:1763-1780, :2779), so the reporting column and its dispersion-collapse telemetry silently
decay; [DEBT] 6th near-copy of the champion/challenger gate (ml_ensemble:3365, cs_ranker:283,
exit_policy:193, confluence_ml_engine:279-374, online_learner:194-212, dl_engine:815-889);
[DEBT] mixed date anchors in one file — 6 `as_of.trading_days_back` vs 9 calendar
`date.today()-timedelta` sites; [DUP] 5 distinct clamp/winsorization implementations, duplicated
edge-adjust averaging loop (:1553-1584 vs :1688-1732); [DEBT] WorkflowDAG imported in 3 engines,
never instantiated; `model_registry.cv_roc_auc` holds different statistics per model_name.
