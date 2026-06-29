# ML Feature Expansion — MC Vitals, Insider Activity, Intraday Microstructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire three data feeds already accumulating in PG into the ML ensemble, adding ~7 new features to the 47-feature model: MC financial-distress scores (Altman Z, Ohlson O), rolling insider buy/sell ratio, and intraday microstructure (opening-range break, VWAP deviation, first-hour volume share).

**Architecture:** Each feed follows the established pattern. MC Vitals are joined AS-OF in the ML SQL queries (like `analyst_estimates_history`). Insider and intraday features are computed by new Python engines that write derived scalar columns to `technical_signals`; `ml_ensemble` reads them via the existing SELECT. Each engine is wired into `processMlDailyOps` in `queues.ts`. All engines use `db_compat` (dual-mode SQLite + PG). All three tasks modify `ml_ensemble.py` and must be executed **sequentially** to avoid merge conflicts.

**Tech Stack:** Python 3.11, pandas, numpy, db_compat (psycopg2 / better-sqlite3 via facade), BullMQ, pytest

## Global Constraints

- All Python engines: `from db_compat import connect, read_df, use_postgres, executemany` — never `sqlite3.connect()`
- All SQL: `?` placeholders (db_compat translator maps to `$N` on PG)
- New `technical_signals` columns: `migrateColumn(...)` in `src/server/db.ts` AND `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `db/schema.postgres.sql` AND applied to live PG with `docker exec`
- `build_features` uses `num(col, default)` helper for null-safe access — never raw `df[col]`
- Python tests: `src/server/tests/`, run from repo root: `python -m pytest src/server/tests/ -v`
- sys.path pattern for test imports: `sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))`
- After all tasks: retrain the ensemble via `backend-python\venv\Scripts\python src\server\ml_ensemble.py --train`

---

### Task 1: MC Vitals AS-OF features (altman_z, ohlson_o)

**Files:**
- Modify: `src/server/ml_ensemble.py` — `load_training_data`, `load_pending_signals`, `build_features`
- Modify: `src/server/tests/test_ml_ensemble.py` — new `TestMCVitalsFeatures` class

No new DB columns needed. The EAV pivot from `proprietary_scores_history` (written by `moneycontrol_fetcher.py._parse_vitals`) is done at query time using conditional LEFT JOINs, identical to the `analyst_estimates_history` pattern.

**Interfaces:**
- Consumes: `proprietary_scores_history(symbol TEXT, date TEXT, source TEXT, score_type TEXT, score_value REAL)` — already written by `moneycontrol_fetcher.py` daily
- Produces: `altman_z REAL`, `ohlson_o REAL`, `altman_distress REAL` float features in `build_features` output

---

- [ ] **Step 1: Verify actual score_type strings in live PG**

Run this against the running TimescaleDB (port 5433, user bharat, db bharat_intel):

```bash
docker exec -i bharat_timescaledb psql -U bharat -d bharat_intel -c \
  "SELECT DISTINCT score_type, COUNT(*) FROM proprietary_scores_history WHERE source='moneycontrol' GROUP BY score_type ORDER BY count DESC LIMIT 20;"
```

Expected output includes rows containing `altman_z_score` and `ohlson_o_score` (derived by `_parse_vitals` as `heading.lower().replace('-','_').replace(' ','_')`). If the strings differ from those two, substitute the actual strings in Steps 6 and 7 below. If the table is empty (fetcher hasn't run yet), proceed — features will fall back to neutral defaults until data accumulates.

---

- [ ] **Step 2: Write failing tests**

Add this class to `src/server/tests/test_ml_ensemble.py` after `TestRelativeStrengthFeatures`:

```python
class TestMCVitalsFeatures:
    """Altman Z and Ohlson O-Score from proprietary_scores_history AS-OF pivot."""

    def test_vitals_features_present(self):
        X = build_features(_make_feature_df())
        for col in ['altman_z', 'altman_distress', 'ohlson_o']:
            assert col in X.columns, f"Expected {col} in build_features output"

    def test_missing_vitals_no_nan(self):
        X = build_features(_make_feature_df())
        assert not X['altman_z'].isna().any()
        assert not X['altman_distress'].isna().any()
        assert not X['ohlson_o'].isna().any()

    def test_altman_distress_fires_below_threshold(self):
        df = _make_feature_df(n=3)
        df['altman_z'] = [1.0, 2.0, 3.5]  # distress / grey / safe
        X = build_features(df)
        assert X['altman_distress'].iloc[0] == 1.0  # < 1.23 → distress flag
        assert X['altman_distress'].iloc[1] == 0.0  # grey zone → no flag
        assert X['altman_distress'].iloc[2] == 0.0  # safe zone → no flag

    def test_altman_z_clipped(self):
        df = _make_feature_df(n=2)
        df['altman_z'] = [-99.0, 999.0]
        X = build_features(df)
        assert X['altman_z'].iloc[0] >= -5.0
        assert X['altman_z'].iloc[1] <= 15.0

    def test_ohlson_o_clipped(self):
        df = _make_feature_df(n=2)
        df['ohlson_o'] = [-99.0, 999.0]
        X = build_features(df)
        assert X['ohlson_o'].iloc[0] >= -10.0
        assert X['ohlson_o'].iloc[1] <= 5.0
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
python -m pytest src/server/tests/test_ml_ensemble.py::TestMCVitalsFeatures -v
```
Expected: 5 FAIL — `altman_z`, `altman_distress`, `ohlson_o` not in build_features output.

---

- [ ] **Step 4: Add features to build_features**

In `src/server/ml_ensemble.py`, in `build_features()`, add this block just after the analyst consensus block (after the `X['target_upside_pct']` line, around line 195) and before the market-level NOTE comment:

```python
    # ── MC Vitals: financial distress scores (AS-OF from proprietary_scores_history) ──
    # Altman Z-Score: > 2.99 = safe zone, 1.23–2.99 = grey zone, < 1.23 = distress zone.
    # Neutral default 2.0 = mid-grey (avoids penalising stocks not yet in 150-stock batch).
    X['altman_z']        = num('altman_z', 2.0).clip(-5, 15)
    X['altman_distress'] = (num('altman_z', 2.0) < 1.23).astype(np.float32)
    # Ohlson O-Score: log-odds of failure; negative = lower failure probability.
    # Neutral default -2.0 (moderate safety, representative of a typical listed company).
    X['ohlson_o']        = num('ohlson_o', -2.0).clip(-10, 5)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
python -m pytest src/server/tests/test_ml_ensemble.py::TestMCVitalsFeatures -v
```
Expected: 5 PASS.

---

- [ ] **Step 6: Add AS-OF joins to load_training_data**

In `src/server/ml_ensemble.py`, in `load_training_data()`:

1. In the SELECT list, replace the last line `aeh.n_analysts, aeh.buy_count, aeh.target_mean` with:

```sql
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
```

2. Add two LEFT JOINs right after the `analyst_estimates_history aeh` join block (immediately before `WHERE so.outcome IN ('WIN','LOSS')`):

```sql
        -- AS-OF Altman Z Score (financial distress indicator; > 2.99 safe, < 1.23 distress)
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = so.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score'
                    AND p2.date <= so.signal_date
              )
        -- AS-OF Ohlson O-Score (log-odds of failure; negative = safer)
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = so.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score'
                    AND p2.date <= so.signal_date
              )
```

If the score_type strings from Step 1 differ, substitute them here.

---

- [ ] **Step 7: Add AS-OF joins to load_pending_signals**

In `src/server/ml_ensemble.py`, in `load_pending_signals()`:

1. In the SELECT list, replace `aeh.n_analysts, aeh.buy_count, aeh.target_mean` with:

```sql
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
```

2. Add two LEFT JOINs immediately before `WHERE ts.win_probability IS NULL`:

```sql
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = ts.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score'
                    AND p2.date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = ts.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score'
                    AND p2.date <= ts.date
              )
```

---

- [ ] **Step 8: Add no-leakage guard test for the SQL**

Add to `TestLoadTrainingDataNoLeakColumns` in `src/server/tests/test_ml_ensemble.py`:

```python
    def test_vitals_query_uses_as_of_join(self):
        import inspect
        src = inspect.getsource(load_training_data)
        assert 'proprietary_scores_history' in src
        assert 'psh_az.date <= so.signal_date' in src, "Altman Z join must be AS-OF (no look-ahead)"
        assert 'psh_oo.date <= so.signal_date' in src, "Ohlson O join must be AS-OF (no look-ahead)"
```

- [ ] **Step 9: Run full test suite**

```bash
python -m pytest src/server/tests/test_ml_ensemble.py -v
```
Expected: all existing tests + 6 new tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/server/ml_ensemble.py src/server/tests/test_ml_ensemble.py
git commit -m "feat(ml): add MC Vitals AS-OF features (altman_z, ohlson_o, altman_distress) to ensemble"
```

---

### Task 2: Insider Features Engine

**Files:**
- Create: `src/server/insider_features.py`
- Create: `src/server/tests/test_insider_features.py`
- Modify: `src/server/db.ts` — add `migrateColumn` for `insider_buy_pct_90d`
- Modify: `db/schema.postgres.sql` — add column to `technical_signals`
- Modify: `src/server/ml_ensemble.py` — add `ts.insider_buy_pct_90d` to SELECT + `build_features`
- Modify: `src/server/queues.ts` — wire engine after `relative_strength.py`

**Interfaces:**
- Consumes: `insider_trades(symbol TEXT, typeOfTransaction TEXT, quantity BIGINT, date TEXT)` — written by `moneycontrol_fetcher.py._parse_insider` daily for 150-stock batch
- Produces: `technical_signals.insider_buy_pct_90d REAL` ∈ [0, 1]; 0.5 = no activity (neutral), > 0.5 = net buying, < 0.5 = net selling

---

- [ ] **Step 1: Write failing tests**

Create `src/server/tests/test_insider_features.py`:

```python
import sys
import os
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.insider_features import compute_insider_features, BUY_TYPES, SELL_TYPES


def _trades(*rows):
    return pd.DataFrame(rows)


class TestComputeInsiderFeatures:
    def test_empty_returns_empty_df(self, monkeypatch):
        monkeypatch.setattr(
            'src.server.insider_features.read_df',
            lambda sql, params=(): pd.DataFrame(columns=['symbol', 'typeOfTransaction', 'quantity']),
        )
        result = compute_insider_features('2026-06-22')
        assert result.empty

    def test_pure_buy_gives_near_one(self, monkeypatch):
        data = _trades(
            {'symbol': 'INFY', 'typeOfTransaction': 'BUY', 'quantity': 1000},
            {'symbol': 'INFY', 'typeOfTransaction': 'BUY', 'quantity': 500},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'INFY']['insider_buy_pct_90d'].iloc[0]
        assert val > 0.9

    def test_pure_sell_gives_near_zero(self, monkeypatch):
        data = _trades({'symbol': 'TCS', 'typeOfTransaction': 'SELL', 'quantity': 2000})
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'TCS']['insider_buy_pct_90d'].iloc[0]
        assert val < 0.1

    def test_mixed_trades_between_zero_and_one(self, monkeypatch):
        data = _trades(
            {'symbol': 'HDFC', 'typeOfTransaction': 'BUY',  'quantity': 1000},
            {'symbol': 'HDFC', 'typeOfTransaction': 'SELL', 'quantity': 1000},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'HDFC']['insider_buy_pct_90d'].iloc[0]
        assert 0.0 < val < 1.0

    def test_output_bounded_zero_to_one(self, monkeypatch):
        data = _trades({'symbol': 'SYM', 'typeOfTransaction': 'BUY', 'quantity': 999_999})
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result['insider_buy_pct_90d'].iloc[0]
        assert 0.0 <= val <= 1.0

    def test_case_insensitive_transaction_type(self, monkeypatch):
        data = _trades(
            {'symbol': 'WIPRO', 'typeOfTransaction': 'buy',  'quantity': 500},
            {'symbol': 'WIPRO', 'typeOfTransaction': 'Sell', 'quantity': 100},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'WIPRO']['insider_buy_pct_90d'].iloc[0]
        assert val > 0.5  # net buying

    def test_unknown_transaction_type_ignored(self, monkeypatch):
        """Rows with unrecognised typeOfTransaction should not count as buy or sell."""
        data = _trades(
            {'symbol': 'AXISBANK', 'typeOfTransaction': 'TRANSMISSION', 'quantity': 9999},
            {'symbol': 'AXISBANK', 'typeOfTransaction': 'BUY',          'quantity': 100},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'AXISBANK']['insider_buy_pct_90d'].iloc[0]
        assert val > 0.9  # only BUY counted — TRANSMISSION is ignored

    def test_result_columns(self, monkeypatch):
        data = _trades({'symbol': 'X', 'typeOfTransaction': 'BUY', 'quantity': 1})
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        assert list(result.columns) == ['symbol', 'insider_buy_pct_90d']
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest src/server/tests/test_insider_features.py -v
```
Expected: ImportError — `insider_features.py` does not exist yet.

---

- [ ] **Step 3: Create src/server/insider_features.py**

```python
"""
Insider Features Engine
========================
Computes rolling 90-day net insider activity per symbol from insider_trades and
writes insider_buy_pct_90d to the most-recent technical_signals row per symbol.

insider_buy_pct_90d in [0, 1]:
  > 0.5  net buying  (promoters/directors accumulating — strong India-specific signal)
  < 0.5  net selling (distribution)
  = 0.5  no activity (neutral default — stocks not in 150-stock MC batch)

Run: python insider_features.py
"""

import sys
import os
import datetime

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from db_compat import connect, read_df, executemany

WINDOW_DAYS = 90
BUY_TYPES   = {'BUY', 'ACQUISITION', 'PURCHASE', 'ACQUIRE'}
SELL_TYPES  = {'SELL', 'DISPOSAL', 'SALE'}


def compute_insider_features(cutoff_date: str) -> pd.DataFrame:
    """
    Returns DataFrame(symbol, insider_buy_pct_90d) for symbols with insider
    activity in the 90-day window ending at cutoff_date (YYYY-MM-DD, inclusive).
    """
    window_start = (
        datetime.date.fromisoformat(cutoff_date) - datetime.timedelta(days=WINDOW_DAYS)
    ).isoformat()

    df = read_df(
        "SELECT symbol, typeOfTransaction, quantity FROM insider_trades "
        "WHERE date >= ? AND date <= ?",
        (window_start, cutoff_date),
    )
    if df.empty:
        return pd.DataFrame(columns=['symbol', 'insider_buy_pct_90d'])

    df['typeOfTransaction'] = df['typeOfTransaction'].str.upper().str.strip()
    df['quantity'] = pd.to_numeric(df['quantity'], errors='coerce').fillna(0.0).clip(lower=0)

    df['buy_qty']  = np.where(df['typeOfTransaction'].isin(BUY_TYPES),  df['quantity'], 0.0)
    df['sell_qty'] = np.where(df['typeOfTransaction'].isin(SELL_TYPES), df['quantity'], 0.0)

    agg = df.groupby('symbol')[['buy_qty', 'sell_qty']].sum().reset_index()
    # +1 in denominator prevents 0/0 for rows with only unknown transaction types
    agg['insider_buy_pct_90d'] = (
        agg['buy_qty'] / (agg['buy_qty'] + agg['sell_qty'] + 1.0)
    ).clip(0.0, 1.0)

    return agg[['symbol', 'insider_buy_pct_90d']]


def run():
    conn = connect()
    try:
        today = datetime.date.today().isoformat()
        features = compute_insider_features(today)
        if features.empty:
            print("[Insider Features] No insider data in the last 90 days — skipping.")
            return

        rows = [
            (float(r['insider_buy_pct_90d']), r['symbol'], r['symbol'])
            for _, r in features.iterrows()
        ]
        executemany(
            "UPDATE technical_signals SET insider_buy_pct_90d = ? "
            "WHERE symbol = ? "
            "  AND date = (SELECT MAX(ts2.date) FROM technical_signals ts2 WHERE ts2.symbol = ?)",
            rows,
        )
        print(f"[Insider Features] Updated {len(rows)} symbols with insider_buy_pct_90d")
    finally:
        conn.close()


if __name__ == "__main__":
    run()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest src/server/tests/test_insider_features.py -v
```
Expected: 8 PASS.

---

- [ ] **Step 5: Add insider_buy_pct_90d column to technical_signals**

In `src/server/db.ts`, after the `rs_rank_63d` migrateColumn line (around line 1357), add:

```typescript
// Insider activity (computed by insider_features.py from insider_trades rolling 90d)
migrateColumn('technical_signals', 'insider_buy_pct_90d', 'REAL');
```

In `db/schema.postgres.sql`, inside the `CREATE TABLE technical_signals` block after `"rs_rank_63d" DOUBLE PRECISION,`, add:

```sql
  "insider_buy_pct_90d" DOUBLE PRECISION,
```

Apply to live PG immediately:

```bash
docker exec -i bharat_timescaledb psql -U bharat -d bharat_intel -c \
  "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS insider_buy_pct_90d DOUBLE PRECISION;"
```

---

- [ ] **Step 6: Add ts.insider_buy_pct_90d to ml_ensemble.py SELECT lists**

In `src/server/ml_ensemble.py`, in **both** `load_training_data()` and `load_pending_signals()`, add `ts.insider_buy_pct_90d,` to the ts.* column list immediately after `ts.rs_rank_63d,`:

```sql
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
```

---

- [ ] **Step 7: Add insider features to build_features**

In `src/server/ml_ensemble.py`, in `build_features()`, add after the analyst consensus block:

```python
    # ── Insider activity (from insider_features.py → technical_signals) ──
    # > 0.5 = promoters/directors accumulating (strong India signal: insider buying rarely occurs
    # without conviction). Neutral 0.5 = no data; never penalises uncovered stocks.
    X['insider_buy_pct_90d'] = num('insider_buy_pct_90d', 0.5).clip(0, 1)
    X['insider_x_score']     = X['insider_buy_pct_90d'] * X['signal_score']
```

---

- [ ] **Step 8: Add ml_ensemble tests for insider features**

Add to `src/server/tests/test_ml_ensemble.py`:

```python
class TestInsiderActivityFeatures:
    def test_insider_features_present(self):
        X = build_features(_make_feature_df())
        assert 'insider_buy_pct_90d' in X.columns
        assert 'insider_x_score' in X.columns

    def test_missing_insider_falls_back_to_neutral(self):
        X = build_features(_make_feature_df())
        assert (X['insider_buy_pct_90d'] == 0.5).all()

    def test_insider_values_pass_through(self):
        df = _make_feature_df(n=2)
        df['insider_buy_pct_90d'] = [0.9, 0.1]
        X = build_features(df)
        assert X['insider_buy_pct_90d'].iloc[0] == pytest.approx(0.9, abs=0.01)
        assert X['insider_buy_pct_90d'].iloc[1] == pytest.approx(0.1, abs=0.01)
```

- [ ] **Step 9: Run full test suite**

```bash
python -m pytest src/server/tests/test_ml_ensemble.py src/server/tests/test_insider_features.py -v
```
Expected: all tests PASS.

- [ ] **Step 10: Wire insider_features.py into processMlDailyOps**

In `src/server/queues.ts`, in `processMlDailyOps`, add after the `relative_strength.py` runPython call (after line 408):

```typescript
  // Rolling 90d insider buy/sell ratio from insider_trades → technical_signals.insider_buy_pct_90d.
  await runPython('insider_features.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] insider_features failed:', (e as Error).message));
```

- [ ] **Step 11: Commit**

```bash
git add src/server/insider_features.py src/server/tests/test_insider_features.py \
        src/server/db.ts db/schema.postgres.sql \
        src/server/ml_ensemble.py src/server/queues.ts
git commit -m "feat(ml): add insider activity engine (insider_buy_pct_90d + interaction) to ensemble"
```

---

### Task 3: Intraday Features Engine

**Files:**
- Create: `src/server/intraday_features.py`
- Create: `src/server/tests/test_intraday_features.py`
- Modify: `src/server/db.ts` — 3 new `migrateColumn` calls
- Modify: `db/schema.postgres.sql` — 3 new columns in `technical_signals`
- Modify: `src/server/ml_ensemble.py` — add 3 cols to SELECT + `build_features`
- Modify: `src/server/queues.ts` — wire after `insider_features.py`

**Interfaces:**
- Consumes: `intraday_ohlcv(symbol TEXT, datetime TIMESTAMPTZ, open, high, low, close, volume REAL, vwap REAL, interval TEXT)` — written by `intraday_fetcher.py` every 30 min during market hours
- Produces:
  - `technical_signals.opening_range_break REAL` — 1.0 = broke above first-30m high, -1.0 = broke below first-30m low, 0.0 = inside range or insufficient data
  - `technical_signals.vwap_deviation_pct REAL` — `(last_close − session_vwap) / session_vwap × 100`; positive = above VWAP (institutional demand)
  - `technical_signals.first_hour_vol_share REAL` — first-hour volume / total session volume ∈ [0, 1]; high = front-loaded (institutional activity at open)

---

- [ ] **Step 1: Write failing tests**

Create `src/server/tests/test_intraday_features.py`:

```python
import sys
import os
import datetime
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.intraday_features import compute_intraday_features

_IST  = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
_DATE = '2026-06-22'
_COLS = ['symbol', 'datetime', 'open', 'high', 'low', 'close', 'volume', 'vwap', 'interval']


def _bar(sym, hour, minute, open_, high, low, close, vol, vwap):
    dt = datetime.datetime(2026, 6, 22, hour, minute, tzinfo=_IST).isoformat()
    return {'symbol': sym, 'datetime': dt, 'open': open_,
            'high': high, 'low': low, 'close': close,
            'volume': vol, 'vwap': vwap, 'interval': '15m'}


def _session(sym, *, or_high=105.0, or_low=95.0, last_close=100.0):
    """25 bars covering a full NSE session (9:15–15:30 IST). First 2 bars set the
    opening range. Last bar has the given last_close."""
    times = [
        (9,15),(9,30),(9,45),(10,0),(10,15),(10,30),(10,45),
        (11,0),(11,15),(11,30),(11,45),(12,0),(12,15),(12,30),
        (12,45),(13,0),(13,15),(13,30),(13,45),(14,0),(14,15),
        (14,30),(14,45),(15,0),(15,15),
    ]
    bars = []
    for i, (h, m) in enumerate(times):
        close = last_close if i == len(times) - 1 else 100.0
        hi = or_high if i < 2 else 102.0
        lo = or_low  if i < 2 else 98.0
        bars.append(_bar(sym, h, m, 100.0, hi, lo, close, 10_000 if i < 4 else 5_000, 100.0))
    return bars


class TestOpeningRangeBreak:
    def test_breakout_above_gives_plus_one(self, monkeypatch):
        bars = pd.DataFrame(_session('INFY', or_high=105.0, or_low=95.0, last_close=107.0))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        orb = result[result['symbol'] == 'INFY']['opening_range_break'].iloc[0]
        assert orb == 1.0

    def test_breakout_below_gives_minus_one(self, monkeypatch):
        bars = pd.DataFrame(_session('TCS', or_high=105.0, or_low=95.0, last_close=93.0))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        orb = result[result['symbol'] == 'TCS']['opening_range_break'].iloc[0]
        assert orb == -1.0

    def test_inside_day_gives_zero(self, monkeypatch):
        bars = pd.DataFrame(_session('HDFC', or_high=105.0, or_low=95.0, last_close=100.0))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        orb = result[result['symbol'] == 'HDFC']['opening_range_break'].iloc[0]
        assert orb == 0.0


class TestVwapDeviation:
    def test_close_above_vwap_is_positive(self, monkeypatch):
        bars = pd.DataFrame([_bar('SYM', 9, 15, 100, 105, 95, 110, 10_000, 100.0)])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        dev = result[result['symbol'] == 'SYM']['vwap_deviation_pct'].iloc[0]
        assert dev > 0.0

    def test_close_below_vwap_is_negative(self, monkeypatch):
        bars = pd.DataFrame([_bar('SYM2', 9, 15, 100, 105, 95, 90, 10_000, 100.0)])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        dev = result[result['symbol'] == 'SYM2']['vwap_deviation_pct'].iloc[0]
        assert dev < 0.0


class TestFirstHourVolShare:
    def test_front_loaded_volume_gives_high_share(self, monkeypatch):
        df = pd.DataFrame(_session('VOLSYM'))
        df['volume'] = [100_000] * 4 + [1] * 21
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): df)
        result = compute_intraday_features(_DATE)
        share = result[result['symbol'] == 'VOLSYM']['first_hour_vol_share'].iloc[0]
        assert share > 0.9

    def test_uniform_volume_gives_four_twenty_fifths(self, monkeypatch):
        df = pd.DataFrame(_session('UNIFORM'))
        df['volume'] = 1.0
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): df)
        result = compute_intraday_features(_DATE)
        share = result[result['symbol'] == 'UNIFORM']['first_hour_vol_share'].iloc[0]
        assert abs(share - 4 / 25) < 0.05

    def test_empty_data_returns_empty(self, monkeypatch):
        monkeypatch.setattr(
            'src.server.intraday_features.read_df',
            lambda sql, params=(): pd.DataFrame(columns=_COLS),
        )
        result = compute_intraday_features(_DATE)
        assert result.empty

    def test_output_columns(self, monkeypatch):
        df = pd.DataFrame([_bar('A', 9, 15, 100, 105, 95, 100, 1000, 100.0)])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): df)
        result = compute_intraday_features(_DATE)
        for col in ['symbol', 'opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share']:
            assert col in result.columns
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
python -m pytest src/server/tests/test_intraday_features.py -v
```
Expected: ImportError — `intraday_features.py` does not exist yet.

---

- [ ] **Step 3: Create src/server/intraday_features.py**

```python
"""
Intraday Features Engine
=========================
Computes three microstructure features from 15-minute bars (intraday_ohlcv) for
today's session and writes them to technical_signals (most recent row per symbol).

Features:
  opening_range_break    1.0 = broke above first-30m high; -1.0 = below low; 0.0 = inside
  vwap_deviation_pct     (last_close - session_vwap) / session_vwap * 100
  first_hour_vol_share   first-hour volume / total session volume (0-1)

Run: python intraday_features.py
     python intraday_features.py --date 2026-06-21
"""

import sys
import os
import argparse
import datetime

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from db_compat import connect, read_df, executemany

_IST        = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
FIRST_BARS  = 2   # opening range = first 2 x 15m bars (30 minutes)
FIRST_HOUR  = 4   # first-hour volume window = first 4 x 15m bars


def compute_intraday_features(date_str: str) -> pd.DataFrame:
    """
    Returns DataFrame(symbol, opening_range_break, vwap_deviation_pct, first_hour_vol_share)
    for symbols with at least FIRST_BARS 15m bars on `date_str` (YYYY-MM-DD IST).
    """
    d = datetime.date.fromisoformat(date_str)
    # IST-aware ISO strings work on both SQLite (text compare) and PG (timestamptz compare)
    session_start = datetime.datetime(d.year, d.month, d.day, 9, 10, tzinfo=_IST).isoformat()
    session_end   = datetime.datetime(d.year, d.month, d.day, 15, 50, tzinfo=_IST).isoformat()

    df = read_df(
        "SELECT symbol, datetime, high, low, close, volume, vwap "
        "FROM intraday_ohlcv "
        "WHERE datetime >= ? AND datetime <= ? AND interval = '15m' "
        "ORDER BY symbol, datetime",
        (session_start, session_end),
    )
    if df.empty:
        return pd.DataFrame(columns=[
            'symbol', 'opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share',
        ])

    for col in ('volume', 'close', 'high', 'low', 'vwap'):
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df['volume'] = df['volume'].fillna(0.0)

    results = []
    for symbol, grp in df.groupby('symbol'):
        grp = grp.sort_values('datetime').reset_index(drop=True)
        if len(grp) < FIRST_BARS:
            continue

        # ── Opening Range Break ──────────────────────────────────────────────
        or_high    = grp.iloc[:FIRST_BARS]['high'].max()
        or_low     = grp.iloc[:FIRST_BARS]['low'].min()
        last_close = grp.iloc[-1]['close']

        if pd.isna(last_close) or pd.isna(or_high) or pd.isna(or_low):
            orb = 0.0
        elif last_close > or_high:
            orb = 1.0
        elif last_close < or_low:
            orb = -1.0
        else:
            orb = 0.0

        # ── VWAP Deviation ──────────────────────────────────────────────────
        valid_vwap = grp['vwap'].dropna()
        if len(valid_vwap) > 0 and not pd.isna(last_close):
            session_vwap = float(valid_vwap.iloc[-1])
            vwap_dev = (last_close - session_vwap) / session_vwap * 100 if session_vwap != 0 else 0.0
        else:
            vwap_dev = 0.0

        # ── First-Hour Volume Share ─────────────────────────────────────────
        total_vol = float(grp['volume'].sum())
        first_vol = float(grp.iloc[:FIRST_HOUR]['volume'].sum())
        vol_share = (first_vol / total_vol) if total_vol > 0 else 0.5
        vol_share = min(max(vol_share, 0.0), 1.0)

        results.append({
            'symbol':               symbol,
            'opening_range_break':  orb,
            'vwap_deviation_pct':   round(float(vwap_dev), 4),
            'first_hour_vol_share': round(vol_share, 4),
        })

    return pd.DataFrame(results)


def run(date_str: str | None = None):
    if date_str is None:
        date_str = datetime.datetime.now(tz=_IST).date().isoformat()

    features = compute_intraday_features(date_str)
    if features.empty:
        print(f"[Intraday Features] No intraday data for {date_str} — skipping.")
        return

    rows = [
        (
            float(r['opening_range_break']),
            float(r['vwap_deviation_pct']),
            float(r['first_hour_vol_share']),
            r['symbol'],
            r['symbol'],
        )
        for _, r in features.iterrows()
    ]
    executemany(
        "UPDATE technical_signals "
        "SET opening_range_break = ?, vwap_deviation_pct = ?, first_hour_vol_share = ? "
        "WHERE symbol = ? "
        "  AND date = (SELECT MAX(ts2.date) FROM technical_signals ts2 WHERE ts2.symbol = ?)",
        rows,
    )
    print(f"[Intraday Features] Updated {len(rows)} symbols for session {date_str}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default=None, help='YYYY-MM-DD IST (default: today IST)')
    args = parser.parse_args()
    run(args.date)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
python -m pytest src/server/tests/test_intraday_features.py -v
```
Expected: 9 PASS.

---

- [ ] **Step 5: Add 3 new columns to technical_signals**

In `src/server/db.ts`, after the `insider_buy_pct_90d` migrateColumn from Task 2, add:

```typescript
// Intraday microstructure features (computed by intraday_features.py from intraday_ohlcv)
migrateColumn('technical_signals', 'opening_range_break',  'REAL');
migrateColumn('technical_signals', 'vwap_deviation_pct',   'REAL');
migrateColumn('technical_signals', 'first_hour_vol_share', 'REAL');
```

In `db/schema.postgres.sql`, inside the `CREATE TABLE technical_signals` block, after `"insider_buy_pct_90d" DOUBLE PRECISION,`, add:

```sql
  "opening_range_break" DOUBLE PRECISION,
  "vwap_deviation_pct" DOUBLE PRECISION,
  "first_hour_vol_share" DOUBLE PRECISION,
```

Apply to live PG immediately:

```bash
docker exec -i bharat_timescaledb psql -U bharat -d bharat_intel -c "
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS opening_range_break  DOUBLE PRECISION;
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS vwap_deviation_pct   DOUBLE PRECISION;
ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS first_hour_vol_share DOUBLE PRECISION;
"
```

---

- [ ] **Step 6: Add 3 columns to ml_ensemble.py SELECT lists**

In `src/server/ml_ensemble.py`, in **both** `load_training_data()` and `load_pending_signals()`, add these 3 lines immediately after `ts.insider_buy_pct_90d,`:

```sql
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
```

---

- [ ] **Step 7: Add intraday features to build_features**

In `src/server/ml_ensemble.py`, in `build_features()`, add after the insider block:

```python
    # ── Intraday microstructure (from intraday_features.py → technical_signals) ──
    # opening_range_break: trend direction relative to first 30-min range.
    # 1.0 = upside breakout; -1.0 = breakdown; 0.0 = no data or inside range.
    X['opening_range_break']  = num('opening_range_break',  0.0).clip(-1, 1)
    # vwap_deviation_pct: close vs session VWAP. Positive = institutional demand bid.
    X['vwap_deviation_pct']   = num('vwap_deviation_pct',   0.0).clip(-10, 10)
    # first_hour_vol_share: front-loaded volume (institutional activity at the open).
    X['first_hour_vol_share'] = num('first_hour_vol_share', 0.5).clip(0, 1)
```

---

- [ ] **Step 8: Add ml_ensemble tests for intraday features**

Add to `src/server/tests/test_ml_ensemble.py`:

```python
class TestIntradayMicrostructureFeatures:
    def test_intraday_features_present(self):
        X = build_features(_make_feature_df())
        for col in ['opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share']:
            assert col in X.columns

    def test_missing_intraday_falls_back_to_neutral(self):
        X = build_features(_make_feature_df())
        assert (X['opening_range_break'] == 0.0).all()
        assert (X['vwap_deviation_pct']  == 0.0).all()
        assert (X['first_hour_vol_share'] == 0.5).all()

    def test_intraday_values_pass_through(self):
        df = _make_feature_df(n=3)
        df['opening_range_break']  = [1.0, -1.0, 0.0]
        df['vwap_deviation_pct']   = [3.5, -2.1, 0.0]
        df['first_hour_vol_share'] = [0.8,  0.2, 0.5]
        X = build_features(df)
        assert X['opening_range_break'].iloc[0]  == pytest.approx(1.0,  abs=0.01)
        assert X['vwap_deviation_pct'].iloc[1]   == pytest.approx(-2.1, abs=0.01)
        assert X['first_hour_vol_share'].iloc[2] == pytest.approx(0.5,  abs=0.01)
```

- [ ] **Step 9: Run full test suite**

```bash
python -m pytest src/server/tests/test_ml_ensemble.py src/server/tests/test_insider_features.py src/server/tests/test_intraday_features.py -v
```
Expected: all tests PASS (no regressions).

- [ ] **Step 10: Wire intraday_features.py into processMlDailyOps**

In `src/server/queues.ts`, in `processMlDailyOps`, add after the `insider_features.py` call:

```typescript
  // Intraday microstructure: opening-range break, VWAP deviation, first-hour vol share.
  // Runs post-close so the full session (9:15–15:30 IST) is in intraday_ohlcv.
  await runPython('intraday_features.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] intraday_features failed:', (e as Error).message));
```

- [ ] **Step 11: Commit**

```bash
git add src/server/intraday_features.py src/server/tests/test_intraday_features.py \
        src/server/db.ts db/schema.postgres.sql \
        src/server/ml_ensemble.py src/server/queues.ts
git commit -m "feat(ml): add intraday microstructure features (ORB, VWAP dev, first-hour vol) to ensemble"
```

---

### Task 4: Retrain and Verify

- [ ] **Step 1: Run full Python test suite — confirm no regressions**

```bash
python -m pytest src/server/tests/ -v --tb=short 2>&1 | tail -40
```
Expected: all tests PASS including the 3 pre-existing test failures documented in memory (test_feature_engineering_batch TestBatchWrites — pre-existing, unrelated to this plan).

- [ ] **Step 2: Retrain the ensemble**

```bash
cd d:\Github\bharat-stock-intelligence
backend-python\venv\Scripts\python src\server\ml_ensemble.py --train
```

Expected output lines include:
```
[Ensemble] Training on N samples  (win_rate=...)
[Ensemble]   HELD-OUT TEST (last N, embargo=N): AUC=0.XXXX ...
[Ensemble] Registered as model_id=N
```

Note: Altman Z / Ohlson O / insider features will be near-neutral (NULL→default) for most training rows until `moneycontrol_fetcher.py` has run for several days. Intraday features similarly neutral until `intraday_features.py` accumulates data. The model will not degrade — neutral defaults are correctly uninformative. Real lift materialises after ~30 days of daily data accumulation.

- [ ] **Step 3: Verify new features appear in model registry**

```bash
docker exec -i bharat_timescaledb psql -U bharat -d bharat_intel -c \
  "SELECT feature_name, importance, rank_position FROM feature_importance_log \
   WHERE model_id=(SELECT MAX(id) FROM model_registry) \
   ORDER BY rank_position LIMIT 20;"
```

Confirm `altman_z`, `altman_distress`, `ohlson_o`, `insider_buy_pct_90d`, `insider_x_score`, `opening_range_break`, `vwap_deviation_pct`, `first_hour_vol_share` appear (low importance initially is expected).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(ml): retrain ensemble with vitals + insider + intraday features (model_id incremented in DB)"
```

---

## Self-Review

**Spec coverage:**
- ✅ MC Vitals AS-OF features (altman_z, ohlson_o, altman_distress) — Task 1
- ✅ No-leakage guard test on SQL AS-OF join — Task 1 Step 8
- ✅ Insider activity engine + interaction feature — Task 2
- ✅ Intraday microstructure engine (ORB, VWAP, vol share) — Task 3
- ✅ All new columns in `db.ts` migrateColumn + `schema.postgres.sql` + live PG ALTER — Tasks 2 & 3
- ✅ All 3 engines wired to `processMlDailyOps` cron — Tasks 2 & 3
- ✅ All features use `num()` neutral-fallback pattern (no NaN leakage) — Tasks 1–3
- ✅ TDD: failing test written before implementation in every task
- ✅ Retrain after all tasks — Task 4

**Type consistency:** `compute_insider_features` → `insider_buy_pct_90d`; `compute_intraday_features` → `opening_range_break / vwap_deviation_pct / first_hour_vol_share`. All names match across engine, test, ml_ensemble SELECT, and build_features.
