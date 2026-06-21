# Regime-Conditional Calibration — Implementation Plan (Phase 1 + Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill clean, multi-episode regime history over our 2.2 years of OHLCV, and ship a per-regime win-probability calibration mechanism that stays dormant (global fallback) until each regime has enough independent history.

**Architecture:** Phase 1 backfills the market-level inputs (`market_breadth`, macro, FII/DII from TradeBrains) over the 550-day window, repoints the regime detector's advance/decline feature to our own breadth, and rebuilds `market_regimes`. Phase 3 extends `ml_calibration.py` to fit a separate isotonic calibrator per `nifty_regime` — gated on a distinct-days/episode floor so it falls back to the existing global calibrator until real history accrues — plus per-regime AUC + readiness diagnostics, and switches the scoring gate to the calibrated probability.

**Tech Stack:** Python 3.11 (`backend-python/venv/Scripts/python.exe` — has lightgbm/sklearn), `db_compat` data layer (SQLite ↔ Postgres), pytest, sklearn IsotonicRegression, hmmlearn. Spec: `docs/superpowers/specs/2026-06-21-regime-conditional-calibration-design.md`.

## Global Constraints

- Test interpreter: `backend-python/venv/Scripts/python.exe -m pytest <path> -p no:cacheprovider`.
- Live-PG runs: prefix env `USE_POSTGRES=true PYTHONIOENCODING=utf-8`; container `bharat_timescaledb`, db `bharat_intel`, creds bharat/bharat, port 5433.
- Postgres portability (apply verbatim): `technical_signals.date` is TEXT, `stock_ohlcv.date`/`macro_asset_prices.date` are DATE → str-normalize any DATE value to `'YYYY-MM-DD'` before binding it against a TEXT column. `market_breadth.date` is TEXT. Quote camelCase columns. `INSERT OR REPLACE`→explicit `ON CONFLICT`.
- New engine files use `from db_compat import ...` and the positional-param tuple convention; never `import sqlite3` for app data.
- TDD: write the failing test, watch it fail, minimal implementation, watch it pass, commit. One logical change per commit.

---

## File Structure

- **Create** `src/server/fii_dii_backfill.py` — one-time TradeBrains FII/DII history loader → `fii_dii_flow`. Pure `parse_tradebrains_rows(fii_json_results, dii_json_results)` + an I/O `run()` that pages the API.
- **Create** `src/server/tests/test_fii_dii_backfill.py` — covers the pure parse/map.
- **Modify** `src/server/regime_detector.py` — repoint the advance/decline feature to `market_breadth`; add `backfill_regimes(start_date, end_date)`.
- **Modify** `src/server/tests/test_regime_detector.py` — advance/decline now sourced from `market_breadth`.
- **Modify** `src/server/ml_calibration.py` — `count_episodes`, per-regime calibration in `recalibrate_win_probabilities`, `per_regime_auc`, `regime_readiness`.
- **Modify** `src/server/tests/test_ml_calibration.py` — per-regime + floor + diagnostics tests.
- **Modify** `src/server/scoring_engine.py:490` — gate reads `COALESCE(calibrated_win_probability, win_probability)`.
- **Modify** `src/server/queues.ts` — Phase-1 backfill is a one-time manual run (runbook in Task 3), not a cron; no queues change for Phase 1/3 (calibration cron already wired).

---

# PHASE 1 — Historical backfill (clean, leak-free)

### Task 1: TradeBrains FII/DII history backfill

**Files:**
- Create: `src/server/fii_dii_backfill.py`
- Test: `src/server/tests/test_fii_dii_backfill.py`

**Interfaces:**
- Produces: `parse_tradebrains_rows(fii_results: list[dict], dii_results: list[dict]) -> list[dict]` — each output row `{date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net}` with `date` normalized to `'YYYY-MM-DD'`, merged by date (FII + DII for the same date in one row). `run() -> int` pages both endpoints and upserts `fii_dii_flow`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

```python
# src/server/tests/test_fii_dii_backfill.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from fii_dii_backfill import parse_tradebrains_rows


def test_maps_and_merges_fii_dii_by_date():
    fii = [{"date": "18-06-2026", "equity_gross_purchase": 13328.7, "equity_gross_sales": 15135.29,
            "equity_net_investment": -1806.59}]
    dii = [{"date": "18-06-2026", "buy_value": 16163.18, "sell_value": 12646.37, "net_value": 3516.81}]
    rows = parse_tradebrains_rows(fii, dii)
    assert len(rows) == 1
    r = rows[0]
    assert r["date"] == "2026-06-18"          # DD-MM-YYYY -> YYYY-MM-DD
    assert r["fii_net"] == -1806.59 and r["fii_buy"] == 13328.7 and r["fii_sell"] == 15135.29
    assert r["dii_net"] == 3516.81 and r["dii_buy"] == 16163.18 and r["dii_sell"] == 12646.37


def test_dii_only_date_still_emitted_with_null_fii():
    rows = parse_tradebrains_rows([], [{"date": "01-11-2023", "buy_value": 100.0, "sell_value": 90.0, "net_value": 10.0}])
    assert len(rows) == 1
    assert rows[0]["date"] == "2023-11-01" and rows[0]["dii_net"] == 10.0 and rows[0]["fii_net"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_fii_dii_backfill.py -v -p no:cacheprovider`
Expected: FAIL — `ModuleNotFoundError: No module named 'fii_dii_backfill'`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/server/fii_dii_backfill.py
"""One-time historical FII/DII backfill from the TradeBrains portal into fii_dii_flow.
FII endpoint field equity_net_investment -> fii_net; DII net_value -> dii_net. Published EOD
data (point-in-time). Run once: python fii_dii_backfill.py"""
import time
import requests
from db_compat import connect

_FII_URL = "https://portal.tradebrains.in/api/prices/investments/fii-investments/"
_DII_URL = "https://portal.tradebrains.in/api/prices/investments/dii-investments/"
_HEADERS = {"User-Agent": "Mozilla/5.0"}


def _to_iso(d: str) -> str:
    dd, mm, yyyy = d.split("-")
    return f"{yyyy}-{mm}-{dd}"


def parse_tradebrains_rows(fii_results: list[dict], dii_results: list[dict]) -> list[dict]:
    by_date: dict[str, dict] = {}
    for r in fii_results:
        iso = _to_iso(r["date"])
        row = by_date.setdefault(iso, {"date": iso, "fii_buy": None, "fii_sell": None, "fii_net": None,
                                       "dii_buy": None, "dii_sell": None, "dii_net": None})
        row["fii_buy"], row["fii_sell"], row["fii_net"] = (
            r.get("equity_gross_purchase"), r.get("equity_gross_sales"), r.get("equity_net_investment"))
    for r in dii_results:
        iso = _to_iso(r["date"])
        row = by_date.setdefault(iso, {"date": iso, "fii_buy": None, "fii_sell": None, "fii_net": None,
                                       "dii_buy": None, "dii_sell": None, "dii_net": None})
        row["dii_buy"], row["dii_sell"], row["dii_net"] = (
            r.get("buy_value"), r.get("sell_value"), r.get("net_value"))
    return list(by_date.values())


def _fetch_all(url: str) -> list[dict]:
    out, page = [], 1
    while True:
        resp = requests.get(url, params={"page": page, "per_page": 100}, headers=_HEADERS, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        out.extend(data.get("results", []))
        if not data.get("next"):
            break
        page += 1
        time.sleep(0.3)
    return out


def run() -> int:
    rows = parse_tradebrains_rows(_fetch_all(_FII_URL), _fetch_all(_DII_URL))
    con = connect()
    try:
        n = 0
        for r in rows:
            con.execute(
                """INSERT INTO fii_dii_flow (date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source)
                   VALUES (?,?,?,?,?,?,?, 'tradebrains')
                   ON CONFLICT(date) DO UPDATE SET
                     fii_buy=excluded.fii_buy, fii_sell=excluded.fii_sell, fii_net=excluded.fii_net,
                     dii_buy=excluded.dii_buy, dii_sell=excluded.dii_sell, dii_net=excluded.dii_net,
                     source='tradebrains'""",
                (r["date"], r["fii_buy"], r["fii_sell"], r["fii_net"],
                 r["dii_buy"], r["dii_sell"], r["dii_net"]))
            n += 1
        con.commit()
        print(f"[FII-DII-BACKFILL] upserted {n} dates")
        return n
    finally:
        con.close()


if __name__ == "__main__":
    run()
```

Note: `fii_dii_flow` has a `PRIMARY KEY(date)`-style conflict target on `date` — confirm the live PG/SQLite unique key is `date` (it is the table's natural key); if a composite unique exists, set the `ON CONFLICT` columns to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_fii_dii_backfill.py -v -p no:cacheprovider`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/server/fii_dii_backfill.py src/server/tests/test_fii_dii_backfill.py
git commit -m "feat(data): TradeBrains FII/DII history backfill into fii_dii_flow"
```

---

### Task 2: Repoint regime detector advance/decline to market_breadth

**Files:**
- Modify: `src/server/regime_detector.py:79-88` (the advance/decline block in `_load_hmm_features`)
- Modify: `src/server/tests/test_regime_detector.py` (the `_make_nifty_conn` fixture + the no-look-ahead test already monkeypatch `read_df`; add a `market_breadth` table so the new query resolves)

**Interfaces:**
- Consumes: `market_breadth(date TEXT, adv_decline_ratio REAL)` (already created in Sprint 1).
- Produces: no signature change to `_load_hmm_features`; the `advance_decline_ratio` feature column is now sourced from `market_breadth`.

- [ ] **Step 1: Write the failing test** — extend the existing `TestDateAnchoredFeatures._make_nifty_conn` to create+populate `market_breadth`, and assert the feature is read from it.

```python
# add inside test_regime_detector.py TestDateAnchoredFeatures._make_nifty_conn, after the other CREATE TABLEs:
        conn.execute("CREATE TABLE market_breadth (date TEXT PRIMARY KEY, adv_decline_ratio REAL)")
        for d in dates:
            conn.execute("INSERT INTO market_breadth (date, adv_decline_ratio) VALUES (?,?)", (d, 0.55))
# and a new test:
    def test_advance_decline_sourced_from_market_breadth(self):
        from datetime import date, timedelta
        all_dates = [(date(2024,4,22)+timedelta(days=i)).isoformat() for i in range(50)]
        conn = self._make_nifty_conn(all_dates)
        with patch.object(regime_detector, 'read_df', self._patched_read_df(conn)):
            df = _load_hmm_features(lookback_days=90, as_of_date='2024-06-01')
        assert (df['advance_decline_ratio'] == 0.55).all()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_regime_detector.py::TestDateAnchoredFeatures::test_advance_decline_sourced_from_market_breadth -v -p no:cacheprovider`
Expected: FAIL — the current query reads `market_sentiment_snapshots`, so `advance_decline_ratio` is the default 50.0, not 0.55.

- [ ] **Step 3: Implement** — replace the advance/decline block (lines ~79-88) in `_load_hmm_features`:

```python
    # Advance/decline breadth from our own universe (market_breadth.adv_decline_ratio, 0-1).
    ad = _read_dated(
        "SELECT date, adv_decline_ratio FROM market_breadth WHERE date>=? AND date<=? ORDER BY date",
        (cutoff_s, anchor_s),   # market_breadth.date is TEXT -> string params
    )
    if not ad.empty:
        df["advance_decline_ratio"] = ad["adv_decline_ratio"].reindex(df.index, method="ffill").fillna(0.5)
    else:
        df["advance_decline_ratio"] = 0.5
```

- [ ] **Step 4: Run the test + the full regime test file**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_regime_detector.py -v -p no:cacheprovider`
Expected: PASS (all, including the new test).

- [ ] **Step 5: Commit**

```bash
git add src/server/regime_detector.py src/server/tests/test_regime_detector.py
git commit -m "feat(regime): source advance/decline from market_breadth (backfillable) not sentiment snapshot"
```

---

### Task 3: Run the Phase-1 backfills + add `backfill_regimes` (runbook task)

**Files:**
- Modify: `src/server/regime_detector.py` — add `backfill_regimes(start_date, end_date)` and a `--backfill START END` CLI mode.

**Interfaces:**
- Produces: `backfill_regimes(start_date: str, end_date: str) -> int` — loads features once over `[start_date-260d, end_date]`, runs Viterbi over the whole sequence, upserts `market_regimes` for every date in range; returns rows written. Reuses the trained HMM bundle at `HMM_PATH`.

- [ ] **Step 1: Implement `backfill_regimes`** (vectorized — one Viterbi pass over the full span, not per-date model loads):

```python
def backfill_regimes(start_date: str, end_date: str) -> int:
    """Label every trading day in [start_date, end_date] in one Viterbi pass and upsert market_regimes."""
    import pandas as pd
    if not HMM_PATH.exists():
        print("[HMM] No model — run --mode train first"); return 0
    with open(HMM_PATH, "rb") as f:
        bundle = pickle.load(f)
    model, scaler, state_labels = bundle["model"], bundle["scaler"], bundle["state_labels"]
    df = _load_hmm_features(lookback_days=2000, as_of_date=end_date)
    df = df[df.index >= pd.to_datetime(start_date)]
    if df.empty:
        print("[HMM] no features in range"); return 0
    X = scaler.transform(df.fillna(0))
    states = model.predict(X)
    n = 0
    for ts, st in zip(df.index, states):
        d = ts.strftime("%Y-%m-%d"); regime = state_labels.get(int(st), "SIDEWAYS")
        execute(
            """INSERT INTO market_regimes (date, regime, hmm_state, computed_at)
               VALUES (?,?,?,CURRENT_TIMESTAMP)
               ON CONFLICT(date) DO UPDATE SET regime=excluded.regime, hmm_state=excluded.hmm_state,
                 computed_at=CURRENT_TIMESTAMP""",
            (d, regime, int(st)))
        n += 1
    print(f"[HMM] backfilled {n} regime days {start_date}..{end_date}")
    return n
```

Add to `__main__`: a `--backfill` flag taking two dates (extend the existing argparse `--mode` choices with `"backfill"` and add `--start`/`--end` args).

- [ ] **Step 2: Run the live-PG backfill sequence (one-time)** — record output:

```bash
USE_POSTGRES=true PYTHONIOENCODING=utf-8 backend-python/venv/Scripts/python.exe src/server/fii_dii_backfill.py
USE_POSTGRES=true PYTHONIOENCODING=utf-8 backend-python/venv/Scripts/python.exe src/server/global_macro_fetcher.py 800
USE_POSTGRES=true PYTHONIOENCODING=utf-8 backend-python/venv/Scripts/python.exe src/server/market_breadth.py
USE_POSTGRES=true PYTHONIOENCODING=utf-8 backend-python/venv/Scripts/python.exe src/server/regime_detector.py --mode train
USE_POSTGRES=true PYTHONIOENCODING=utf-8 backend-python/venv/Scripts/python.exe src/server/regime_detector.py --mode backfill --start 2024-04-02 --end 2026-06-19
```

- [ ] **Step 3: Validate** — confirm regime history is now multi-episode:

```bash
docker exec bharat_timescaledb psql -U bharat -d bharat_intel -c "SELECT regime, COUNT(*) days, MIN(date)::text, MAX(date)::text FROM market_regimes GROUP BY regime ORDER BY days DESC;"
```
Expected: regimes now span ~550 days across multiple episodes (not 9 days). Spot-check labels against known 2024-2026 moves.

- [ ] **Step 4: Commit the code (backfilled DATA lives in PG, not git)**

```bash
git add src/server/regime_detector.py
git commit -m "feat(regime): backfill_regimes — one-pass Viterbi over full history into market_regimes"
```

---

# PHASE 3 — Per-regime calibration mechanism (dormant until floor met)

### Task 4: `count_episodes` pure helper

**Files:**
- Modify: `src/server/ml_calibration.py` (add `count_episodes`)
- Modify: `src/server/tests/test_ml_calibration.py`

**Interfaces:**
- Produces: `count_episodes(days: list[str], gap_days: int = 5) -> int` — sorted distinct ISO dates → number of episodes (a gap > `gap_days` calendar days starts a new episode). Empty → 0.

- [ ] **Step 1: Write the failing test**

```python
# append to test_ml_calibration.py
from ml_calibration import count_episodes  # add to the existing import block

def test_count_episodes():
    assert count_episodes([]) == 0
    assert count_episodes(["2024-01-01", "2024-01-02", "2024-01-03"]) == 1
    assert count_episodes(["2024-01-01", "2024-01-02", "2024-02-01", "2024-02-02"]) == 2  # gap > 5
    assert count_episodes(["2024-01-03", "2024-01-01", "2024-01-02"]) == 1                # unsorted ok
```

- [ ] **Step 2: Run to verify it fails**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_ml_calibration.py::test_count_episodes -v -p no:cacheprovider`
Expected: FAIL — `ImportError: cannot import name 'count_episodes'`.

- [ ] **Step 3: Implement**

```python
import datetime as _dt

def count_episodes(days, gap_days: int = 5) -> int:
    uniq = sorted(set(days))
    if not uniq:
        return 0
    episodes = 1
    prev = _dt.date.fromisoformat(uniq[0])
    for d in uniq[1:]:
        cur = _dt.date.fromisoformat(d)
        if (cur - prev).days > gap_days:
            episodes += 1
        prev = cur
    return episodes
```

- [ ] **Step 4: Run to verify it passes**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_ml_calibration.py::test_count_episodes -v -p no:cacheprovider`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/ml_calibration.py src/server/tests/test_ml_calibration.py
git commit -m "feat(calibration): count_episodes helper for the per-regime days/episode floor"
```

---

### Task 5: Per-regime calibration with days/episode floor

**Files:**
- Modify: `src/server/ml_calibration.py` (`recalibrate_win_probabilities`)
- Modify: `src/server/tests/test_ml_calibration.py` (fixture gains `nifty_regime`)

**Interfaces:**
- Consumes: `count_episodes`, `fit_calibrator`, `calibrate`.
- Produces: `recalibrate_win_probabilities(conn, min_samples=200, min_regime_days=20, min_regime_episodes=2) -> dict` — return now includes `regimes: {regime: {n, distinct_days, episodes, used}}` where `used` is `'regime'` or `'global'`. A regime gets its own calibrator only if it clears `min_regime_days` distinct days AND `min_regime_episodes` episodes AND has ≥2 classes; else global.

- [ ] **Step 1: Write the failing tests** — extend `make_db` to add `nifty_regime` to `technical_signals`, then:

```python
# in make_db(): change the technical_signals CREATE to include nifty_regime TEXT
# and the INSERTs in the new tests below set it.

def _seed(conn, regime, p, win_count, dates):
    """Insert len(dates)*? rows: for each date, one signal at prob p with WIN/LOSS by win_count fraction."""
    i = 0
    for d in dates:
        for k in range(10):  # 10 symbols/day -> fan-out
            sym = f"{regime}_{d}_{k}"
            outcome = 'WIN' if (i % 10) < win_count else 'LOSS'
            conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                         (sym, d, p, regime))
            conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                         (sym, d, outcome))
            i += 1
    conn.commit()

def _spread_days(n, start="2026-01-01", gap_every=10):
    # n distinct days across 2 episodes (a big gap in the middle)
    import datetime as dt
    base = dt.date.fromisoformat(start); out = []
    for i in range(n):
        off = i + (40 if i >= n // 2 else 0)   # jump 40 days at the midpoint -> 2 episodes
        out.append((base + dt.timedelta(days=off)).isoformat())
    return out

def test_qualified_regime_gets_own_calibrator():
    conn = make_db()
    # BEAR: 22 days across 2 episodes, high-prob signals only win 40% -> own calibrator pulls 0.8 down hard
    _seed(conn, 'BEAR', 0.8, 4, _spread_days(22))
    # BULL elsewhere with the SAME raw prob winning 80% -> would calibrate 0.8 differently
    _seed(conn, 'BULL', 0.8, 8, _spread_days(22, start="2025-06-01"))
    res = recalibrate_win_probabilities(conn, min_samples=50, min_regime_days=20, min_regime_episodes=2)
    assert res['regimes']['BEAR']['used'] == 'regime'
    bear = conn.execute("SELECT calibrated_win_probability FROM technical_signals WHERE nifty_regime='BEAR' LIMIT 1").fetchone()[0]
    bull = conn.execute("SELECT calibrated_win_probability FROM technical_signals WHERE nifty_regime='BULL' LIMIT 1").fetchone()[0]
    assert bear == pytest.approx(0.4, abs=0.08) and bull == pytest.approx(0.8, abs=0.08)
    assert bear < bull   # same raw 0.8 calibrates lower in BEAR

def test_below_days_floor_uses_global():
    conn = make_db()
    # only 6 distinct days (lots of rows) -> below the 20-day floor -> global
    _seed(conn, 'SIDEWAYS', 0.8, 6, ["2026-03-%02d" % d for d in range(1, 7)])
    _seed(conn, 'BULL', 0.2, 2, ["2026-04-%02d" % d for d in range(1, 7)])
    res = recalibrate_win_probabilities(conn, min_samples=50, min_regime_days=20, min_regime_episodes=2)
    assert res['regimes']['SIDEWAYS']['used'] == 'global'

def test_single_episode_uses_global():
    conn = make_db()
    # 25 distinct days but all contiguous (1 episode) -> fails episode floor -> global
    import datetime as dt
    days = [(dt.date(2026,2,1)+dt.timedelta(days=i)).isoformat() for i in range(25)]
    _seed(conn, 'BEAR', 0.8, 4, days)
    _seed(conn, 'BULL', 0.2, 2, [(dt.date(2025,2,1)+dt.timedelta(days=i)).isoformat() for i in range(25)])
    res = recalibrate_win_probabilities(conn, min_samples=50, min_regime_days=20, min_regime_episodes=2)
    assert res['regimes']['BEAR']['used'] == 'global'
```

- [ ] **Step 2: Run to verify they fail**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_ml_calibration.py -k "qualified_regime or days_floor or single_episode" -v -p no:cacheprovider`
Expected: FAIL — `recalibrate_win_probabilities` currently ignores regime / `res['regimes']` KeyError.

- [ ] **Step 3: Implement** — replace `recalibrate_win_probabilities` body:

```python
def recalibrate_win_probabilities(conn, min_samples: int = 200,
                                  min_regime_days: int = 20, min_regime_episodes: int = 2) -> dict:
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.date AS d,
               ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so
        JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
        WHERE so.outcome IN ('WIN','LOSS') AND ts.win_probability IS NOT NULL
    """).fetchall()
    if len(rows) < min_samples:
        print(f"[Calibration] insufficient data ({len(rows)} < {min_samples}); skipping.")
        return {'fit': False, 'reason': 'insufficient', 'n': len(rows)}

    all_p = [float(r['p']) for r in rows]; all_y = [int(r['y']) for r in rows]
    if len(set(all_y)) < 2:
        print("[Calibration] only one outcome class; skipping.")
        return {'fit': False, 'reason': 'one_class', 'n': len(rows)}
    global_ir = fit_calibrator(all_p, all_y)

    # group by regime
    by_regime: dict = {}
    for r in rows:
        by_regime.setdefault(r['regime'], {'p': [], 'y': [], 'days': []})
        by_regime[r['regime']]['p'].append(float(r['p']))
        by_regime[r['regime']]['y'].append(int(r['y']))
        by_regime[r['regime']]['days'].append(str(r['d']))

    regime_cal: dict = {}; regimes_meta: dict = {}
    for reg, g in by_regime.items():
        dd = len(set(g['days'])); ep = count_episodes(g['days'])
        qualifies = (reg is not None and dd >= min_regime_days and ep >= min_regime_episodes
                     and len(set(g['y'])) >= 2)
        if qualifies:
            regime_cal[reg] = fit_calibrator(g['p'], g['y'])
        regimes_meta[reg] = {'n': len(g['p']), 'distinct_days': dd, 'episodes': ep,
                             'used': 'regime' if qualifies else 'global'}

    sigs = conn.execute(
        "SELECT symbol, date, nifty_regime, win_probability FROM technical_signals WHERE win_probability IS NOT NULL"
    ).fetchall()
    updated = 0
    for s in sigs:
        ir = regime_cal.get(s['nifty_regime'], global_ir)
        conn.execute(
            "UPDATE technical_signals SET calibrated_win_probability = ? WHERE symbol = ? AND date = ?",
            (calibrate(ir, float(s['win_probability'])), s['symbol'], s['date']))
        updated += 1
    conn.commit()
    for reg, m in regimes_meta.items():
        print(f"[Calibration] regime={reg} n={m['n']} days={m['distinct_days']} ep={m['episodes']} -> {m['used']}")
    print(f"[Calibration] fit on {len(rows)} WIN/LOSS signals; recalibrated {updated} rows.")
    return {'fit': True, 'n': len(rows), 'updated': updated, 'regimes': regimes_meta}
```

- [ ] **Step 4: Run to verify they pass** (+ the pre-existing calibration tests still green)

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_ml_calibration.py -v -p no:cacheprovider`
Expected: PASS (all, incl. the original `test_recalibrate_*`).

- [ ] **Step 5: Commit**

```bash
git add src/server/ml_calibration.py src/server/tests/test_ml_calibration.py
git commit -m "feat(calibration): per-regime isotonic calibration gated on days/episode floor (global fallback)"
```

---

### Task 6: `per_regime_auc` + `regime_readiness` diagnostics

**Files:**
- Modify: `src/server/ml_calibration.py`, `src/server/tests/test_ml_calibration.py`

**Interfaces:**
- Produces: `per_regime_auc(conn, min_n: int = 50) -> dict` `{regime: {n, auc}}` (raw win_probability vs WIN/LOSS, ≥2 classes, ≥`min_n`); `regime_readiness(conn, min_regime_days=20, min_regime_episodes=2) -> dict` `{regime: {n, distinct_days, episodes, first_day, last_day, ready}}`. Both called at the end of `run()`.

- [ ] **Step 1: Write the failing tests**

```python
from ml_calibration import per_regime_auc, regime_readiness  # add to import block

def test_per_regime_auc_distinguishes_rankable_vs_random():
    conn = make_db()
    # RANKABLE: high prob -> win, low prob -> loss
    for i in range(100):
        p = 0.9 if i % 2 == 0 else 0.1; y = 'WIN' if i % 2 == 0 else 'LOSS'
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"R{i}", f"2026-01-{i%28+1:02d}", p, 'BULL'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                     (f"R{i}", f"2026-01-{i%28+1:02d}", y))
    # RANDOM: prob unrelated to outcome
    for i in range(100):
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"X{i}", f"2026-02-{i%28+1:02d}", 0.5, 'BEAR'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                     (f"X{i}", f"2026-02-{i%28+1:02d}", 'WIN' if i < 50 else 'LOSS'))
    conn.commit()
    auc = per_regime_auc(conn, min_n=50)
    assert auc['BULL']['auc'] > 0.9
    assert 0.4 <= auc['BEAR']['auc'] <= 0.6

def test_regime_readiness_flags():
    conn = make_db()
    import datetime as dt
    ready_days = _spread_days(22)            # 22 days, 2 episodes -> ready
    not_days = [(dt.date(2026,3,1)+dt.timedelta(days=i)).isoformat() for i in range(5)]  # 5 days -> not
    for d in ready_days:
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"a{d}", d, 0.5, 'BEAR'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,'WIN')", (f"a{d}", d))
    for d in not_days:
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"b{d}", d, 0.5, 'BULL'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,'WIN')", (f"b{d}", d))
    conn.commit()
    rr = regime_readiness(conn)
    assert rr['BEAR']['ready'] is True and rr['BULL']['ready'] is False
```

(reuse the `_spread_days` helper from Task 5.)

- [ ] **Step 2: Run to verify they fail**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_ml_calibration.py -k "per_regime_auc or regime_readiness" -v -p no:cacheprovider`
Expected: FAIL — ImportError.

- [ ] **Step 3: Implement**

```python
def per_regime_auc(conn, min_n: int = 50) -> dict:
    from sklearn.metrics import roc_auc_score
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.win_probability AS p,
               CASE WHEN so.outcome='WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol=so.symbol AND ts.date=so.signal_date
        WHERE so.outcome IN ('WIN','LOSS') AND ts.win_probability IS NOT NULL
    """).fetchall()
    g: dict = {}
    for r in rows:
        g.setdefault(r['regime'], {'p': [], 'y': []})
        g[r['regime']]['p'].append(float(r['p'])); g[r['regime']]['y'].append(int(r['y']))
    out = {}
    for reg, d in g.items():
        if len(d['p']) >= min_n and len(set(d['y'])) >= 2:
            out[reg] = {'n': len(d['p']), 'auc': float(roc_auc_score(d['y'], d['p']))}
            print(f"[Calibration] per-regime AUC {reg}: {out[reg]['auc']:.3f} (n={out[reg]['n']})")
    return out


def regime_readiness(conn, min_regime_days: int = 20, min_regime_episodes: int = 2) -> dict:
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.date AS d
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol=so.symbol AND ts.date=so.signal_date
        WHERE so.outcome IN ('WIN','LOSS') AND ts.win_probability IS NOT NULL
    """).fetchall()
    g: dict = {}
    for r in rows:
        g.setdefault(r['regime'], []).append(str(r['d']))
    out = {}
    for reg, days in g.items():
        dd = len(set(days)); ep = count_episodes(days)
        out[reg] = {'n': len(days), 'distinct_days': dd, 'episodes': ep,
                    'first_day': min(days), 'last_day': max(days),
                    'ready': dd >= min_regime_days and ep >= min_regime_episodes}
        print(f"[Calibration] readiness {reg}: days={dd} ep={ep} ready={out[reg]['ready']}")
    return out
```

NOTE: remove the stray non-ASCII chars introduced above — the function signature is exactly `def per_regime_auc(conn, min_n: int = 50) -> dict:`.

Wire both into `run()` after `recalibrate_win_probabilities(conn)`:

```python
def run():
    conn = connect()
    try:
        recalibrate_win_probabilities(conn)
        regime_readiness(conn)
        per_regime_auc(conn)
    finally:
        conn.close()
```

- [ ] **Step 4: Run to verify they pass**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/test_ml_calibration.py -v -p no:cacheprovider`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/ml_calibration.py src/server/tests/test_ml_calibration.py
git commit -m "feat(calibration): per_regime_auc + regime_readiness diagnostics, wired into run()"
```

---

### Task 7: Regime-fair scoring gate (raw → calibrated)

**Files:**
- Modify: `src/server/scoring_engine.py:490`

**Interfaces:**
- Consumes: `technical_signals.calibrated_win_probability` (written by Task 5).

- [ ] **Step 1: Modify the gate query** — change line 490 from
  `SELECT symbol, MAX(win_probability) AS wp`
  to:
```python
                    SELECT symbol, MAX(COALESCE(calibrated_win_probability, win_probability)) AS wp
```
  (Leave the rest of the block — `WHERE date >= :cutoff AND win_probability IS NOT NULL`, the 0.40 comparisons — unchanged.)

- [ ] **Step 2: Verify scoring_engine imports/compiles**

Run: `backend-python/venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'src/server'); import scoring_engine; print('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/server/scoring_engine.py
git commit -m "feat(scoring): gate on COALESCE(calibrated_win_probability, win_probability) — regime-fair"
```

---

### Task 8: Full verification + live-PG dormant-safety check

- [ ] **Step 1: Full test suites**

Run: `backend-python/venv/Scripts/python.exe -m pytest src/server/tests/ -q -p no:cacheprovider` (expect all pass)
Run: `npx tsc --noEmit` (expect 0 errors — no TS changed in P1/P3, but confirm).

- [ ] **Step 2: Live-PG dormant safety** — confirm today every regime is below the floor → global fallback → calibrated values unchanged vs a global run:

```bash
USE_POSTGRES=true PYTHONIOENCODING=utf-8 backend-python/venv/Scripts/python.exe src/server/ml_calibration.py
```
Expected log: every regime prints `ready=False` and `-> global`; per-regime AUC printed for visibility.

- [ ] **Step 3: Verify the gate shift** — count gated-in signals before/after is a deliberate change (gate now reads calibrated):

```bash
docker exec bharat_timescaledb psql -U bharat -d bharat_intel -c "SELECT COUNT(*) FILTER (WHERE COALESCE(calibrated_win_probability,win_probability)>=0.40) AS pass_calibrated, COUNT(*) FILTER (WHERE win_probability>=0.40) AS pass_raw FROM technical_signals WHERE date >= (CURRENT_DATE - INTERVAL '1 day')::text;"
```

- [ ] **Step 4: Final commit (if any verification fixups)** — otherwise done.

---

## Phase 2 (deferred to its own plan)

Signal/outcome replay over the 550-day window to supply historical `(regime, win_probability, outcome)` tuples so the per-regime calibrators clear the floor. **Caveated** (partial historical feature set — IV/delivery/PCR/PIT-fundamentals neutral; mild look-ahead on historical `win_probability`). Write `docs/superpowers/plans/<date>-regime-calibration-phase2-replay.md` when ready to commit to it; it is gated on Phase 1 landing and the readiness/AUC diagnostics being trustworthy.

## Self-Review notes

- Spec coverage: Phase 1 (FII/DII backfill T1, a/d repoint T2, regime/breadth/macro backfill T3), Phase 3 (count_episodes T4, per-regime calibration+floor T5, diagnostics T6, gate T7, verification T8). Phase 2 explicitly deferred. ✓
- The `per_regime_auc` code block contains intentional `NOTE` to strip stray non-ASCII in the signature — implementer must type the exact ASCII signature shown.
- Types consistent: `recalibrate_win_probabilities` returns `regimes[reg]['used']`; tests assert on it. `count_episodes(days, gap_days=5)`; readiness/calibration both call it. Gate consumes `calibrated_win_probability` written by T5.
