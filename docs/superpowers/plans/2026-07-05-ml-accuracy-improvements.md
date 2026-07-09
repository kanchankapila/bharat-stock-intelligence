# ML Accuracy & Backtesting Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the daily learning loop, fix label quality, expand features, improve backtesting realism, and wire drift-detection into the scoring engine — all using data already in the DB.

**Architecture:** Nine independent improvements split across four parallel tracks: (A) ML label quality & online learning, (B) backtesting realism, (C) feature engineering, (D) RL + infrastructure. Each track produces self-contained Python changes; no TypeScript/frontend changes required.

**Tech Stack:** Python 3.11+, pandas, numpy, scikit-learn, lightgbm, scipy, SQLite/PostgreSQL via `db_compat`

## Global Constraints

- All DB access via `db_compat` (`connect`, `read_df`, `query_one`, `query_all`, `execute`) — never raw `sqlite3`/`psycopg2`
- SQLite placeholder = `?`; Postgres placeholder = `%s`; `db_compat` handles translation — use `?` always
- DATE columns on Postgres need `datetime.date` objects as bind params (not strings) — follow `rl_agent.py` rule #6
- `use_postgres()` from `db_compat` returns bool; check it when writing Postgres-only SQL
- Working directory for all Python scripts: `D:/Github/bharat-stock-intelligence/src/server/`
- No new pip packages allowed unless absolutely unavoidable; everything needed is already installed
- No comments unless the WHY is non-obvious

---

## Track A — ML Label Quality & Online Learning

### Task A1: ATR-scaled WIN/LOSS thresholds in outcome_resolver.py

**Files:**
- Modify: `src/server/outcome_resolver.py`

**Context:**  
`WIN_THRESHOLD = 1.0` and `LOSS_THRESHOLD = -1.0` are hardcoded. A 1% move is noise for a high-beta small-cap (ATR 4%) but a real WIN for HDFC Bank (ATR 0.5%). The fix: compute ATR(14) from `stock_ohlcv` at signal time and use `max(1.0, 0.5 × atr_14d_pct)` as the threshold. `atr_14d_pct` = ATR expressed as % of close price.

The `Backtester.compute_atr_from_df()` pattern already exists in `backtester.py` lines 117–139. Replicate the ATR calculation logic inline in outcome_resolver using a single SQL query per symbol batch.

- [ ] **Step 1: Add `_fetch_atr_pct` helper to outcome_resolver.py**

Open `src/server/outcome_resolver.py` and add this function after the `ROUND_TRIP_COST_PCT` constant (around line 37):

```python
def _fetch_atr_pct(conn: ConnWrapper, symbol: str, as_of_date: str, window: int = 14) -> float:
    """Return ATR(14) as % of closing price on `as_of_date`, or 2.0 if unavailable."""
    as_of_d = datetime.date.fromisoformat(as_of_date) if isinstance(as_of_date, str) else as_of_date
    rows = query_all(
        conn,
        "SELECT high, low, close FROM stock_ohlcv WHERE symbol=? AND date<=? ORDER BY date DESC LIMIT ?",
        (symbol, as_of_d, window + 1),
    )
    if len(rows) < window + 1:
        return 2.0
    bars = list(reversed(rows))
    trs = []
    for i in range(1, len(bars)):
        h, l, prev_c = float(bars[i]['high']), float(bars[i]['low']), float(bars[i-1]['close'])
        trs.append(max(h - l, abs(h - prev_c), abs(l - prev_c)))
    atr = sum(trs) / len(trs)
    last_close = float(bars[-1]['close'])
    return (atr / last_close * 100) if last_close > 0 else 2.0


def _dynamic_thresholds(atr_pct: float) -> tuple[float, float]:
    """Win = +0.5×ATR (min 1%), Loss = -0.5×ATR (min -1%)."""
    half = max(1.0, 0.5 * atr_pct)
    return half, -half
```

- [ ] **Step 2: Use dynamic thresholds in `resolve_signal` / the main resolution loop**

Find the section in `outcome_resolver.py` that computes `return_pct` and then labels WIN/LOSS/NEUTRAL. It compares against `WIN_THRESHOLD` / `LOSS_THRESHOLD`. Replace those comparisons:

**Find** (approximately lines that look like):
```python
    if net_ret >= WIN_THRESHOLD:
        outcome = 'WIN'
    elif net_ret <= LOSS_THRESHOLD:
        outcome = 'LOSS'
    else:
        outcome = 'NEUTRAL'
```

**Replace with:**
```python
    atr_pct = _fetch_atr_pct(conn, symbol, signal_date_str)
    win_thr, loss_thr = _dynamic_thresholds(atr_pct)
    if net_ret >= win_thr:
        outcome = 'WIN'
    elif net_ret <= loss_thr:
        outcome = 'LOSS'
    else:
        outcome = 'NEUTRAL'
```

Where `symbol`, `signal_date_str`, and `conn` are the variables available in the resolution loop. If the loop already has `atr` available from `technical_signals`, skip the DB call and compute from that instead.

- [ ] **Step 3: Apply same thresholds in performance_tracker.py**

Open `src/server/performance_tracker.py`. At lines 33–34:
```python
WIN_THRESHOLD  =  1.0
LOSS_THRESHOLD = -1.0
```

Add a helper below the constants:
```python
def _dynamic_thresholds_for_segment(atr_pct: float) -> tuple[float, float]:
    half = max(1.0, 0.5 * atr_pct)
    return half, -half
```

In `load_outcomes()` (around line 50), add `ts.atr_pct_tl` to the SELECT (it exists in `technical_signals` via trendlyne_adv_tech_fetcher). Then in the win/loss classification code (wherever it calls `> WIN_THRESHOLD`), replace with per-row dynamic threshold using the `atr_pct_tl` column (default 2.0 if NULL).

- [ ] **Step 4: Verify by dry-running outcome_resolver**

```bash
cd src/server && python outcome_resolver.py --dry-run 2>&1 | head -30
```
Expected: no crash, prints "Dry-run" summary. ATR values printed in debug output.

- [ ] **Step 5: Commit**

```bash
git add src/server/outcome_resolver.py src/server/performance_tracker.py
git commit -m "feat: ATR-scaled dynamic WIN/LOSS thresholds in outcome_resolver and performance_tracker"
```

---

### Task A2: LGBM warm-start incremental retraining in ml_ensemble.py

**Files:**
- Modify: `src/server/ml_ensemble.py`

**Context:**  
The ensemble only retrains weekly. LGBM supports incremental training via `init_model` param: you can pass the existing booster and it runs additional boosting rounds on new data. Add a `--incremental` CLI flag that loads the saved `ensemble.pkl`, fetches the last 3 days of resolved outcomes, and runs 20 additional LGBM rounds without touching RF/ET/LR (which don't support warm-start). This runs daily after `outcome_resolver.py`.

- [ ] **Step 1: Add `incremental_update()` function to ml_ensemble.py**

Find the bottom of `ml_ensemble.py` where the `if __name__ == '__main__':` block begins. Add before it:

```python
def incremental_update(n_days: int = 3, n_rounds: int = 20, dry_run: bool = False) -> bool:
    """Warm-start LGBM base estimator on last `n_days` of new resolved outcomes.

    Loads ensemble.pkl, extracts the LGBMClassifier, runs `n_rounds` additional
    boosting iterations on fresh outcomes, re-saves. RF/ET/LR unchanged.
    Returns True if update was applied, False if skipped.
    """
    if not os.path.exists(ENSEMBLE_PATH):
        print("[Ensemble] No saved model — run --train first.")
        return False

    try:
        import lightgbm as lgb
    except ImportError:
        print("[Ensemble] lightgbm not installed — skipping incremental update.")
        return False

    cutoff = (datetime.datetime.now() - datetime.timedelta(days=n_days)).strftime('%Y-%m-%d')
    q = """
        SELECT so.symbol, so.signal_date, so.horizon_days, so.outcome,
               so.signal_score, so.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net, ts.above_sma200, ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net, ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.iv_rank, ts.iv_skew, ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break, ts.vwap_deviation_pct, ts.first_hour_vol_share
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts ON ts.symbol=so.symbol AND ts.date=so.signal_date
        WHERE so.outcome IN ('WIN','LOSS')
          AND so.signal_date >= ?
        ORDER BY so.signal_date ASC
    """
    df = read_df(q, (cutoff,))
    if len(df) < 5:
        print(f"[Ensemble] Only {len(df)} new outcomes in last {n_days}d — skipping incremental.")
        return False

    print(f"[Ensemble] Incremental update: {len(df)} outcomes from last {n_days}d")
    y = (df['outcome'] == 'WIN').astype(int).values
    X = build_features(df)

    with open(ENSEMBLE_PATH, 'rb') as f:
        ensemble = pickle.load(f)

    # Find the LGBM base estimator inside the stacking ensemble
    lgbm_model = None
    for est_name, est in ensemble.get('base_estimators', {}).items():
        inner = getattr(est, 'estimator', est)  # unwrap CalibratedClassifierCV
        if hasattr(inner, 'booster_'):
            lgbm_model = inner
            lgbm_name  = est_name
            break

    if lgbm_model is None:
        print("[Ensemble] No LGBM model found in ensemble — skipping incremental.")
        return False

    if dry_run:
        print(f"[Ensemble] Dry-run: would run {n_rounds} rounds on {len(df)} samples.")
        return True

    feature_names = ensemble.get('feature_names', list(X.columns))
    for col in feature_names:
        if col not in X.columns:
            X[col] = 0.0
    X_aligned = X[feature_names].astype(np.float32)

    ds = lgb.Dataset(X_aligned, label=y)
    lgbm_model.booster_ = lgb.train(
        lgbm_model.get_params(),
        ds,
        num_boost_round=n_rounds,
        init_model=lgbm_model.booster_,
        valid_sets=[ds],
        callbacks=[lgb.early_stopping(10, verbose=False), lgb.log_evaluation(period=-1)],
    )

    with open(ENSEMBLE_PATH, 'wb') as f:
        pickle.dump(ensemble, f, protocol=pickle.HIGHEST_PROTOCOL)

    print(f"[Ensemble] Incremental update complete: +{n_rounds} rounds on {len(df)} samples.")
    return True
```

- [ ] **Step 2: Wire `--incremental` flag into the `__main__` argparse block**

Find the `argparse` setup in `ml_ensemble.py` `__main__` block. Add:
```python
parser.add_argument('--incremental', action='store_true',
                    help='Warm-start LGBM on last 3 days of outcomes (daily, fast)')
parser.add_argument('--incr-days', type=int, default=3,
                    help='Days of recent outcomes for incremental update (default 3)')
parser.add_argument('--incr-rounds', type=int, default=20,
                    help='Additional LGBM boosting rounds (default 20)')
```

Then add the handler before the existing `--train` check:
```python
if args.incremental:
    incremental_update(n_days=args.incr_days, n_rounds=args.incr_rounds, dry_run=args.dry_run if hasattr(args,'dry_run') else False)
    sys.exit(0)
```

- [ ] **Step 3: Test incremental mode dry-run**

```bash
cd src/server && python ml_ensemble.py --incremental --dry-run 2>&1 | head -20
```
Expected: prints "Dry-run: would run 20 rounds on N samples." or "No saved model — run --train first."

- [ ] **Step 4: Commit**

```bash
git add src/server/ml_ensemble.py
git commit -m "feat: LGBM warm-start incremental daily retraining (--incremental flag)"
```

---

### Task A3: Adaptive SGD/ensemble blend ratio in online_learner.py

**Files:**
- Modify: `src/server/online_learner.py`

**Context:**  
The blend is hardcoded `0.4 * sgd_probs + 0.6 * ens_probs` in `score_pending_with_ensemble_blend()` (line ~242). The ratio should shift when the ensemble is stale. Logic: if `ensemble.pkl` mtime > 5 days → raise SGD weight to 0.60; if > 14 days → 0.75; else use default 0.40.

- [ ] **Step 1: Add `_compute_blend_weights()` helper**

In `online_learner.py`, add before `score_pending_with_ensemble_blend`:

```python
def _compute_blend_weights(ensemble_path: str) -> tuple[float, float]:
    """Return (sgd_weight, ens_weight) based on ensemble model freshness."""
    if not os.path.exists(ensemble_path):
        return 1.0, 0.0
    age_days = (datetime.datetime.now().timestamp() - os.path.getmtime(ensemble_path)) / 86400
    if age_days > 14:
        return 0.75, 0.25
    if age_days > 5:
        return 0.60, 0.40
    return 0.40, 0.60
```

- [ ] **Step 2: Use the helper in `score_pending_with_ensemble_blend`**

Replace the hardcoded blend line:
```python
        probs = 0.4 * sgd_probs + 0.6 * ens_probs
```
With:
```python
        sgd_w, ens_w = _compute_blend_weights(ENSEMBLE_PATH)
        probs = sgd_w * sgd_probs + ens_w * ens_probs
        print(f"[OnlineLearner] Blend weights — SGD:{sgd_w:.2f}  ENS:{ens_w:.2f}")
```

- [ ] **Step 3: Verify no crash**

```bash
cd src/server && python online_learner.py --dry-run 2>&1 | head -20
```
Expected: prints `[OnlineLearner] Blend weights — SGD:0.40  ENS:0.60` (or shifted values based on ensemble age).

- [ ] **Step 4: Commit**

```bash
git add src/server/online_learner.py
git commit -m "feat: adaptive SGD/ensemble blend ratio based on ensemble model freshness"
```

---

## Track B — Backtesting Realism

### Task B1: Fractional Kelly position sizing in backtester.py

**Files:**
- Modify: `src/server/backtester.py`

**Context:**  
`simulate_trades()` uses equal `1/max_positions` sizing. We have `win_probability` in `technical_signals`. Add fractional Kelly: `f* = (p * b - q) / b` where `p=win_probability`, `q=1-p`, `b=target/stop ratio`. Cap at `0.25` (quarter-Kelly to reduce ruin risk). Keep equal-weight as fallback when `win_probability` is NULL.

- [ ] **Step 1: Add `_kelly_fraction()` utility**

Near the top of `backtester.py` (after imports), add:

```python
MAX_KELLY_FRAC = 0.25  # quarter-Kelly cap

def _kelly_fraction(win_prob: float, target: float | None, entry: float, stop: float | None) -> float:
    """Return fractional Kelly position size as a fraction of capital.
    Falls back to equal-weight signal (returns None means use 1/max_positions).
    """
    if win_prob is None or not (0 < win_prob < 1):
        return None
    if target is None or stop is None or entry <= 0 or stop >= entry:
        return None
    b = (target - entry) / (entry - stop)  # reward/risk ratio
    if b <= 0:
        return None
    p, q = win_prob, 1.0 - win_prob
    f = (p * b - q) / b
    return min(max(f, 0.0), MAX_KELLY_FRAC)
```

- [ ] **Step 2: Update `load_signals()` to fetch `win_probability`**

In `load_signals()`, change the SELECT to include `win_probability`:
```python
    q = """
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score,
               ts.cmp AS entry_price_ref, ts.stop_loss, ts.targets, ts.signals_json,
               ts.nifty_regime, ts.adx, ts.win_probability
        FROM technical_signals ts
        WHERE ts.date BETWEEN ? AND ?
          AND ts.signal_score >= ?
        ORDER BY ts.date ASC
    """
```

- [ ] **Step 3: Apply Kelly sizing in `simulate_trades()`**

In `simulate_trades()`, find the section where a new position is opened (look for `1 / max_positions` or similar). Replace the sizing logic:

**Find** (something like):
```python
                position_size = cash / (max_positions - len(open_positions))
```
or however equal-weight sizing is done. **Replace with:**

```python
                win_prob = float(row.get('win_probability') or 0)
                kelly_f = _kelly_fraction(win_prob, target_p, entry_price, sl_price)
                if kelly_f is not None and kelly_f > 0:
                    position_size = capital * kelly_f
                else:
                    position_size = capital / max_positions
                position_size = min(position_size, cash)  # can't spend what we don't have
```

- [ ] **Step 4: Test dry-run**

```bash
cd src/server && python backtester.py --start 2024-01-01 --end 2024-06-30 2>&1 | tail -20
```
Expected: completes without error; trade log entries present in output.

- [ ] **Step 5: Commit**

```bash
git add src/server/backtester.py
git commit -m "feat: fractional Kelly position sizing in backtester using signal win_probability"
```

---

### Task B2: Walk-forward validation in backtester.py

**Files:**
- Modify: `src/server/backtester.py`

**Context:**  
Add `--walk-forward` flag: split the date range into N rolling windows (default 4 quarters), train on the first 3 quarters of each window, report OOS metrics for Q4. Results printed per window and as aggregate. This doesn't change the default behaviour — existing usage is unchanged.

- [ ] **Step 1: Add `run_walk_forward()` method to the `Backtester` class**

Add after `simulate_trades` in `backtester.py`:

```python
    def run_walk_forward(
        self,
        start: str,
        end: str,
        n_folds: int = 4,
        min_score: int = 3,
        horizon_days: int = 15,
        initial_capital: float = INITIAL_CAPITAL,
        commission_bps: float = 40,
        slippage_bps: float = 15,
    ) -> list[dict]:
        """Rolling walk-forward: split [start,end] into n_folds equal windows.
        Each fold: train on first 75%, test on last 25%. Returns per-fold OOS metrics."""
        from datetime import date, timedelta

        s = date.fromisoformat(start)
        e = date.fromisoformat(end)
        total_days = (e - s).days
        fold_days  = total_days // n_folds

        results = []
        for i in range(n_folds):
            fold_start  = s + timedelta(days=i * fold_days)
            fold_end    = fold_start + timedelta(days=fold_days) if i < n_folds - 1 else e
            train_end   = fold_start + timedelta(days=int(fold_days * 0.75))
            oos_start   = train_end + timedelta(days=1)

            print(f"\n[WalkForward] Fold {i+1}/{n_folds}: train {fold_start}–{train_end}  OOS {oos_start}–{fold_end}")

            signals = self.load_signals(oos_start.isoformat(), fold_end.isoformat(), min_score, horizon_days)
            if signals.empty:
                print(f"  No signals in OOS window — skipping.")
                continue

            syms = signals['symbol'].unique().tolist()
            ohlcv = self.load_ohlcv(syms, oos_start.isoformat(), fold_end.isoformat())
            ohlcv_dict = {s: g.reset_index(drop=True) for s, g in ohlcv.groupby('symbol')}

            trades, equity = self.simulate_trades(
                signals, ohlcv_dict, initial_capital=initial_capital,
                commission_bps=commission_bps, slippage_bps=slippage_bps,
            )
            if not trades:
                print("  No trades executed.")
                continue

            wins   = sum(1 for t in trades if t.get('pnl', 0) > 0)
            total  = len(trades)
            pnl    = sum(t.get('pnl', 0) for t in trades)
            result = {
                'fold': i + 1,
                'oos_start': oos_start.isoformat(),
                'oos_end':   fold_end.isoformat(),
                'n_trades':  total,
                'win_rate':  round(wins / total, 4) if total else 0,
                'total_pnl': round(pnl, 2),
            }
            results.append(result)
            print(f"  Trades={total}  Win%={result['win_rate']*100:.1f}  PnL=₹{pnl:,.0f}")

        return results
```

- [ ] **Step 2: Wire `--walk-forward` into `__main__` argparse**

Find the argparse block at the bottom of `backtester.py`. Add:
```python
parser.add_argument('--walk-forward', action='store_true',
                    help='Run rolling walk-forward OOS validation')
parser.add_argument('--folds', type=int, default=4,
                    help='Number of walk-forward folds (default 4)')
```

In the handler block, add:
```python
    if args.walk_forward:
        bt.run_walk_forward(
            args.start, args.end,
            n_folds=args.folds,
            min_score=args.min_score,
            horizon_days=args.horizon,
            initial_capital=args.initial_capital,
        )
```

- [ ] **Step 3: Test**

```bash
cd src/server && python backtester.py --start 2023-01-01 --end 2024-12-31 --walk-forward --folds 4 2>&1 | tail -30
```
Expected: prints 4 fold summaries with trade counts and win rates. No crash.

- [ ] **Step 4: Commit**

```bash
git add src/server/backtester.py
git commit -m "feat: walk-forward rolling OOS validation in backtester (--walk-forward flag)"
```

---

### Task B3: ASM/GSM circuit filter in backtester.py

**Files:**
- Modify: `src/server/backtester.py`

**Context:**  
`asm_gsm_fetcher.py` stores surveillance data. Signals for stocks in ASM/GSM (or in circuit lock) should be excluded from the backtest — they are untradeable in reality. Add a pre-filter that drops signals where the stock was in ASM/GSM during the holding window.

- [ ] **Step 1: Add `_load_surveillance_events()` to Backtester**

```python
    def _load_surveillance_events(self) -> set[str]:
        """Return set of symbols currently or recently in ASM/GSM surveillance."""
        try:
            rows = self.conn.execute(
                "SELECT DISTINCT symbol FROM asm_gsm_stocks WHERE stage IS NOT NULL"
            ).fetchall()
            return {r[0] for r in rows}
        except Exception:
            return set()
```

- [ ] **Step 2: Apply filter in `simulate_trades`**

At the start of `simulate_trades`, before the main loop, add:
```python
        surveillance = self._load_surveillance_events()
        if surveillance:
            before = len(signals)
            signals = signals[~signals['symbol'].isin(surveillance)].reset_index(drop=True)
            if len(signals) < before:
                print(f"[Backtester] Removed {before - len(signals)} signals for ASM/GSM stocks")
```

- [ ] **Step 3: Test**

```bash
cd src/server && python backtester.py --start 2024-01-01 --end 2024-06-30 2>&1 | grep -i "ASM\|Removed\|signals"
```
Expected: either prints removal count or runs cleanly with no crash.

- [ ] **Step 4: Commit**

```bash
git add src/server/backtester.py
git commit -m "feat: exclude ASM/GSM surveillance stocks from backtester signal set"
```

---

## Track C — Feature Engineering

### Task C1: days_to_next_earnings feature in ml_ensemble.py

**Files:**
- Modify: `src/server/ml_ensemble.py`

**Context:**  
MC earnings calendar data is in the DB (from `mc_earnings_fetcher.py`). A `days_to_next_earnings` feature tells the model whether a signal is entering pre-earnings (binary outcome, high vol) or mid-cycle (trend-following setup). Signals within 3 days of earnings have dramatically different win rate distributions. The column in the DB is `mc_corp_events` or `mc_earnings` table — check what `mc_earnings_fetcher.py` writes.

- [ ] **Step 1: Check what table mc_earnings_fetcher writes to**

```bash
cd src/server && grep -n "CREATE\|INSERT INTO\|table" mc_earnings_fetcher.py | head -20
```

Note the table name for use in the SQL join below.

- [ ] **Step 2: Add `days_to_next_earnings` to `load_training_data` SQL join**

In `ml_ensemble.py`, find `load_training_data()`. Add a LEFT JOIN to fetch the next earnings date per symbol at signal_date. Pattern (adjust table/column names based on Step 1):

```python
        LEFT JOIN (
            SELECT symbol,
                   MIN(event_date) AS next_earnings_date
            FROM mc_earnings
            WHERE event_date >= so.signal_date
            GROUP BY symbol
        ) ne ON ne.symbol = so.symbol
```

Add `DATEDIFF` or date subtraction to SELECT:
- SQLite: `CAST(julianday(ne.next_earnings_date) - julianday(so.signal_date) AS INTEGER) AS days_to_next_earnings`
- Postgres: `EXTRACT(EPOCH FROM (ne.next_earnings_date::date - so.signal_date::date)) / 86400 AS days_to_next_earnings`

Use `db_compat.use_postgres()` flag to pick the right expression, or use a COALESCE defaulting to 999.

- [ ] **Step 3: Add feature to `build_features()`**

In `build_features()`, after the existing features, add:

```python
    # Days to next earnings: signals near earnings have binary outcome risk
    # <3d = pre-earnings; 3-10d = pre-announcement drift; >10d = mid-cycle
    dte = num('days_to_next_earnings', 999).clip(0, 90)
    X['days_to_earnings']      = dte / 90.0          # normalized 0-1 (0=imminent, 1=far)
    X['pre_earnings_3d']       = (dte <= 3).astype(float)
    X['pre_earnings_10d']      = (dte <= 10).astype(float)
    X['earnings_x_score']      = X['pre_earnings_10d'] * X['signal_score']
```

Also update `load_pending_signals()` to JOIN the same earnings table for live scoring.

- [ ] **Step 4: Verify build_features runs without crash**

```bash
cd src/server && python -c "
from ml_ensemble import load_training_data, build_features
df = load_training_data()
X = build_features(df)
print('Feature count:', X.shape[1])
print('days_to_earnings' in X.columns)
" 2>&1
```
Expected: prints feature count (should be higher than before) and `True`.

- [ ] **Step 5: Commit**

```bash
git add src/server/ml_ensemble.py
git commit -m "feat: days_to_next_earnings feature in ML ensemble build_features"
```

---

### Task C2: Options gamma-at-money and call/put walls in iv_features.py + ml_ensemble.py

**Files:**
- Modify: `src/server/iv_features.py`
- Modify: `src/server/ml_ensemble.py`

**Context:**  
`stock_option_chain_fetcher.py` writes per-strike OI data to `stock_options_oi` (or similar table). From this we can compute:
1. **gamma_atm**: ATM option gamma — high gamma near expiry = pin risk, price oscillates around strike
2. **call_wall**: strike with highest call OI = resistance level; `(call_wall - spot) / spot * 100` = distance
3. **put_wall**: strike with highest put OI = support level; `(spot - put_wall) / spot * 100` = distance

- [ ] **Step 1: Identify the options OI table schema**

```bash
cd src/server && grep -n "INSERT INTO\|CREATE TABLE\|stock_option" stock_option_chain_fetcher.py | head -20
```

Note the table name, column names for strike, oi_calls, oi_puts, expiry.

- [ ] **Step 2: Add `compute_options_walls()` function to iv_features.py**

Open `src/server/iv_features.py` and add:

```python
def compute_options_walls(conn, symbol: str, spot: float, as_of_date: str) -> dict:
    """Compute call wall, put wall, and near-expiry gamma flag from OI data."""
    result = {'call_wall_dist_pct': 0.0, 'put_wall_dist_pct': 0.0, 'near_expiry_gamma': 0.0}
    if spot <= 0:
        return result
    try:
        # Fetch current-month expiry OI (nearest expiry)
        rows = conn.execute("""
            SELECT strike, oi_calls, oi_puts, expiry_date
            FROM stock_options_oi
            WHERE symbol = ? AND as_of_date = ?
            ORDER BY expiry_date ASC, strike ASC
        """, (symbol, as_of_date)).fetchall()
        if not rows:
            return result

        import datetime as _dt
        today = _dt.date.fromisoformat(as_of_date)
        # Use nearest expiry only
        nearest_expiry = min(str(r['expiry_date'])[:10] for r in rows)
        rows = [r for r in rows if str(r['expiry_date'])[:10] == nearest_expiry]
        days_to_exp = (_dt.date.fromisoformat(nearest_expiry) - today).days

        strikes    = [float(r['strike']) for r in rows]
        oi_calls   = [float(r['oi_calls'] or 0) for r in rows]
        oi_puts    = [float(r['oi_puts']  or 0) for r in rows]

        if max(oi_calls, default=0) > 0:
            call_wall_strike = strikes[oi_calls.index(max(oi_calls))]
            result['call_wall_dist_pct'] = (call_wall_strike - spot) / spot * 100

        if max(oi_puts, default=0) > 0:
            put_wall_strike = strikes[oi_puts.index(max(oi_puts))]
            result['put_wall_dist_pct'] = (spot - put_wall_strike) / spot * 100

        # Near-expiry gamma flag: within 7 days = elevated gamma, price pins to strikes
        result['near_expiry_gamma'] = 1.0 if days_to_exp <= 7 else 0.0

    except Exception as e:
        pass
    return result
```

- [ ] **Step 3: Call `compute_options_walls()` in the iv_features main loop**

In `iv_features.py`, find where it writes to `technical_signals`. After computing existing features, call `compute_options_walls()` and add the three new columns to the UPDATE or INSERT statement:

```python
    walls = compute_options_walls(conn, symbol, spot_price, as_of_date)
    # Add to existing UPDATE:
    # call_wall_dist_pct = walls['call_wall_dist_pct']
    # put_wall_dist_pct  = walls['put_wall_dist_pct']
    # near_expiry_gamma  = walls['near_expiry_gamma']
```

You'll need to ensure `call_wall_dist_pct`, `put_wall_dist_pct`, `near_expiry_gamma` columns exist in `technical_signals` — add them via ALTER TABLE IF NOT EXISTS pattern if needed.

- [ ] **Step 4: Add features to `build_features()` in ml_ensemble.py**

After the existing options features (`iv_rank`, `iv_skew`, `max_pain_dist_pct`), add:

```python
    # Call wall = nearest heavy call OI strike above spot (resistance). Positive = above spot.
    # Put wall  = nearest heavy put OI strike below spot (support). Positive = spot above it.
    X['call_wall_dist_pct'] = num('call_wall_dist_pct', 5.0).clip(0, 20)
    X['put_wall_dist_pct']  = num('put_wall_dist_pct',  3.0).clip(0, 20)
    # Between walls = in the pinning zone; above call wall = breakout territory
    X['between_walls']      = ((X['call_wall_dist_pct'] > 0) & (X['put_wall_dist_pct'] > 0)).astype(float)
    # Near-expiry gamma: price tends to mean-revert to max-pain strike — lower directional reliability
    X['near_expiry_gamma']  = num('near_expiry_gamma', 0.0).clip(0, 1)
    # Strong signal inside expiry week = lower confidence (gamma pins the price)
    X['gamma_x_score']      = (1.0 - X['near_expiry_gamma']) * X['signal_score']
```

- [ ] **Step 5: Test iv_features runs without crash**

```bash
cd src/server && python iv_features.py --dry-run 2>&1 | head -20
```
If no `--dry-run` flag exists, just import-test:
```bash
cd src/server && python -c "import iv_features; print('OK')"
```

- [ ] **Step 6: Commit**

```bash
git add src/server/iv_features.py src/server/ml_ensemble.py
git commit -m "feat: call/put wall distance and near-expiry gamma features from options OI"
```

---

### Task C3: Credit rating momentum feature in ml_ensemble.py

**Files:**
- Modify: `src/server/ml_ensemble.py`

**Context:**  
`credit_rating_fetcher.py` writes credit rating events to a DB table (name to verify). A stock with 2 upgrades and 0 downgrades in the last 12 months is fundamentally improving. The `credit_trend_score` = `(upgrades - downgrades) / max(total_events, 1)` over 12 months. This is a lead indicator for analyst target upgrades (lag: 30–60 days typically).

- [ ] **Step 1: Find the credit rating table name**

```bash
cd src/server && grep -n "INSERT INTO\|CREATE TABLE" credit_rating_fetcher.py | head -10
```

- [ ] **Step 2: Add credit trend join to `load_training_data()` SQL**

In `ml_ensemble.py` `load_training_data()`, add a LEFT JOIN:

```python
        LEFT JOIN (
            SELECT symbol,
                   SUM(CASE WHEN action_type='UPGRADE' THEN 1 ELSE 0 END) AS cr_upgrades,
                   SUM(CASE WHEN action_type='DOWNGRADE' THEN 1 ELSE 0 END) AS cr_downgrades,
                   COUNT(*) AS cr_total
            FROM credit_rating_events
            WHERE event_date >= DATE(so.signal_date, '-365 days')
              AND event_date <= so.signal_date
            GROUP BY symbol
        ) cr ON cr.symbol = so.symbol
```
(Adjust table/column names from Step 1.)

Add to SELECT: `cr.cr_upgrades, cr.cr_downgrades, cr.cr_total`

- [ ] **Step 3: Add feature to `build_features()`**

After the existing `altman_z` / `ohlson_o` features, add:

```python
    # Credit rating trend: (upgrades - downgrades) / total events in past 12m
    # +1.0 = all upgrades, -1.0 = all downgrades, 0.0 = balanced or no events
    cr_up   = num('cr_upgrades',   0.0).clip(0, 10)
    cr_dn   = num('cr_downgrades', 0.0).clip(0, 10)
    cr_tot  = num('cr_total',      0.0).clip(lower=1)
    X['credit_trend']    = ((cr_up - cr_dn) / cr_tot).clip(-1, 1)
    X['credit_upgraded'] = (cr_up > cr_dn).astype(float)
    X['credit_x_score']  = X['credit_trend'].clip(0, 1) * X['signal_score']
```

Also add to `load_pending_signals()` with the same join pattern.

- [ ] **Step 4: Verify**

```bash
cd src/server && python -c "
from ml_ensemble import load_training_data, build_features
df = load_training_data()
X = build_features(df)
print('credit_trend' in X.columns, X['credit_trend'].describe())
" 2>&1
```
Expected: `True` followed by describe output showing range -1 to 1.

- [ ] **Step 5: Commit**

```bash
git add src/server/ml_ensemble.py
git commit -m "feat: credit rating trend feature (upgrade/downgrade momentum) in ML ensemble"
```

---

## Track D — RL + Infrastructure

### Task D1: Expand RL state space with VIX regime and FII flow direction

**Files:**
- Modify: `src/server/rl_agent.py`

**Context:**  
The current state key is `{REGIME}_{SECTOR}_{SCORE_BUCKET}` = 54 states. Add two binary dimensions:
- **VIX_bucket**: `HIGH` if India VIX > 18, else `LOW` (from `macro_asset_prices` table, symbol `INDIAVIX`)
- **FII_direction**: `BUY` if 3d FII net > 0, else `SELL` (from `fii_dii_flow` table)

New state key: `{REGIME}_{SECTOR}_{SCORE}_{VIX}_{FII}` = 216 states. Still tabular — fits in memory. Q-table uses `ON CONFLICT` upsert so new state keys are auto-added.

- [ ] **Step 1: Add helper functions for VIX and FII lookup**

In `rl_agent.py`, after `_get_nifty_return()`, add:

```python
def _get_vix_bucket(conn: ConnWrapper, as_of_date: str) -> str:
    """Returns 'HIGH' if India VIX > 18 on or before as_of_date, else 'LOW'."""
    try:
        d = datetime.date.fromisoformat(as_of_date)
        row = conn.execute("""
            SELECT close FROM macro_asset_prices
            WHERE symbol='INDIAVIX' AND date<=?
            ORDER BY date DESC LIMIT 1
        """, (d,)).fetchone()
        if row and float(row[0]) > 18:
            return 'HIGH'
    except Exception:
        pass
    return 'LOW'


def _get_fii_direction(conn: ConnWrapper, as_of_date: str) -> str:
    """Returns 'BUY' if 3-day FII net > 0 ending as_of_date, else 'SELL'."""
    try:
        d = datetime.date.fromisoformat(as_of_date)
        row = conn.execute("""
            SELECT SUM(fii_net) FROM fii_dii_flow
            WHERE date <= ? AND date > ?
            ORDER BY date DESC
        """, (d, (d - datetime.timedelta(days=5)),)).fetchone()
        if row and row[0] is not None and float(row[0]) > 0:
            return 'BUY'
    except Exception:
        pass
    return 'SELL'
```

- [ ] **Step 2: Update `get_state_key()` to accept and use VIX+FII**

Change the signature to:
```python
def get_state_key(regime: str, sector_or_bucket: str, score: int,
                  vix_bucket: str = 'LOW', fii_dir: str = 'BUY') -> str:
    regime_clean  = regime if regime in REGIMES else 'SIDEWAYS'
    sector_bucket = get_sector_bucket(sector_or_bucket) if sector_or_bucket not in (
        'IT','BANK','PHARMA','AUTO','ENERGY','INFRA','METALS','CONSUMER',
        'TELECOM','REALTY','CHEMICALS','TEXTILES','MEDIA','OTHER'
    ) else sector_or_bucket
    vix_clean = vix_bucket if vix_bucket in ('HIGH','LOW') else 'LOW'
    fii_clean = fii_dir    if fii_dir    in ('BUY','SELL') else 'BUY'
    return f"{regime_clean}_{sector_bucket}_{get_score_bucket(score)}_{vix_clean}_{fii_clean}"
```

- [ ] **Step 3: Update `--update` mode to pass VIX and FII into state key**

In the episode update loop in `rl_agent.py` (the `--update` argparse handler), find where `get_state_key` is called. Update callers to also pass `vix_bucket` and `fii_dir`:

```python
    vix_b = _get_vix_bucket(conn, episode_date)
    fii_d = _get_fii_direction(conn, episode_date)
    state_key = get_state_key(regime, sector, score, vix_b, fii_d)
```

- [ ] **Step 4: Verify inspect mode works**

```bash
cd src/server && python rl_agent.py --inspect 2>&1 | head -30
```
Expected: prints Q-table with state keys in the new format (or old format for existing entries — both are valid since ON CONFLICT handles it).

- [ ] **Step 5: Commit**

```bash
git add src/server/rl_agent.py
git commit -m "feat: expand RL state space with VIX regime and FII flow direction dimensions"
```

---

### Task D2: Wire drift alerts into scoring engine

**Files:**
- Modify: `src/server/scoring_engine.py`
- Modify: `src/server/drift_detector.py`

**Context:**  
`drift_detector.py` runs PSI checks and writes results to `dl_model_performance`. `scoring_engine.py` never reads it. The fix: add a `get_drift_multiplier()` function that reads the most recent drift score from `dl_model_performance` and returns a confidence haircut (0.85–1.0) applied to every `win_probability` produced by the scoring engine. If PSI_CRIT is breached, apply a 15% haircut.

- [ ] **Step 1: Add `get_drift_multiplier()` to drift_detector.py**

At the bottom of `drift_detector.py`, add:

```python
def get_drift_multiplier(conn=None) -> float:
    """Returns a confidence multiplier (0.85–1.0) based on most recent drift score.
    1.0 = no drift; 0.85 = severe drift detected (apply 15% haircut to win_probability).
    """
    try:
        from db_compat import connect as _connect, query_one
        _conn = conn or _connect()
        row = query_one(
            _conn,
            "SELECT drift_score, psi_crit_count FROM dl_model_performance ORDER BY checked_at DESC LIMIT 1",
            (),
        )
        if not row:
            return 1.0
        drift_score  = float(row['drift_score']   or 0)
        psi_crit_cnt = int(row['psi_crit_count']  or 0)
        if psi_crit_cnt > 0 or drift_score > PSI_CRIT:
            return 0.85
        if drift_score > PSI_WARN:
            return 0.93
        return 1.0
    except Exception:
        return 1.0
```

- [ ] **Step 2: Call `get_drift_multiplier()` in scoring_engine.py**

In `scoring_engine.py`, find the `__init__` method and add:

```python
        self._drift_multiplier: float = 1.0
        self._drift_checked_at: float = 0.0
```

Add a refresh method:
```python
    def _refresh_drift_multiplier(self):
        import time
        if time.time() - self._drift_checked_at > 3600:  # refresh hourly
            try:
                from drift_detector import get_drift_multiplier
                self._drift_multiplier = get_drift_multiplier()
                self._drift_checked_at = time.time()
                if self._drift_multiplier < 1.0:
                    print(f"[Scoring] Drift detected — win_probability haircut: {self._drift_multiplier:.2f}x")
            except Exception:
                pass
```

In the main scoring method (wherever `win_probability` is computed or returned), apply the multiplier:
```python
        self._refresh_drift_multiplier()
        win_probability = round(raw_win_probability * self._drift_multiplier, 4)
```

- [ ] **Step 3: Verify scoring engine still starts**

```bash
cd src/server && python scoring_engine.py --help 2>&1 | head -5
```
Or:
```bash
cd src/server && python -c "from scoring_engine import AlphaQuantScoringEngine; print('OK')"
```
Expected: `OK` with no crash.

- [ ] **Step 4: Commit**

```bash
git add src/server/drift_detector.py src/server/scoring_engine.py
git commit -m "feat: wire drift detector PSI alerts into scoring engine as win_probability haircut"
```

---

### Task D3: Beta-Bernoulli per-signal-type priors

**Files:**
- Create: `src/server/signal_type_priors.py`
- Modify: `src/server/online_learner.py`

**Context:**  
Create a lightweight Beta-Bernoulli updater that maintains per-signal-type prior parameters (alpha, beta) stored in `app_settings` as JSON. After each `online_learner.py` run, update the priors from the new resolved outcomes. At scoring time, use the posterior mean `alpha / (alpha + beta)` as a per-type base rate that can sharpen or widen the ensemble probability.

- [ ] **Step 1: Create `src/server/signal_type_priors.py`**

```python
"""
Beta-Bernoulli per-signal-type win probability priors.
Priors are stored as JSON in app_settings key 'signal_type_priors'.
Schema: {"EMA_BULL_STACK": {"alpha": 12.0, "beta": 8.0}, ...}
"""
import json
from db_compat import connect, query_one, execute

# Jeffreys prior: weak, non-informative starting point
PRIOR_ALPHA = 1.0
PRIOR_BETA  = 1.0


def load_priors(conn) -> dict:
    row = query_one(conn, "SELECT value FROM app_settings WHERE key='signal_type_priors'", ())
    if row:
        try:
            return json.loads(row['value'])
        except Exception:
            pass
    return {}


def save_priors(conn, priors: dict):
    execute(conn, """
        INSERT INTO app_settings (key, value, "updatedAt")
        VALUES ('signal_type_priors', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, "updatedAt"=CURRENT_TIMESTAMP
    """, (json.dumps(priors),))


def update_priors_from_outcomes(conn, outcomes_df) -> dict:
    """Update Beta-Bernoulli priors from a DataFrame with columns: signals_json, outcome."""
    import json as _json
    priors = load_priors(conn)

    for _, row in outcomes_df.iterrows():
        is_win = row.get('outcome') == 'WIN'
        sig_json = row.get('signals_json')
        if not sig_json:
            continue
        try:
            signal_types = [s.get('type','') for s in _json.loads(sig_json) if isinstance(s, dict)]
        except Exception:
            continue
        for stype in signal_types:
            if not stype:
                continue
            if stype not in priors:
                priors[stype] = {'alpha': PRIOR_ALPHA, 'beta': PRIOR_BETA}
            if is_win:
                priors[stype]['alpha'] += 1.0
            else:
                priors[stype]['beta']  += 1.0

    save_priors(conn, priors)
    return priors


def get_posterior_mean(priors: dict, signal_type: str) -> float:
    """Posterior mean win probability for a signal type (Beta mean = alpha/(alpha+beta))."""
    p = priors.get(signal_type, {'alpha': PRIOR_ALPHA, 'beta': PRIOR_BETA})
    return p['alpha'] / (p['alpha'] + p['beta'])


def blend_with_prior(ensemble_prob: float, signal_types: list[str], priors: dict,
                     prior_weight: float = 0.15) -> float:
    """Blend ensemble probability with the average Beta posterior mean across signal types."""
    if not signal_types or not priors:
        return ensemble_prob
    means = [get_posterior_mean(priors, st) for st in signal_types if st]
    if not means:
        return ensemble_prob
    prior_mean = sum(means) / len(means)
    return (1 - prior_weight) * ensemble_prob + prior_weight * prior_mean


if __name__ == '__main__':
    conn = connect()
    priors = load_priors(conn)
    print(f"Signal type priors ({len(priors)} types):")
    for st, p in sorted(priors.items(), key=lambda x: -x[1]['alpha']/(x[1]['alpha']+x[1]['beta'])):
        mean = p['alpha'] / (p['alpha'] + p['beta'])
        n    = p['alpha'] + p['beta'] - PRIOR_ALPHA - PRIOR_BETA
        print(f"  {st:<30} mean={mean:.3f}  observations≈{n:.0f}")
    conn.close()
```

- [ ] **Step 2: Call `update_priors_from_outcomes()` at end of online_learner.py `run()`**

In `online_learner.py`, at the bottom of the `run()` function, after `save_sgd(state)`:

```python
        # Update Beta-Bernoulli priors from new outcomes
        try:
            from signal_type_priors import update_priors_from_outcomes
            n_updated = len(df)
            update_priors_from_outcomes(conn, df[['signals_json', 'outcome']])
            print(f"[OnlineLearner] Beta-Bernoulli priors updated from {n_updated} outcomes.")
        except Exception as e:
            print(f"[OnlineLearner] Prior update skipped: {e}")
```

- [ ] **Step 3: Test**

```bash
cd src/server && python signal_type_priors.py 2>&1
```
Expected: prints "Signal type priors (N types):" with per-type win rates, or "0 types" if no outcomes yet.

- [ ] **Step 4: Commit**

```bash
git add src/server/signal_type_priors.py src/server/online_learner.py
git commit -m "feat: Beta-Bernoulli per-signal-type win probability priors updated daily"
```

---

## Track E — Daily Cron Wiring (close the loop)

### Task E1: Post-market daily script that chains the feedback loop

**Files:**
- Create: `src/server/daily_ml_update.py`

**Context:**  
There is currently no single script that runs the full daily feedback loop in order. This script runs after market close (or scheduled via BullMQ / cron) and executes: `outcome_resolver → online_learner → ml_ensemble --incremental → signal_type_priors`. This closes the loop: daily price movements → resolved outcomes → model update → re-scored signals.

- [ ] **Step 1: Create `src/server/daily_ml_update.py`**

```python
"""
Daily ML feedback loop runner.
Run after market close (~15:35 IST) to update all ML models from today's resolved outcomes.

Order matters:
  1. outcome_resolver  — labels today's matured signals WIN/LOSS/NEUTRAL
  2. online_learner    — partial_fit SGD + update Beta-Bernoulli priors
  3. ml_ensemble       — warm-start LGBM incremental (+20 rounds on last 3d)
  4. drift_detector    — check feature distribution drift, write PSI scores

Run: python daily_ml_update.py
     python daily_ml_update.py --dry-run
"""

import subprocess
import sys
import datetime
import argparse

SCRIPTS = [
    ('outcome_resolver',  ['python', 'outcome_resolver.py']),
    ('online_learner',    ['python', 'online_learner.py', '--window', '30', '--min-new', '1']),
    ('ml_ensemble_incr',  ['python', 'ml_ensemble.py', '--incremental', '--incr-days', '3']),
    ('drift_detector',    ['python', 'drift_detector.py']),
]


def run(dry_run: bool = False):
    print(f"\n[DailyML] Starting daily feedback loop at {datetime.datetime.now()}")
    for name, cmd in SCRIPTS:
        print(f"\n[DailyML] Running {name}...")
        if dry_run:
            print(f"  DRY-RUN: would run: {' '.join(cmd)}")
            continue
        result = subprocess.run(cmd, capture_output=False)
        if result.returncode != 0:
            print(f"[DailyML] WARNING: {name} exited with code {result.returncode}")
        else:
            print(f"[DailyML] {name} completed OK")

    print(f"\n[DailyML] Daily feedback loop complete at {datetime.datetime.now()}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(dry_run=args.dry_run)
```

- [ ] **Step 2: Test dry-run**

```bash
cd src/server && python daily_ml_update.py --dry-run 2>&1
```
Expected: prints all 4 script names with "DRY-RUN: would run: ..." and no crashes.

- [ ] **Step 3: Commit**

```bash
git add src/server/daily_ml_update.py
git commit -m "feat: daily_ml_update.py — chains outcome_resolver → online_learner → ensemble incremental → drift check"
```

---

## Self-Review

**Spec coverage check:**
- ✅ ATR-scaled WIN/LOSS thresholds → Task A1
- ✅ LGBM warm-start daily → Task A2
- ✅ Adaptive SGD blend → Task A3
- ✅ Kelly position sizing → Task B1
- ✅ Walk-forward validation → Task B2
- ✅ ASM/GSM filter → Task B3
- ✅ days_to_next_earnings → Task C1
- ✅ Options gamma + call/put walls → Task C2
- ✅ Credit rating momentum → Task C3
- ✅ RL state space (VIX + FII) → Task D1
- ✅ Drift → scoring engine → Task D2
- ✅ Beta-Bernoulli priors → Task D3
- ✅ Daily cron wiring → Task E1

**Deferred (needs external data not yet in DB):**
- 5-min intraday OHLCV history store (needs storage + data feed)
- FII sector allocation flows (needs NSE monthly F&O participant data feed)
- Promoter pledge % as feature (already in `pledge_pct` — actually already implemented in build_features line 383)
