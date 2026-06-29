# Cross-Sectional Alpha Ranker — Design Spec

**Date:** 2026-06-25  
**Branch:** prod-readiness-phase1  
**Status:** Approved for implementation

---

## Problem

The existing ML ensemble (`ml_ensemble.py`) is a per-stock binary classifier: it asks
"will this stock hit its +5% target?" and outputs an absolute `win_probability` (0–1).
This label is regime-contaminated — in a BULL market most stocks win, inflating the score;
in a BEAR market most lose, deflating it. The model cannot discriminate *relative*
opportunity on a given date.

Cross-sectional models solve this by asking "which stocks will outperform their peers
today?" The label is a rank (percentile within a date group), not an absolute threshold.
This is regime-neutral by construction: a stock that falls 2% on a day when the market
falls 5% ranks HIGH (alpha = +3%).

---

## What We're Building

A new `cs_ranker.py` engine that:

1. Trains a **LightGBM regressor** on cross-sectional alpha percentile (stock
   excess-return rank vs Nifty 50, within each date group).
2. Stores predictions as `cs_score REAL` (0–100) on `technical_signals`.
3. Adds a `cs` component to `unified_ranker.py`'s `REGIME_WEIGHTS`, letting the
   canonical ranker blend cross-sectional rank alongside absolute win_probability.

The existing `win_probability` pipeline is **unchanged** — both scores coexist and serve
different roles: `win_probability` for signal confidence/RL gate, `cs_score` for
cross-sectional selection within today's opportunity set.

---

## Architecture

### 1. Label Construction

From `signal_outcomes` (which already has `return_pct` for resolved 5-day outcomes):

```
alpha_5d = return_pct - nifty_5d_return
```

`nifty_5d_return` = forward-5-day return of Nifty 50, computed from `stock_ohlcv` where
`symbol = 'NIFTY50'` (or `'^NSEI'` — whichever is present). Use the same date window as
the signal's `signal_date` + 5 trading days.

Within each `signal_date`, rank all signals by `alpha_5d` and convert to percentile
(0–100). This is the regression target: `cs_percentile`.

Minimum 5 signals per date for a date to contribute to training. Dates with fewer signals
are dropped (too sparse to rank meaningfully).

### 2. Feature Pipeline

Reuse `build_features(df)` from `ml_ensemble.py` verbatim — import the function directly
rather than duplicating. Both models see the same features; the only difference is the
label. This ensures: same null-safe helpers, same signal-type one-hot encoding, same
interaction terms.

### 3. Model

**LightGBM regressor** (`objective='regression_l2'`, `n_estimators=400`,
`learning_rate=0.05`, `num_leaves=63`, `min_child_samples=20`). Pointwise regression on
`cs_percentile` — no pairwise/listwise complexity. Gets ~80% of the cross-sectional
benefit at 20% of the complexity.

Saved to `src/server/ml_models/cs_ranker.pkl`.

Registered in `model_registry` with `model_type='cs_ranker'` (separate row from the
binary ensemble).

Evaluation metric: **Spearman rank correlation** between predicted cs_score and actual
cs_percentile on the held-out set (last 20% of dates, date-ordered — no look-ahead).
Target: Spearman ρ ≥ 0.10 before model is accepted.

### 4. Inference / Scoring

`score_batch()` in `cs_ranker.py`:

1. Loads all `technical_signals` rows with `cs_score IS NULL` and `win_probability IS NOT
   NULL` (ML-scored rows only — ensures features are available).
2. Runs `build_features()` on the batch.
3. Predicts raw LightGBM output (uncalibrated regression value).
4. Cross-sectionally normalizes within today's date group (percentile rank 0–100 using
   the same `_normalize_to_100` logic as `unified_ranker.py`).
5. `UPDATE technical_signals SET cs_score = ? WHERE symbol = ? AND date = ?`.

### 5. Schema

Migration `048_cs_score` added to `db.ts`:

```sql
ALTER TABLE technical_signals ADD COLUMN cs_score REAL;
CREATE INDEX idx_ts_cs_score ON technical_signals(cs_score) WHERE cs_score IS NOT NULL;
```

Also added to `db/schema.postgres.sql`.

### 6. Integration with unified_ranker.py

Add `'cs'` as a new blending component in `REGIME_WEIGHTS`:

```python
REGIME_WEIGHTS = {
    'BULL':     {'screener': 0.30, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.20, 'technical': 0.15, 'dl': 0.10},
    'BEAR':     {'screener': 0.35, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.20, 'technical': 0.10, 'dl': 0.10},
    'HIGH_VOL': {'screener': 0.20, 'ml': 0.15, 'cs': 0.05, 'confluence': 0.15, 'technical': 0.30, 'dl': 0.15},
    'CRASH':    {'screener': 0.40, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.15, 'technical': 0.10, 'dl': 0.10},
    'SIDEWAYS': {'screener': 0.32, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.20, 'technical': 0.13, 'dl': 0.10},
}
```

(0.05 taken from 'ml' in every regime. Totals remain 1.0.)

`_get_ml_scores()` in `unified_ranker.py` already reads `technical_signals.win_probability`.
Add `_get_cs_scores()` alongside it: same query pattern, reads `cs_score`, normalizes
0–100 via `_normalize_to_100`, returns `{'cs': {symbol: score}}`.

The `_blend()` function already handles missing components via weight renormalization, so
symbols with no `cs_score` yet (before first scoring run) degrade gracefully to the old
behavior.

### 7. Cron Wiring

In `queues.ts`, inside `processMlDailyOps`, after the `ml_ensemble.py --score` step, add:

```
python cs_ranker.py --score    # 120s timeout
```

Training (`--train`) is run manually or wired to the same weekly trigger as
`ml_ensemble.py --train`.

---

## Files

| File | Change |
|---|---|
| `src/server/cs_ranker.py` | NEW — training + inference |
| `src/server/tests/test_cs_ranker.py` | NEW — unit tests |
| `src/server/db.ts` | Migration 048: `cs_score REAL` on `technical_signals` |
| `src/server/unified_ranker.py` | `_get_cs_scores()` + updated `REGIME_WEIGHTS` + `_get_unified_score()` |
| `src/server/queues.ts` | `cs_ranker.py --score` after ensemble score step |

---

## Tests

`test_cs_ranker.py` covers:

1. **Label construction**: given 3 signals on the same date with known return_pct and
   known nifty return, assert alpha percentile ranks are [0, 50, 100].
2. **Minimum date filter**: dates with < 5 signals are excluded from training data.
3. **Feature reuse**: `build_features()` called from `cs_ranker` returns same columns as
   when called from `ml_ensemble`.
4. **Inference normalization**: `score_batch()` on a synthetic 4-stock batch produces
   cs_scores in [0, 100] with the top stock scoring highest.
5. **Unified ranker integration**: `_get_cs_scores()` returns a dict keyed by symbol with
   values in [0, 100]; `_blend()` with 'cs' present vs absent produces different scores.

---

## Out of Scope

- Pairwise/listwise LTR (LambdaRank, LambdaMART) — pointwise regression delivers most
  of the benefit with far less complexity.
- Replacing `win_probability` — both scores serve different purposes and coexist.
- UI changes — `cs_score` surfaces in `unified_recommendations.final_score` implicitly;
  no new tab or column needed.
- Backtesting the CS model against `win_probability` — can be done after 30 days of
  live scoring data accumulates.
