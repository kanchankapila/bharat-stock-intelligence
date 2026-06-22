# Ensemble AUC Lift: Triple-Barrier Labels + News Sentiment — Design

**Date:** 2026-06-22
**Branch:** prod-readiness-phase1
**Status:** Draft — awaiting approval
**Baseline to beat:** active ensemble id 29 — held-out AUC **0.706**, CV 0.712, 65 features, 36.5k samples.

## Guiding principle

Every change is **A/B-gated against the 0.706 held-out AUC**. We retrain with the change,
compare held-out AUC + top-decile precision, and keep it **only if the held-out number
improves**. CV gains that don't survive held-out are discarded. Nothing here is assumed to
help — it is measured.

---

## Part A — News sentiment into the win-probability ensemble (low risk)

**Gap.** FinBERT sentiment is wired into the DL path (`dl_engine.py`, `feature_engineering.py`
→ `dl_score`) but **absent from the tabular stacking ensemble** that gates `win_probability`.

**Change.** Add two leak-free, point-in-time features to `ml_ensemble.build_features` and the
two loader SQLs (`load_training_data`, `load_pending_signals`):
- `news_sentiment_score` — 3-day avg BULLISH/BEARISH score (already on `technical_signals`
  and computed by `feature_engineering._merge_sentiment`). Neutral default `0.0`.
- `news_impact_count` — count of HIGH-impact articles in trailing 5d. Default `0`.
- Interaction `sentiment_x_score = news_sentiment_score * signal_score`.

**Leak-safety.** Both are joined on `(symbol, signal_date)` from `technical_signals`, which is
stamped at scan time → as-of by construction. Pre-flight check: confirm historical
`technical_signals.news_sentiment_score` coverage; if < ~30% populated, backfill from
`news_sentiment_items` with an AS-OF join before trusting the A/B.

**Risk.** Minimal — additive features, defaults are neutral. Worst case: flat held-out AUC → drop.

---

## Part B — Triple-barrier labeling (higher impact)

**Gap.** The ensemble trains on `signal_outcomes.outcome ∈ {WIN,LOSS}`, a net-of-cost return
thresholded at ±1% **measured at the horizon**. Path is ignored at the label level even though
`outcome_resolver.simulate_exit` and `signal_excursions` already capture it.

**Change.** Derive a López-de-Prado **triple-barrier label** from existing `signal_excursions`
columns (`mfe_pct`, `mae_pct`, `mfe_before_mae`, `trail_exit_pct`, `horizon_close_pct`) —
**no path recomputation required**:

- Barriers scaled by per-signal volatility. `signal_excursions` lacks ATR, so v1 uses a
  volatility proxy = trailing daily-return std from `stock_ohlcv` (computed once in
  `exit_labeler.py`, written as a new `vol_proxy_pct` column). Upper = `+k·vol`, lower =
  `−k·vol`, with `k` configurable (default `k_up=2.0`, `k_dn=1.0` → asymmetric, reward:risk 2:1).
- Label:
  - `1` if upper hit first: `mfe_before_mae = 1 AND mfe_pct ≥ k_up·vol`
  - `0` if lower hit first: `mfe_before_mae = 0 AND mae_pct ≤ −k_dn·vol`
  - time barrier (neither touched): label by sign of net-of-cost `horizon_close_pct`
    (drop to NEUTRAL/exclude if |return| < cost, matching current discipline).
- Written to a new `signal_outcomes.tb_label` column (additive; leaves `outcome` intact).

**Trainer.** `ml_ensemble.py` gets `--label {horizon|triple_barrier}` (default stays `horizon`
until the A/B wins). `load_training_data` selects `tb_label` when requested. Everything
downstream (`build_features`, stack, calibration, registry) is unchanged.

**Why it should help.** First-touch labels remove horizon-timing noise (a +6% that round-trips
to −1% is no longer a "LOSS"), and vol-scaling normalizes the bar across high/low-vol names —
both directly attack label noise, the dominant ceiling on equity-signal AUC.

---

## Validation harness (shared)

Extend `model_registry.notes` to record the experiment arm. For each change:
1. Retrain with the new label/features, embargoed walk-forward as today.
2. Log held-out AUC, top-decile precision (the metric that matches cross-sectional selection),
   and Brier (calibration) alongside the current arm.
3. Promote to `is_active = 1` only if **held-out AUC ≥ baseline + 0.005** AND top-decile
   precision does not regress. Otherwise keep the row inactive for the record and move on.

## Out of scope (later items from the review)

CatBoost/TabPFN base models, learning-to-rank head, SHAP attribution, Kelly sizing,
headline embeddings. Each is its own A/B once A/B land.

## Files touched

- `src/server/exit_labeler.py` — `vol_proxy_pct` + `tb_label` derivation
- `src/server/db.ts` — `signal_outcomes.tb_label`, `signal_excursions.vol_proxy_pct` columns
- `src/server/ml_ensemble.py` — sentiment features, `--label` flag, loader SQL
- `src/server/__tests__/` or `tests/` — unit tests for the triple-barrier label function
- A/B run is operational (no code), results recorded in `model_registry`
