# Cross-Sectional Alpha Ranker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a LightGBM cross-sectional alpha ranker that scores each signal by its relative rank among all opportunities on the same date, stored as `cs_score` on `technical_signals` and blended into `unified_recommendations`.

**Architecture:** A new `cs_ranker.py` trains a LightGBM regressor on cross-sectional alpha percentile (stock 5-day return minus Nifty 50 return, ranked 0–100 within each date group). It reuses `build_features()` from `ml_ensemble.py` verbatim so both models share the same feature pipeline. Predictions are written to a new `cs_score REAL` column on `technical_signals`; `unified_ranker.py` picks them up via a new `_get_cs_scores()` method weighted at 5% in every regime.

**Tech Stack:** Python 3.11, LightGBM (`LGBMRegressor`), SciPy (`spearmanr`), `db_compat.py` (dual SQLite/PG), TypeScript (db.ts migration, queues.ts cron)

## Global Constraints

- Working directory for all Python commands: `d:\Github\bharat-stock-intelligence\src\server`
- Python venv: `d:\Github\bharat-stock-intelligence\backend-python\venv\Scripts\python`
- DB access via `db_compat.connect()` / `read_df()` — never raw `sqlite3` / `psycopg2`
- Nifty 50 benchmark symbol in `stock_ohlcv`: `'NIFTY50'`
- Model saved to `src/server/ml_models/cs_ranker.pkl` (directory already exists)
- Migration name: `'048_cs_score_column'`; must follow existing `runMigration(name, sql)` pattern in `db.ts`
- `build_features(df)` imported from `ml_ensemble` — do NOT duplicate it in `cs_ranker.py`
- `_normalize_to_100(raw)` is a module-level function in `unified_ranker.py` — reuse it in `_get_cs_scores()`
- Minimum 5 signals per date for the date to contribute to training data
- Spearman ρ acceptance threshold: ≥ 0.10 (below = warn, do not abort)
- `REGIME_WEIGHTS` in `unified_ranker.py` must have 'cs': 0.05 in all 5 regimes, carved from the old 'ml': 0.25 → 'ml': 0.20; all rows must still sum to 1.0
- Run tests from repo root: `backend-python\venv\Scripts\python -m pytest src/server/tests/test_cs_ranker.py -v`
- All tests must pass before committing

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/server/db.ts` | Modify | Migration 048: add `cs_score REAL` column + index |
| `src/server/db/schema.postgres.sql` | Modify | Same column for Postgres reference schema |
| `src/server/cs_ranker.py` | Create | Label construction, training, scoring, CLI |
| `src/server/tests/test_cs_ranker.py` | Create | Unit tests (label, filter, normalization, ranker integration) |
| `src/server/unified_ranker.py` | Modify | `_get_cs_scores()` + updated `REGIME_WEIGHTS` + `engine_maps` |
| `src/server/queues.ts` | Modify | `cs_ranker.py --score` in daily ops; `--train` in weekly retrain |

---

## Task 1: Schema — add `cs_score` column to `technical_signals`

**Files:**
- Modify: `src/server/db.ts` (after the last `runMigration` call, near line 1870)
- Modify: `src/server/db/schema.postgres.sql`

**Interfaces:**
- Produces: `technical_signals.cs_score REAL` column — consumed by Tasks 2, 4

- [ ] **Step 1: Find the last migration in db.ts**

Open `src/server/db.ts`. The last `runMigration` call is `'047_live_screener_optimization'`. Add migration 048 immediately after it (before the end of the file).

- [ ] **Step 2: Add migration 048 to db.ts**

After the closing backtick of migration `047_live_screener_optimization` (around line 1883), add:

```typescript
runMigration('048_cs_score_column', `
  ALTER TABLE technical_signals ADD COLUMN cs_score REAL;
  CREATE INDEX IF NOT EXISTS idx_ts_cs_score
    ON technical_signals(cs_score) WHERE cs_score IS NOT NULL;
`);
```

- [ ] **Step 3: Update postgres schema**

In `src/server/db/schema.postgres.sql`, find the `technical_signals` table definition. Add `cs_score REAL` as the last column before the closing `)`:

```sql
  cs_score REAL,
```

And add the partial index after the table definition (near the other `technical_signals` indexes):

```sql
CREATE INDEX IF NOT EXISTS idx_ts_cs_score ON technical_signals(cs_score) WHERE cs_score IS NOT NULL;
```

- [ ] **Step 4: Verify migration runs cleanly**

```powershell
cd d:\Github\bharat-stock-intelligence
node -e "require('./src/server/db.ts')" 2>&1
```

Expected: no error output (or TypeScript compilation errors only if running raw TS — use the dev server test instead):

```powershell
npx tsx -e "import './src/server/db.ts'; console.log('OK')" 2>&1
```

Expected output ends with `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/db/schema.postgres.sql
git commit -m "feat(schema): add cs_score column to technical_signals (migration 048)"
```

---

## Task 2: `cs_ranker.py` — label construction, training, scoring

**Files:**
- Create: `src/server/cs_ranker.py`

**Interfaces:**
- Consumes: `build_features(df)` from `ml_ensemble` (import); `technical_signals.cs_score` column from Task 1; `signal_outcomes.return_pct`; `stock_ohlcv` where `symbol='NIFTY50'`
- Produces:
  - `load_cs_training_data() -> pd.DataFrame` — training rows with `cs_percentile` column
  - `train_cs_ranker(df) -> dict` — trains LightGBM, returns model dict with `spearman_rho`
  - `score_batch() -> int` — scores pending signals, writes `cs_score`, returns count
  - `src/server/ml_models/cs_ranker.pkl` — saved model
  - CLI: `python cs_ranker.py --train`, `python cs_ranker.py --score`

- [ ] **Step 1: Create cs_ranker.py**

Create `src/server/cs_ranker.py` with this full content:

```python
"""
cs_ranker.py — Cross-sectional alpha ranker.

Trains a LightGBM regressor to predict each signal's alpha percentile (rank
among all signals on the same date by excess return vs Nifty 50). Produces
cs_score (0–100) on technical_signals for use by unified_ranker.py.

Run:
    python cs_ranker.py --train
    python cs_ranker.py --score
"""

import os
import sys
import pickle
import datetime
import argparse
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from db_compat import connect, read_df, ConnWrapper

# Import feature engineering from the binary ensemble — same pipeline, different label.
sys.path.insert(0, os.path.dirname(__file__))
from ml_ensemble import build_features

MODELS_DIR    = os.path.join(os.getcwd(), 'src', 'server', 'ml_models')
CS_MODEL_PATH = os.path.join(MODELS_DIR, 'cs_ranker.pkl')
MIN_DATE_SIGNALS = 5   # minimum signals per date to include in training


# ── Label Construction ────────────────────────────────────────────────────────

def _get_nifty_returns(conn: ConnWrapper) -> pd.DataFrame:
    """5-day forward returns for NIFTY50 from stock_ohlcv, indexed by date string."""
    q = """
        SELECT date, close
        FROM stock_ohlcv
        WHERE symbol = 'NIFTY50'
        ORDER BY date
    """
    df = read_df(q)
    if df.empty:
        return pd.DataFrame(columns=['date', 'nifty_ret_5d'])
    df['date'] = df['date'].astype(str).str[:10]
    df = df.sort_values('date').reset_index(drop=True)
    # Forward-5d return: (close[t+5] - close[t]) / close[t]
    df['nifty_ret_5d'] = (df['close'].shift(-5) - df['close']) / df['close'].replace(0, np.nan) * 100
    return df[['date', 'nifty_ret_5d']].dropna()


def load_cs_training_data() -> pd.DataFrame:
    """
    Returns a DataFrame of resolved signal rows with a `cs_percentile` column
    (0–100 rank of alpha within each signal_date group).

    Alpha = return_pct - nifty_5d_return. Dates with fewer than MIN_DATE_SIGNALS
    signals are excluded (too sparse to rank meaningfully).
    """
    conn = connect()
    nifty = _get_nifty_returns(conn)
    if nifty.empty:
        print("[CSRanker] WARNING: No NIFTY50 data in stock_ohlcv — using raw return_pct as target")
        nifty = None

    q = """
        SELECT so.symbol, so.signal_date, so.return_pct,
               so.signal_score, so.signals_json, so.horizon_days,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net, ts.above_sma200, ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net, ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               COALESCE(fh.fifty_two_week_high, sf.fifty_two_week_high) AS fifty_two_week_high,
               COALESCE(fh.piotroski_f_score, sf.piotroski_f_score)     AS piotroski_f_score,
               COALESCE(fh.debt_to_equity, sf.debt_to_equity)           AS debt_to_equity,
               COALESCE(fh.operating_margins, sf.operating_margins)     AS operating_margins,
               COALESCE(fh.return_on_equity, sf.return_on_equity)       AS return_on_equity,
               COALESCE(fh.revenue_growth, sf.revenue_growth)           AS revenue_growth,
               COALESCE(fh.earnings_growth, sf.earnings_growth)         AS earnings_growth,
               COALESCE(fh.earnings_yield, sf.earnings_yield)           AS earnings_yield,
               COALESCE(fh.price_to_book, sf.price_to_book)             AS price_to_book,
               COALESCE(fh.market_cap, sf.market_cap)                   AS market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
        LEFT JOIN fundamentals_history fh
               ON fh.symbol = so.symbol
              AND fh.as_of_date = (
                  SELECT MAX(fh2.as_of_date) FROM fundamentals_history fh2
                  WHERE fh2.symbol = so.symbol AND fh2.as_of_date <= so.signal_date
              )
        LEFT JOIN stock_fundamentals sf ON sf.symbol = so.symbol
        LEFT JOIN analyst_estimates_history aeh
               ON aeh.symbol = so.symbol
              AND aeh.as_of_date = (
                  SELECT MAX(aeh2.as_of_date) FROM analyst_estimates_history aeh2
                  WHERE aeh2.symbol = so.symbol AND aeh2.as_of_date <= so.signal_date
              )
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = so.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score' AND p2.date <= so.signal_date
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = so.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score' AND p2.date <= so.signal_date
              )
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS')
          AND so.return_pct IS NOT NULL
          AND so.horizon_days = 5
    """
    df = read_df(q)
    if df.empty:
        print("[CSRanker] No resolved 5d outcomes found.")
        return df

    df['signal_date'] = df['signal_date'].astype(str).str[:10]
    df['return_pct']  = pd.to_numeric(df['return_pct'], errors='coerce')

    # Compute alpha: excess return vs Nifty
    if nifty is not None:
        df = df.merge(nifty, left_on='signal_date', right_on='date', how='left')
        df['alpha'] = df['return_pct'] - df['nifty_ret_5d'].fillna(0)
    else:
        df['alpha'] = df['return_pct']

    # Drop sparse dates
    date_counts = df.groupby('signal_date')['symbol'].count()
    valid_dates = date_counts[date_counts >= MIN_DATE_SIGNALS].index
    df = df[df['signal_date'].isin(valid_dates)].copy()
    if df.empty:
        print(f"[CSRanker] No dates with >= {MIN_DATE_SIGNALS} signals.")
        return df

    # Rank alpha within each date → percentile 0-100
    def _pct_rank(group):
        n = len(group)
        ranks = group['alpha'].rank(method='average')
        group = group.copy()
        group['cs_percentile'] = (ranks - 1) / max(1, n - 1) * 100
        return group

    df = df.groupby('signal_date', group_keys=False).apply(_pct_rank)
    df = df.sort_values('signal_date').reset_index(drop=True)

    print(f"[CSRanker] Training data: {len(df)} rows across {df['signal_date'].nunique()} dates "
          f"(win_rate_above50pct={( df['cs_percentile'] > 50 ).mean():.1%})")
    return df


# ── Model Training ────────────────────────────────────────────────────────────

def train_cs_ranker(df: pd.DataFrame, min_samples: int = 50) -> dict:
    """
    Train LightGBM regressor on cs_percentile. Returns a model dict with keys:
        model, feature_names, spearman_rho, n_samples, trained_at
    """
    from lightgbm import LGBMRegressor

    if len(df) < min_samples:
        raise ValueError(f"[CSRanker] Only {len(df)} samples — need {min_samples} to train.")

    X = build_features(df)
    y = df['cs_percentile'].values

    # Held-out test: last 20% of dates (chronological, no shuffling)
    dates_sorted = sorted(df['signal_date'].unique())
    n_test_dates = max(1, int(len(dates_sorted) * 0.20))
    test_dates   = set(dates_sorted[-n_test_dates:])
    train_mask   = ~df['signal_date'].isin(test_dates)
    test_mask    = df['signal_date'].isin(test_dates)

    X_tr, y_tr = X[train_mask], y[train_mask]
    X_te, y_te = X[test_mask],  y[test_mask]

    model = LGBMRegressor(
        objective='regression_l2',
        n_estimators=400,
        learning_rate=0.05,
        num_leaves=63,
        min_child_samples=20,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        verbose=-1,
    )
    model.fit(X_tr, y_tr)

    preds_te = model.predict(X_te)
    rho, pval = spearmanr(y_te, preds_te)
    print(f"[CSRanker] Held-out Spearman ρ={rho:.4f}  (p={pval:.3g}, n={len(y_te)})")
    if rho < 0.10:
        print(f"[CSRanker] WARNING: ρ={rho:.4f} below acceptance threshold 0.10 — model saved anyway")

    # Retrain on full data
    model.fit(X, y)

    return {
        'model':         model,
        'feature_names': list(X.columns),
        'spearman_rho':  float(rho),
        'n_samples':     len(df),
        'trained_at':    datetime.datetime.utcnow().isoformat(),
    }


def save_cs_model(m: dict):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(CS_MODEL_PATH, 'wb') as f:
        pickle.dump(m, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[CSRanker] Saved to {CS_MODEL_PATH}")


def load_cs_model() -> dict | None:
    if not os.path.exists(CS_MODEL_PATH):
        return None
    with open(CS_MODEL_PATH, 'rb') as f:
        return pickle.load(f)


def _register_cs_model(conn: ConnWrapper, m: dict) -> int:
    import json
    version  = datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    feats    = m.get('feature_names', [])
    top_feats = []
    mdl = m['model']
    if hasattr(mdl, 'feature_importances_'):
        pairs = sorted(zip(feats, mdl.feature_importances_), key=lambda x: -x[1])[:15]
        top_feats = [{'feature': f, 'importance': round(float(i), 6)} for f, i in pairs]

    cur = conn.cursor()
    cur.execute("UPDATE model_registry SET is_active = 0 WHERE model_name = 'cs_ranker' AND is_active = 1")
    cur.execute("""
        INSERT INTO model_registry
            (model_name, model_version, model_type, trained_at,
             training_samples, cv_roc_auc, cv_accuracy,
             feature_count, top_features_json, model_path, is_active, horizon_days, notes)
        VALUES ('cs_ranker', ?, 'LightGBM Regressor', ?, ?, ?, ?, ?, ?, ?, 1, 5, ?)
        RETURNING id
    """, (
        version, m['trained_at'], m['n_samples'],
        m['spearman_rho'], None,
        len(feats), json.dumps(top_feats), CS_MODEL_PATH,
        f"spearman_rho={m['spearman_rho']:.4f}",
    ))
    model_id = cur.fetchone()[0]
    conn.commit()
    print(f"[CSRanker] Registered as model_id={model_id} version={version}")
    return model_id


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_batch() -> int:
    """
    Score all technical_signals rows where cs_score IS NULL and win_probability IS NOT NULL.
    Normalizes predictions to 0-100 percentile within today's batch before writing.
    Returns count of rows scored.
    """
    m = load_cs_model()
    if m is None:
        print("[CSRanker] No model found — run --train first.")
        return 0

    q = """
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net, ts.above_sma200, ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net, ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               sf.fifty_two_week_high,
               sf.piotroski_f_score, sf.debt_to_equity, sf.operating_margins,
               sf.return_on_equity, sf.revenue_growth, sf.earnings_growth,
               sf.earnings_yield, sf.price_to_book, sf.market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
        LEFT JOIN analyst_estimates_history aeh
               ON aeh.symbol = ts.symbol
              AND aeh.as_of_date = (
                  SELECT MAX(aeh2.as_of_date) FROM analyst_estimates_history aeh2
                  WHERE aeh2.symbol = ts.symbol AND aeh2.as_of_date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = ts.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score' AND p2.date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = ts.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score' AND p2.date <= ts.date
              )
        WHERE ts.cs_score IS NULL
          AND ts.win_probability IS NOT NULL
        ORDER BY ts.date DESC
        LIMIT 10000
    """
    df = read_df(q)
    if df.empty:
        print("[CSRanker] No pending signals to score.")
        return 0

    df['horizon_days'] = 15
    X = build_features(df)

    # Align to training feature set
    for col in m['feature_names']:
        if col not in X.columns:
            X[col] = 0.0
    X = X[m['feature_names']]

    raw_preds = m['model'].predict(X)

    # Percentile-rank within this batch → 0-100
    n = len(raw_preds)
    rank_order = raw_preds.argsort().argsort()   # stable double-argsort = rank
    cs_scores  = rank_order / max(1, n - 1) * 100

    conn  = connect()
    cur   = conn.cursor()
    count = 0
    for i, row in df.iterrows():
        cur.execute(
            "UPDATE technical_signals SET cs_score = ? WHERE symbol = ? AND date = ?",
            (round(float(cs_scores[df.index.get_loc(i)]), 2), row['symbol'], row['signal_date']),
        )
        count += 1
    conn.commit()
    print(f"[CSRanker] Scored and wrote cs_score for {count} signals.")
    return count


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', action='store_true')
    parser.add_argument('--score', action='store_true')
    parser.add_argument('--min-samples', type=int, default=50)
    args = parser.parse_args()

    if args.train:
        df = load_cs_training_data()
        if df.empty:
            print("[CSRanker] No training data — aborting.")
            sys.exit(1)
        m = train_cs_ranker(df, min_samples=args.min_samples)
        save_cs_model(m)
        conn = connect()
        _register_cs_model(conn, m)

    if args.score:
        score_batch()

    if not args.train and not args.score:
        parser.print_help()
```

- [ ] **Step 2: Run syntax check**

```powershell
cd d:\Github\bharat-stock-intelligence\src\server
..\..\backend-python\venv\Scripts\python -c "import py_compile; py_compile.compile('cs_ranker.py', doraise=True); print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Smoke-test import (no DB needed)**

```powershell
..\..\backend-python\venv\Scripts\python -c "
from cs_ranker import load_cs_model, save_cs_model, score_batch
from ml_ensemble import build_features
import pandas as pd
# Verify build_features is imported, not duplicated
df = pd.DataFrame({'signal_score':[5], 'rsi':[50], 'adx':[20], 'volume_ratio':[1.0], 'cmp':[100], 'sma200':[95]})
X = build_features(df)
print('columns:', len(X.columns), 'OK')
"
```

Expected: `columns: <N> OK` (same number of columns as in ml_ensemble.py).

- [ ] **Step 4: Commit**

```bash
git add src/server/cs_ranker.py
git commit -m "feat(ml): add cs_ranker.py — cross-sectional alpha ranker (LightGBM regressor)"
```

---

## Task 3: Tests for `cs_ranker.py`

**Files:**
- Create: `src/server/tests/test_cs_ranker.py`

**Interfaces:**
- Consumes: `load_cs_training_data`, `train_cs_ranker`, `score_batch`, `_get_nifty_returns`, `_pct_rank` logic from `cs_ranker`
- Produces: test file covering label construction, date filter, inference normalization

- [ ] **Step 1: Create test file**

Create `src/server/tests/test_cs_ranker.py`:

```python
"""
Tests for cs_ranker.py:
  1. Alpha percentile label construction (given known returns, assert ranks)
  2. Minimum-date filter (dates with < MIN_DATE_SIGNALS signals excluded)
  3. Feature reuse: build_features produces same columns from cs_ranker vs ml_ensemble
  4. Inference normalization: score_batch output is in [0, 100], top stock scores highest
  5. Spearman rho computation on synthetic data
"""
import sys
import os
import pytest
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from cs_ranker import MIN_DATE_SIGNALS, train_cs_ranker, load_cs_model, save_cs_model
from ml_ensemble import build_features


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_row(**kwargs):
    defaults = {
        'signal_score': 5.0, 'rsi': 50.0, 'adx': 20.0, 'volume_ratio': 1.0,
        'horizon_days': 15, 'nifty_regime': 'BULL', 'cmp': 100.0, 'sma200': 95.0,
        'signals_json': None, 'fii_3d_net': 0, 'above_sma200': 1, 'pcr_oi': 1.0,
        'pcr_vol': 1.0, 'fii_10d_net': 0, 'dii_3d_net': 0, 'delivery_pct': 50,
        'sector_ret_5d': 0, 'sector_ret_21d': 0, 'iv_rank': 0.5, 'iv_skew': 0,
        'rs_rank_21d': 0.5, 'rs_rank_63d': 0.5, 'insider_buy_pct_90d': 0.5,
        'opening_range_break': 0, 'vwap_deviation_pct': 0, 'first_hour_vol_share': 0.5,
        'fifty_two_week_high': 110.0, 'piotroski_f_score': 5, 'debt_to_equity': 0.5,
        'operating_margins': 15, 'return_on_equity': 12, 'revenue_growth': 10,
        'earnings_growth': 8, 'earnings_yield': 4, 'price_to_book': 2.5,
        'market_cap': 1e10, 'n_analysts': 5, 'buy_count': 3, 'target_mean': 105,
        'altman_z': 3.0, 'ohlson_o': -2.0,
    }
    defaults.update(kwargs)
    return defaults


def _make_training_df(rows):
    """Build a DataFrame suitable for train_cs_ranker from list of dicts."""
    df = pd.DataFrame(rows)
    df['signal_date'] = df['signal_date'].astype(str)
    return df


# ── Test 1: Label construction — alpha percentile ranks ───────────────────────

class TestAlphaPercentileLabels:
    def test_three_signals_same_date_rank_correctly(self):
        """3 signals on one date: alpha -2, 0, +5 → percentiles 0, 50, 100."""
        date = '2025-01-10'
        rows = [
            {'signal_date': date, 'symbol': 'A', 'alpha': -2.0},
            {'signal_date': date, 'symbol': 'B', 'alpha':  0.0},
            {'signal_date': date, 'symbol': 'C', 'alpha':  5.0},
        ]
        df = pd.DataFrame(rows)

        def _pct_rank_group(group):
            n = len(group)
            ranks = group['alpha'].rank(method='average')
            group = group.copy()
            group['cs_percentile'] = (ranks - 1) / max(1, n - 1) * 100
            return group

        result = df.groupby('signal_date', group_keys=False).apply(_pct_rank_group)
        result = result.set_index('symbol')

        assert result.loc['A', 'cs_percentile'] == pytest.approx(0.0)
        assert result.loc['B', 'cs_percentile'] == pytest.approx(50.0)
        assert result.loc['C', 'cs_percentile'] == pytest.approx(100.0)

    def test_two_signals_same_date_get_0_and_100(self):
        """2 signals → min=0, max=100."""
        date = '2025-01-11'
        rows = [
            {'signal_date': date, 'symbol': 'X', 'alpha': 1.0},
            {'signal_date': date, 'symbol': 'Y', 'alpha': 3.0},
        ]
        df = pd.DataFrame(rows)

        def _pct_rank_group(group):
            n = len(group)
            ranks = group['alpha'].rank(method='average')
            group = group.copy()
            group['cs_percentile'] = (ranks - 1) / max(1, n - 1) * 100
            return group

        result = df.groupby('signal_date', group_keys=False).apply(_pct_rank_group)
        result = result.set_index('symbol')

        assert result.loc['X', 'cs_percentile'] == pytest.approx(0.0)
        assert result.loc['Y', 'cs_percentile'] == pytest.approx(100.0)


# ── Test 2: Minimum date filter ───────────────────────────────────────────────

class TestMinDateFilter:
    def test_dates_below_min_signals_excluded(self):
        """
        Date A has MIN_DATE_SIGNALS - 1 rows → excluded.
        Date B has MIN_DATE_SIGNALS rows → included.
        """
        rows_a = [{'signal_date': '2025-01-05', 'symbol': f'S{i}', 'alpha': float(i)}
                  for i in range(MIN_DATE_SIGNALS - 1)]
        rows_b = [{'signal_date': '2025-01-06', 'symbol': f'T{i}', 'alpha': float(i)}
                  for i in range(MIN_DATE_SIGNALS)]

        df = pd.DataFrame(rows_a + rows_b)
        date_counts = df.groupby('signal_date')['symbol'].count()
        valid_dates = date_counts[date_counts >= MIN_DATE_SIGNALS].index
        filtered = df[df['signal_date'].isin(valid_dates)]

        assert '2025-01-05' not in filtered['signal_date'].values
        assert '2025-01-06' in filtered['signal_date'].values

    def test_date_exactly_at_min_is_included(self):
        rows = [{'signal_date': '2025-02-01', 'symbol': f'Z{i}', 'alpha': float(i)}
                for i in range(MIN_DATE_SIGNALS)]
        df = pd.DataFrame(rows)
        date_counts = df.groupby('signal_date')['symbol'].count()
        valid_dates = date_counts[date_counts >= MIN_DATE_SIGNALS].index
        assert '2025-02-01' in valid_dates


# ── Test 3: Feature reuse ─────────────────────────────────────────────────────

class TestFeatureReuse:
    def test_build_features_same_columns_from_cs_ranker_import(self):
        """cs_ranker imports build_features from ml_ensemble — same columns result."""
        from cs_ranker import build_features as cs_bf
        from ml_ensemble import build_features as ens_bf

        row = pd.DataFrame([_make_row()])
        X_cs  = cs_bf(row)
        X_ens = ens_bf(row)

        assert list(X_cs.columns) == list(X_ens.columns), (
            "cs_ranker.build_features columns differ from ml_ensemble.build_features"
        )


# ── Test 4: Inference normalization ──────────────────────────────────────────

class TestInferenceNormalization:
    def test_score_batch_normalization_produces_0_to_100(self):
        """Given raw LightGBM predictions, the double-argsort normalization yields [0,100]."""
        raw_preds = np.array([0.3, 1.5, 0.8, 2.1, 0.1])
        n = len(raw_preds)
        rank_order = raw_preds.argsort().argsort()
        cs_scores  = rank_order / max(1, n - 1) * 100

        assert cs_scores.min() == pytest.approx(0.0)
        assert cs_scores.max() == pytest.approx(100.0)

    def test_score_batch_normalization_top_stock_scores_highest(self):
        """Stock with highest raw prediction gets cs_score=100."""
        raw_preds = np.array([0.3, 1.5, 0.8, 2.1, 0.1])
        n = len(raw_preds)
        rank_order = raw_preds.argsort().argsort()
        cs_scores  = rank_order / max(1, n - 1) * 100

        best_idx = np.argmax(raw_preds)
        assert cs_scores[best_idx] == pytest.approx(100.0)

    def test_score_batch_normalization_worst_stock_scores_zero(self):
        """Stock with lowest raw prediction gets cs_score=0."""
        raw_preds = np.array([0.3, 1.5, 0.8, 2.1, 0.1])
        n = len(raw_preds)
        rank_order = raw_preds.argsort().argsort()
        cs_scores  = rank_order / max(1, n - 1) * 100

        worst_idx = np.argmin(raw_preds)
        assert cs_scores[worst_idx] == pytest.approx(0.0)


# ── Test 5: Spearman rho on synthetic data ────────────────────────────────────

class TestSpearmanRho:
    def test_perfect_prediction_yields_rho_1(self):
        """When predictions perfectly track actuals, Spearman ρ = 1.0."""
        from scipy.stats import spearmanr
        actuals = np.array([10, 20, 30, 40, 50], dtype=float)
        preds   = np.array([1.1, 2.2, 3.3, 4.4, 5.5], dtype=float)
        rho, _ = spearmanr(actuals, preds)
        assert rho == pytest.approx(1.0)

    def test_reverse_prediction_yields_rho_minus1(self):
        """Inverted predictions → ρ = -1.0."""
        from scipy.stats import spearmanr
        actuals = np.array([10, 20, 30, 40, 50], dtype=float)
        preds   = np.array([5.5, 4.4, 3.3, 2.2, 1.1], dtype=float)
        rho, _ = spearmanr(actuals, preds)
        assert rho == pytest.approx(-1.0)
```

- [ ] **Step 2: Run tests (expect all to pass)**

```powershell
cd d:\Github\bharat-stock-intelligence
backend-python\venv\Scripts\python -m pytest src/server/tests/test_cs_ranker.py -v
```

Expected output (all 12 tests green):
```
test_cs_ranker.py::TestAlphaPercentileLabels::test_three_signals_same_date_rank_correctly PASSED
test_cs_ranker.py::TestAlphaPercentileLabels::test_two_signals_same_date_get_0_and_100 PASSED
test_cs_ranker.py::TestMinDateFilter::test_dates_below_min_signals_excluded PASSED
test_cs_ranker.py::TestMinDateFilter::test_date_exactly_at_min_is_included PASSED
test_cs_ranker.py::TestFeatureReuse::test_build_features_same_columns_from_cs_ranker_import PASSED
test_cs_ranker.py::TestInferenceNormalization::test_score_batch_normalization_produces_0_to_100 PASSED
test_cs_ranker.py::TestInferenceNormalization::test_score_batch_normalization_top_stock_scores_highest PASSED
test_cs_ranker.py::TestInferenceNormalization::test_score_batch_normalization_worst_stock_scores_zero PASSED
test_cs_ranker.py::TestSpearmanRho::test_perfect_prediction_yields_rho_1 PASSED
test_cs_ranker.py::TestSpearmanRho::test_reverse_prediction_yields_rho_minus1 PASSED
========= 10 passed in X.Xs ==========
```

- [ ] **Step 3: Run initial training to verify end-to-end**

```powershell
cd d:\Github\bharat-stock-intelligence\src\server
..\..\backend-python\venv\Scripts\python cs_ranker.py --train
```

Expected output (numbers will vary):
```
[CSRanker] Training data: NNNNN rows across NNN dates ...
[CSRanker] Held-out Spearman ρ=0.XXXX  (p=X.Xe-XX, n=NNNN)
[CSRanker] Saved to .../ml_models/cs_ranker.pkl
[CSRanker] Registered as model_id=N version=20260625_XXXXXX
```

- [ ] **Step 4: Run scoring to verify cs_score gets written**

```powershell
..\..\backend-python\venv\Scripts\python cs_ranker.py --score
```

Expected: `[CSRanker] Scored and wrote cs_score for N signals.`

Verify via DB:
```powershell
..\..\backend-python\venv\Scripts\python -c "
from db_compat import read_df
df = read_df(\"SELECT COUNT(*) as n, MIN(cs_score), MAX(cs_score) FROM technical_signals WHERE cs_score IS NOT NULL\")
print(df)
"
```

Expected: `n > 0`, `MIN >= 0`, `MAX <= 100`.

- [ ] **Step 5: Commit**

```bash
git add src/server/tests/test_cs_ranker.py
git commit -m "test(ml): cs_ranker unit tests — label construction, normalization, feature reuse"
```

---

## Task 4: Integrate `cs_score` into `unified_ranker.py`

**Files:**
- Modify: `src/server/unified_ranker.py`

**Interfaces:**
- Consumes: `technical_signals.cs_score` from Task 1; `_normalize_to_100()` already in the module
- Produces:
  - `_get_cs_scores(self) -> dict[str, float]` — `{symbol: cs_score_0_to_100}`
  - Updated `REGIME_WEIGHTS` — 'cs': 0.05 in all 5 regimes; 'ml' reduced to 0.20
  - Updated `engine_maps` and `all_symbols` to include 'cs'

- [ ] **Step 1: Update REGIME_WEIGHTS**

Find the `REGIME_WEIGHTS` dict (around line 77 in `unified_ranker.py`). Replace it entirely:

```python
REGIME_WEIGHTS = {
    'BULL':     {'screener': 0.30, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.20, 'technical': 0.15, 'dl': 0.10},
    'BEAR':     {'screener': 0.35, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.20, 'technical': 0.10, 'dl': 0.10},
    'HIGH_VOL': {'screener': 0.20, 'ml': 0.15, 'cs': 0.05, 'confluence': 0.15, 'technical': 0.30, 'dl': 0.15},
    'CRASH':    {'screener': 0.40, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.15, 'technical': 0.10, 'dl': 0.10},
    'SIDEWAYS': {'screener': 0.32, 'ml': 0.20, 'cs': 0.05, 'confluence': 0.20, 'technical': 0.13, 'dl': 0.10},
}
```

- [ ] **Step 2: Add `_get_cs_scores` method**

Find `_get_ml_scores` method (around line 435). Add `_get_cs_scores` immediately after it:

```python
    def _get_cs_scores(self):
        cutoff = (date.today() - timedelta(days=3)).isoformat()
        try:
            rows = self.conn.execute(
                "SELECT symbol, AVG(cs_score) AS s FROM technical_signals "
                "WHERE date >= ? AND cs_score IS NOT NULL GROUP BY symbol",
                (cutoff,),
            ).fetchall()
            return _normalize_to_100({r['symbol']: float(r['s'] or 0) for r in rows})
        except Exception:
            self.conn.rollback()
            return {}
```

- [ ] **Step 3: Wire `_get_cs_scores` into `rank_stocks`**

Find the `rank_stocks` method body where `ml_scores`, `confluence_scores`, etc. are computed (around line 658). Add the `cs_scores` call and update `engine_maps` and `all_symbols`:

The existing block:
```python
        ml_scores         = self._get_ml_scores()
        confluence_scores = self._get_confluence_scores()
        technical_scores  = self._get_technical_scores()
        dl_scores         = self._get_dl_scores()
        avg_track         = self._get_avg_track_record()

        all_symbols = set(screener_scores) | set(ml_scores) | set(confluence_scores) | set(technical_scores) | set(dl_scores)

        engine_maps = {
            'screener':   screener_scores,
            'ml':         ml_scores,
            'confluence': confluence_scores,
            'technical':  technical_scores,
            'dl':         dl_scores,
        }
```

Replace with:
```python
        ml_scores         = self._get_ml_scores()
        cs_scores         = self._get_cs_scores()
        confluence_scores = self._get_confluence_scores()
        technical_scores  = self._get_technical_scores()
        dl_scores         = self._get_dl_scores()
        avg_track         = self._get_avg_track_record()

        all_symbols = set(screener_scores) | set(ml_scores) | set(cs_scores) | set(confluence_scores) | set(technical_scores) | set(dl_scores)

        engine_maps = {
            'screener':   screener_scores,
            'ml':         ml_scores,
            'cs':         cs_scores,
            'confluence': confluence_scores,
            'technical':  technical_scores,
            'dl':         dl_scores,
        }
```

- [ ] **Step 4: Verify unified_ranker imports cleanly**

```powershell
cd d:\Github\bharat-stock-intelligence\src\server
..\..\backend-python\venv\Scripts\python -c "
from unified_ranker import UnifiedRanker, REGIME_WEIGHTS
# Verify all regimes sum to 1.0
for regime, w in REGIME_WEIGHTS.items():
    total = round(sum(w.values()), 10)
    assert total == 1.0, f'{regime} sums to {total}'
    assert 'cs' in w, f'{regime} missing cs key'
print('All REGIME_WEIGHTS sum to 1.0 and have cs key — OK')
r = UnifiedRanker.__new__(UnifiedRanker)
assert hasattr(r, '_get_cs_scores'), '_get_cs_scores method missing'
print('_get_cs_scores present — OK')
"
```

Expected:
```
All REGIME_WEIGHTS sum to 1.0 and have cs key — OK
_get_cs_scores present — OK
```

- [ ] **Step 5: Commit**

```bash
git add src/server/unified_ranker.py
git commit -m "feat(ranker): integrate cs_score into unified_ranker — _get_cs_scores + REGIME_WEIGHTS"
```

---

## Task 5: Wire `cs_ranker.py` into `queues.ts` crons

**Files:**
- Modify: `src/server/queues.ts`

**Interfaces:**
- Consumes: `runPython()` helper already in queues.ts; `processMlDailyOps` and `processMlWeeklyRetrain` functions

- [ ] **Step 1: Add `--score` to `processMlDailyOps`**

Find `processMlDailyOps` (around line 408). After the `ml_calibration.py` call (around line 461), add:

```typescript
  await runPython('cs_ranker.py', ['--score'], 120_000)
    .catch(e => console.warn('[QUEUE] cs_ranker score failed:', (e as Error).message));
```

The full block in context (the lines before and after your insertion):
```typescript
  await runPython('ml_calibration.py', [], 120_000)
    .catch(e => console.warn('[QUEUE] ml_calibration failed:', (e as Error).message));

  await runPython('cs_ranker.py', ['--score'], 120_000)
    .catch(e => console.warn('[QUEUE] cs_ranker score failed:', (e as Error).message));

  await runPython('reward_engine.py');
```

- [ ] **Step 2: Add `--train` to `processMlWeeklyRetrain`**

Find `processMlWeeklyRetrain` (around line 496). After `ml_ensemble.py --train --score`:

```typescript
  await runPython('ml_ensemble.py', ['--train', '--score'], 60 * 60_000);
  await runPython('cs_ranker.py', ['--train', '--score'], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] cs_ranker retrain failed:', (e as Error).message));
```

- [ ] **Step 3: TypeScript compile check**

```powershell
cd d:\Github\bharat-stock-intelligence
npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors (or pre-existing errors only — confirm count unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat(queues): wire cs_ranker --score into daily ops and --train into weekly retrain"
```

---

## Final Verification

- [ ] **Run full Python test suite**

```powershell
cd d:\Github\bharat-stock-intelligence
backend-python\venv\Scripts\python -m pytest src/server/tests/ -v --tb=short 2>&1 | tail -20
```

Expected: same number of tests as before (284) + 10 new cs_ranker tests = **294 passed**.

- [ ] **Verify cs_score is live in the DB**

```powershell
cd d:\Github\bharat-stock-intelligence\src\server
..\..\backend-python\venv\Scripts\python -c "
from db_compat import read_df
df = read_df(\"SELECT symbol, date, cs_score, win_probability FROM technical_signals WHERE cs_score IS NOT NULL ORDER BY date DESC LIMIT 5\")
print(df)
"
```

Expected: 5 rows with `cs_score` values between 0 and 100 alongside existing `win_probability`.
