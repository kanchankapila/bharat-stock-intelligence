#!/usr/bin/env python3
"""
Breakout Classifier (Lever #4)
==============================
The ensemble's win_probability predicts whether an EMITTED signal wins — a self-selected
subset — and its live per-regime AUC collapses to ~0.50 outside BEAR. This engine asks a
different, cross-sectional question on the WHOLE universe:

    given a stock's features today, will it BREAK OUT (a >=6% up-move within the next 10
    trading days) — the move we actually want to catch in advance?

Label comes from forward stock_ohlcv (not signal_outcomes), so there is no emitted-signal
selection bias. Features are the same technical_signals matrix the ensemble uses, via the
shared build_features() transformer. Training is purged walk-forward (TimeSeriesSplit with
an embargo gap) so a stock's forward-looking label can't leak across the fold boundary.

Run:
    python breakout_classifier.py --train           # fit + report purged-OOF AUC
    python breakout_classifier.py --score            # write breakout_probability for latest date
"""

import argparse
import datetime
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import connect, read_df, translate, use_postgres
from model_promotion import decide_promotion_with_nan_guard

RET_THRESHOLD = 0.06     # +6% forward move = breakout
HORIZON = 10             # within the next 10 trading days
MIN_PRICE = 20.0
EMBARGO = HORIZON        # purge `horizon` bars between train and validation folds
RANDOM_STATE = 42        # pinned so promotion-gate comparisons and the purge regression
                         # test (test_breakout_purge_regression.py) are deterministic
TRAIN_LOOKBACK_DAYS = 2000   # ~5.5y — use the full backfilled history for training
SCORE_LOOKBACK_DAYS = 600    # headroom for the 252-day rolling windows on the latest bar
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml_models", "breakout.pkl")
CANDIDATE_PATH = MODEL_PATH + ".candidate"
# Same value as ml_ensemble.py's PROMOTION_MARGIN / movement_predictor.py's MOVEMENT_PROMOTION_MARGIN.
BREAKOUT_PROMOTION_MARGIN = 0.005

# Features computed DIRECTLY from stock_ohlcv (not technical_signals) so the model trains
# on the full multi-year history with a CONSISTENT feature set across all eras — the old
# technical_signals join capped training at ~16 recent dates and mixed feature-completeness
# between recent (200 cols populated) and old (all-default) rows. These momentum/trend/
# volatility/volume factors are what drove the breakout signal in the first place.
FEATURE_COLS = [
    "ret_5d", "ret_21d", "ret_63d", "ret_126d",
    "rs_rank_21d", "rs_rank_63d",
    "dist_sma20", "dist_sma50", "dist_sma200", "above_sma200",
    "rsi14", "hv20", "vol_ratio", "atr_pct", "dist_52w_high", "range_pct_10d",
    # breakout precursors (all OHLCV-derived, deep-history-safe)
    "dist_20d_high",      # proximity to the 20-day breakout level
    "vol_surge_5v20",     # 5d avg volume vs 20d — accumulation
    "range_contraction",  # 10d range vs 60d range — a squeeze coils before a breakout
    "up_vol_ratio_10",    # share of 10d volume on up-days — buying pressure
    "consec_up",          # up-day streak length (momentum persistence)
    "hv_ratio_10_60",     # short vs long realized vol — vol regime shift
]


# ── pure label core ───────────────────────────────────────────────────────────

def forward_max_return(close: pd.DataFrame, horizon: int = HORIZON) -> pd.DataFrame:
    """close: dates x symbols. Returns same-shape frame where each cell is the maximum
    close over the NEXT `horizon` rows divided by the current close minus 1 (NaN when the
    full forward window isn't available)."""
    fwd = close.shift(-1)
    for k in range(2, horizon + 1):
        fwd = np.maximum(fwd, close.shift(-k))
    # rows within `horizon` of the end have an incomplete window → NaN them out
    valid = close.shift(-horizon).notna()
    ret = fwd / close - 1.0
    return ret.where(valid)


def build_breakout_labels(close: pd.DataFrame, horizon: int = HORIZON,
                          ret_threshold: float = RET_THRESHOLD,
                          min_price: float = MIN_PRICE) -> pd.DataFrame:
    """Long frame (symbol, date, flew) — flew=1 when the forward `horizon`-day max return
    clears `ret_threshold`. Penny prices (< min_price) are dropped (noise, not tradable)."""
    ret = forward_max_return(close, horizon)
    flew = (ret >= ret_threshold).where(ret.notna())
    priced = close >= min_price
    flew = flew.where(priced)
    long = flew.stack(future_stack=True).rename("flew").reset_index()
    long = long.dropna(subset=["flew"])
    long["flew"] = long["flew"].astype(int)
    long.columns = ["date", "symbol", "flew"]
    return long[["symbol", "date", "flew"]]


# ── OHLCV-derived features ─────────────────────────────────────────────────────

def _rsi(close: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def compute_ohlcv_features(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """Long OHLCV (symbol,date,open,high,low,close,volume) → long feature frame
    (symbol, date, FEATURE_COLS). All momentum/trend/vol/volume factors, vectorized."""
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    high = ohlcv.pivot_table(index="date", columns="symbol", values="high").sort_index()
    low = ohlcv.pivot_table(index="date", columns="symbol", values="low").sort_index()
    vol = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()

    f: dict[str, pd.DataFrame] = {}
    for n in (5, 21, 63, 126):
        f[f"ret_{n}d"] = close.pct_change(n)
    # cross-sectional percentile rank of trailing return across the universe each day
    f["rs_rank_21d"] = close.pct_change(21).rank(axis=1, pct=True)
    f["rs_rank_63d"] = close.pct_change(63).rank(axis=1, pct=True)
    for n, name in ((20, "dist_sma20"), (50, "dist_sma50"), (200, "dist_sma200")):
        f[name] = close / close.rolling(n).mean() - 1.0
    f["above_sma200"] = (close > close.rolling(200).mean()).astype(float)
    f["rsi14"] = _rsi(close)
    f["hv20"] = close.pct_change().rolling(20).std() * np.sqrt(252)
    f["vol_ratio"] = vol / vol.rolling(20).mean()
    prev_close = close.shift()
    tr = np.maximum(high - low, np.maximum((high - prev_close).abs(), (low - prev_close).abs()))
    f["atr_pct"] = tr.rolling(14).mean() / close
    f["dist_52w_high"] = close / close.rolling(252, min_periods=60).max() - 1.0
    f["range_pct_10d"] = (high.rolling(10).max() - low.rolling(10).min()) / close

    # ── breakout precursors ──
    f["dist_20d_high"] = close / high.rolling(20).max() - 1.0
    f["vol_surge_5v20"] = vol.rolling(5).mean() / vol.rolling(20).mean()
    range10 = (high.rolling(10).max() - low.rolling(10).min())
    range60 = (high.rolling(60).max() - low.rolling(60).min())
    f["range_contraction"] = range10 / range60.replace(0, np.nan)
    dr = close.pct_change()
    up_vol = vol.where(dr > 0, 0.0)
    f["up_vol_ratio_10"] = up_vol.rolling(10).sum() / vol.rolling(10).sum().replace(0, np.nan)
    f["hv_ratio_10_60"] = dr.rolling(10).std() / dr.rolling(60).std().replace(0, np.nan)

    # consecutive up-day streak ending on each date, per symbol (vectorized)
    def _streak(s: pd.Series) -> pd.Series:
        b = (s > 0).astype(int)
        return b.groupby((b == 0).cumsum()).cumsum()
    f["consec_up"] = dr.apply(_streak)

    parts = [frame.stack(future_stack=True).rename(name) for name, frame in f.items()]
    out = pd.concat(parts, axis=1).reset_index()
    out.columns = ["date", "symbol"] + list(f.keys())
    return out


# ── training data ────────────────────────────────────────────────────────────

def _load_ohlcv(cutoff: str) -> pd.DataFrame:
    ohlcv = read_df(
        "SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv "
        "WHERE date >= ? AND COALESCE(is_suspect, 0) = 0 ORDER BY date",
        (cutoff,),
    )
    if not ohlcv.empty:
        ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.strftime("%Y-%m-%d")

    # stock_ohlcv was backfilled by iterating the *current* nse_stocks master, so it
    # structurally excludes the ~306 companies that have since delisted -- training only on
    # survivors overstates this classifier's real edge (the 5yr purged-OOF AUC 0.61 headline
    # figure is itself measured on this same survivorship-biased universe). Fill the gap with
    # split-adjusted NSE bhavcopy history via backtester.py's own proven fallback (reused, not
    # duplicated, since it already handles the raw-vs-split-adjusted seam that a naive UNION
    # would reintroduce -- see Backtester.load_bhavcopy_adjusted's docstring).
    try:
        from backtester import Backtester
        universe = read_df("SELECT DISTINCT symbol FROM nse_universe_history "
                            "WHERE date >= ? AND series IN ('EQ','BE')", (cutoff,))
        missing = sorted(set(universe["symbol"]) - set(ohlcv["symbol"] if not ohlcv.empty else []))
        if missing:
            bt = Backtester()
            try:
                extra = bt.load_bhavcopy_adjusted(missing, cutoff, datetime.date.today().isoformat())
            finally:
                bt.close()
            if not extra.empty:
                extra = extra.copy()
                extra["date"] = pd.to_datetime(extra["date"]).dt.strftime("%Y-%m-%d")
                ohlcv = pd.concat([ohlcv, extra], ignore_index=True) if not ohlcv.empty else extra
                print(f"[BreakoutClassifier] survivorship fill: +{extra['symbol'].nunique()} "
                      f"delisted symbols, +{len(extra)} bars")
    except Exception as e:
        print(f"[BreakoutClassifier] survivorship fill unavailable ({str(e)[:80]}); "
              "training on stock_ohlcv's current-universe-only history")

    return ohlcv


def load_labeled_features(horizon: int = HORIZON) -> pd.DataFrame:
    """OHLCV-derived features joined to the forward breakout label, over the full
    backfilled history. Only dates with a complete forward window are labelled."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=TRAIN_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)
    if ohlcv.empty:
        return pd.DataFrame()
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    labels = build_breakout_labels(close, horizon)
    if labels.empty:
        return pd.DataFrame()
    feats = compute_ohlcv_features(ohlcv)
    df = labels.merge(feats, on=["symbol", "date"], how="inner")
    # need the trailing windows to be populated
    return df.dropna(subset=FEATURE_COLS, how="any").reset_index(drop=True)


def _feature_matrix(df: pd.DataFrame):
    return df[FEATURE_COLS].replace([np.inf, -np.inf], np.nan).fillna(0.0)


def _make_model(spw: float):
    """A single gradient-boosted classifier. The full ml_ensemble stack (CatBoost + RF +
    ExtraTrees + LR + LGBM) × folds took 2+ CPU-hours on the 5-year / ~2M-row cross-section;
    for a breakout screen one fast booster is plenty and keeps train/score practical."""
    from lightgbm import LGBMClassifier
    return LGBMClassifier(
        n_estimators=400, learning_rate=0.03, num_leaves=63, max_depth=-1,
        subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
        min_child_samples=200, scale_pos_weight=spw, n_jobs=-1, verbose=-1,
        random_state=RANDOM_STATE,
    )


def evaluate_purged_cv(df: pd.DataFrame, embargo: int = EMBARGO, n_folds: int = 4,
                        holdout_frac: float = 0.15) -> dict:
    """Purged walk-forward OOF AUC — the honest read on whether breakouts are predictable.
    CRITICAL: purge by DATE, not by row. The label looks forward `horizon` trading days,
    and each date holds ~170 rows, so a row-based gap (TimeSeriesSplit gap=10) leaves the
    forward-label windows of adjacent folds massively overlapping -> leakage -> a
    fantasy AUC. We hold out contiguous date blocks and drop `horizon` embargo dates
    between train and validation so no training row's forward window touches a val date.

    This purged-OOF number is also used as the promotion-gate metric AND as the last check
    before refitting on all data — the same figure serves as both tuning signal and final
    sign-off. To get one independent read, carve off the most recent holdout_frac of dates
    up front; the walk-forward CV loop below never trains or validates on them. A model
    fit on everything before the holdout is scored against it separately, after CV.

    Pure function of `df` (no DB access) so it's directly testable on a synthetic frame --
    see test_breakout_purge_regression.py, which compares this against a deliberately
    naive row-index-gap split on the same leak-shaped synthetic data.

    Returns a dict: trained, n, auc, test_auc, base_rate, lift, plus X/y/spw/cv_df for
    reuse by callers (leak-check, the final production refit) without recomputing them.
    """
    from sklearn.metrics import roc_auc_score

    # Keep every other trading day: consecutive-day labels are highly autocorrelated, so
    # striding halves the row count with negligible information loss and keeps CV fast.
    df = df.sort_values("date").reset_index(drop=True)
    all_dates = sorted(df["date"].unique())
    if len(all_dates) > 200:
        keep = set(all_dates[::2])
        df = df[df["date"].isin(keep)].reset_index(drop=True)
    y = df["flew"].astype(int)
    X = _feature_matrix(df)
    base_rate = float(y.mean())
    spw = (1 - base_rate) / max(base_rate, 1e-6)

    HOLDOUT_FRAC = holdout_frac
    all_dates_sorted = np.array(sorted(df["date"].unique()))
    n_holdout_dates = max(embargo, int(len(all_dates_sorted) * HOLDOUT_FRAC))
    holdout_dates = set(all_dates_sorted[-n_holdout_dates:]) if len(all_dates_sorted) > 4 * embargo else set()
    cv_df = df[~df["date"].isin(holdout_dates)] if holdout_dates else df

    dates = np.array(sorted(cv_df["date"].unique()))
    oof = np.full(len(y), np.nan)
    if len(dates) < 2 * embargo:
        print(f"[Breakout] only {len(dates)} distinct dates; too few for a purged CV with "
              f"{embargo}-day embargo — treat the AUC as provisional until history grows.")
    block = max(1, (len(dates) - embargo) // (n_folds + 1))
    for i in range(1, n_folds + 1):
        train_end = block * i
        val_start = train_end + embargo
        val_end = val_start + block
        if val_start >= len(dates) or train_end < 1:
            continue
        train_dates = set(dates[:train_end])
        val_dates = set(dates[val_start:min(val_end, len(dates))])
        tr = df["date"].isin(train_dates).values
        va = df["date"].isin(val_dates).values
        if tr.sum() < 200 or va.sum() < 50 or len(set(y[tr])) < 2:
            continue
        m = _make_model(spw)
        m.fit(X[tr], y[tr])
        oof[va] = m.predict_proba(X[va])[:, 1]
    mask = ~np.isnan(oof)
    if mask.sum() < 50 or len(set(y[mask])) < 2:
        print(f"[Breakout] purged CV left too few validation rows ({int(mask.sum())}); "
              f"need more history (only {len(dates)} labelled dates available).")
        return {"trained": False, "n": len(y), "auc": float("nan"), "base_rate": base_rate,
                "test_auc": float("nan"), "lift": float("nan"), "X": X, "y": y, "spw": spw,
                "df": df, "cv_df": cv_df}
    auc = float(roc_auc_score(y[mask], oof[mask]))

    # top-decile lift: of the highest-scored decile, how much more often do they break out?
    q = pd.Series(oof[mask])
    top = q >= q.quantile(0.9)
    top_rate = float(y[mask][top.values].mean()) if top.any() else float("nan")
    lift = (top_rate / base_rate) if base_rate > 0 else float("nan")

    print(f"[Breakout] n={len(y)} base_rate={base_rate:.3f} purged-OOF AUC={auc:.4f} "
          f"top-decile breakout rate={top_rate:.3f} (lift {lift:.2f}x)")

    # Held-out test AUC — independent of the OOF number above. A model trained on everything
    # up to (holdout_start - embargo) is scored against the reserved final holdout_frac of
    # dates, which never appeared in any CV fold's train or validation split. This is the one
    # number in this file that answers "does it generalize" rather than "how was it tuned".
    test_auc = float("nan")
    if holdout_dates:
        train_cutoff = sorted(set(all_dates_sorted) - holdout_dates)
        train_cutoff_dates = set(train_cutoff[:max(1, len(train_cutoff) - embargo)])  # embargo before holdout too
        tr_ho = df["date"].isin(train_cutoff_dates).values
        va_ho = df["date"].isin(holdout_dates).values
        if tr_ho.sum() >= 200 and va_ho.sum() >= 50 and len(set(y[tr_ho])) >= 2 and len(set(y[va_ho])) >= 2:
            ho_model = _make_model(spw)
            ho_model.fit(X[tr_ho], y[tr_ho])
            test_auc = float(roc_auc_score(y[va_ho], ho_model.predict_proba(X[va_ho])[:, 1]))
            print(f"[Breakout] held-out test AUC={test_auc:.4f} on {va_ho.sum()} rows across "
                  f"{len(holdout_dates)} never-cross-validated final dates")
        else:
            print(f"[Breakout] held-out test skipped - insufficient rows/class balance "
                  f"(train={tr_ho.sum()}, holdout={va_ho.sum()})")

    return {"trained": True, "n": len(y), "auc": auc, "test_auc": test_auc,
            "base_rate": base_rate, "lift": lift, "X": X, "y": y, "spw": spw,
            "df": df, "cv_df": cv_df}


def _load_baseline_test_auc(model_path: str) -> float | None:
    """The currently-active model's own stored test_auc, or None if there's no existing
    model or it can't be read. Mirrors movement_predictor.py's helper of the same name --
    this is the one ML file in the codebase that historically had NO promotion gate at all
    (Finding #17-class bug, closed 2026-07-30): train() unconditionally overwrote
    ml_models/breakout.pkl regardless of whether the new fit was better or worse than the
    currently-deployed model, the single engine in this platform with genuine validated
    live edge (purged-OOF AUC ~0.61, top-decile lift ~1.47x)."""
    if not os.path.exists(model_path):
        return None
    try:
        with open(model_path, "rb") as f:
            existing = pickle.load(f)
        return existing.get("test_auc")
    except Exception as e:
        print(f"[Breakout] Could not read existing model at {model_path} for comparison "
              f"({e}) -- treating as no baseline.")
        return None


def _breakout_promotion_decision(test_auc: float, baseline_test_auc: float | None) -> tuple[bool, str | None]:
    """Pure gate decision: returns (promote, refusal_reason). A NaN held-out AUC (insufficient
    holdout rows) must never auto-promote just because there happens to be no prior baseline.
    Delegates to the shared gate in model_promotion.py (also used by movement_predictor.py's
    identical _movement_promotion_decision) -- same comparison, same NaN handling."""
    return decide_promotion_with_nan_guard(test_auc, baseline_test_auc, BREAKOUT_PROMOTION_MARGIN,
                                            metric_name="test AUC")


def train(report_only: bool = False, leak_check: bool = False) -> dict:
    from sklearn.metrics import roc_auc_score  # used by the leak_check closure below

    df = load_labeled_features()
    if df.empty or len(df) < 500:
        print(f"[Breakout] insufficient labeled data ({len(df)} rows); skipping.")
        return {"trained": False, "n": len(df)}

    result = evaluate_purged_cv(df)
    if not result["trained"]:
        return result
    auc, test_auc, base_rate, lift = result["auc"], result["test_auc"], result["base_rate"], result["lift"]
    X, y, spw, cv_df = result["X"], result["y"], result["spw"], result["cv_df"]
    n_folds = 4  # matches evaluate_purged_cv's default; leak_canary below reimplements the same CV shape

    if leak_check:
        from ml_leak_check import leak_canary

        def _oof_auc_only(frame, cols):
            fy = frame["flew"].astype(int).values
            fX = _feature_matrix(frame)
            f_spw = (1 - fy.mean()) / max(fy.mean(), 1e-6)
            f_dates = np.array(sorted(frame["date"].unique()))
            f_oof = np.full(len(fy), np.nan)
            f_block = max(1, (len(f_dates) - EMBARGO) // (n_folds + 1))
            for j in range(1, n_folds + 1):
                f_train_end = f_block * j
                f_val_start = f_train_end + EMBARGO
                f_val_end = f_val_start + f_block
                if f_val_start >= len(f_dates) or f_train_end < 1:
                    continue
                f_tr = frame["date"].isin(set(f_dates[:f_train_end])).values
                f_va = frame["date"].isin(set(f_dates[f_val_start:min(f_val_end, len(f_dates))])).values
                if f_tr.sum() < 200 or f_va.sum() < 50 or len(set(fy[f_tr])) < 2:
                    continue
                fm = _make_model(f_spw)
                fm.fit(fX[f_tr], fy[f_tr])
                f_oof[f_va] = fm.predict_proba(fX[f_va])[:, 1]
            f_mask = ~np.isnan(f_oof)
            if f_mask.sum() < 50 or len(set(fy[f_mask])) < 2:
                return None
            return float(roc_auc_score(fy[f_mask], f_oof[f_mask]))

        canary = leak_canary(cv_df, FEATURE_COLS, _oof_auc_only)
        print(f"[Breakout][LEAK-CHECK] {canary['note']}")

    if report_only:
        return {"trained": False, "n": len(y), "auc": auc, "test_auc": test_auc, "base_rate": base_rate, "lift": lift}

    # Production model: refit the same booster on ALL data (matches the OOF probe).
    prod = _make_model(spw)
    prod.fit(X, y)
    payload = {"models": [prod], "feature_names": list(X.columns),
               "horizon": HORIZON, "trained_at": datetime.date.today().isoformat(),
               "oof_auc": auc, "test_auc": test_auc}
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)

    baseline_test_auc = _load_baseline_test_auc(MODEL_PATH)
    promote, refusal_reason = _breakout_promotion_decision(test_auc, baseline_test_auc)
    if promote:
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(payload, f)
        print(f"[Breakout] PROMOTED (OOF AUC {auc:.4f}, held-out test AUC {test_auc:.4f}, "
              f"baseline {baseline_test_auc}) -> {MODEL_PATH}")
    else:
        with open(CANDIDATE_PATH, "wb") as f:
            pickle.dump(payload, f)
        print(f"[Breakout] REJECTED — {refusal_reason} Candidate saved to {CANDIDATE_PATH}; "
              f"active model at {MODEL_PATH} left untouched.")

    return {"trained": True, "n": len(y), "auc": auc, "test_auc": test_auc, "base_rate": base_rate,
            "lift": lift, "promoted": promote}


def score() -> int:
    """Compute OHLCV features for the latest session and write breakout_probability onto
    that day's technical_signals rows."""
    if not os.path.exists(MODEL_PATH):
        print("[Breakout] no model; run --train first.")
        return 0
    with open(MODEL_PATH, "rb") as f:
        art = pickle.load(f)
    conn = connect()
    cur = conn.cursor()
    try:
        cur.execute(translate("ALTER TABLE technical_signals ADD COLUMN breakout_probability REAL"))
        conn.commit()
    except Exception:
        conn.rollback()

    cutoff = (datetime.date.today() - datetime.timedelta(days=SCORE_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)
    if ohlcv.empty:
        return 0
    feats = compute_ohlcv_features(ohlcv)
    d = feats["date"].max()
    # Score EVERY symbol trading on the latest session; missing rolling features are
    # filled with 0 (same as training's _feature_matrix), so newly-listed names still get
    # a score from whatever features are mature — maximises breakout_probability coverage.
    today = feats[feats["date"] == d]
    if today.empty:
        print(f"[Breakout] no feature rows for {d}.")
        return 0
    X = today[art["feature_names"]].replace([np.inf, -np.inf], np.nan).fillna(0.0).astype(np.float32)
    preds = np.zeros(len(X))
    for m in art["models"]:
        preds += m.predict_proba(X)[:, 1]
    probs = preds / len(art["models"])
    # Only update symbols that already have a technical_signals row for `d`.
    cur.executemany(
        "UPDATE technical_signals SET breakout_probability = ? WHERE symbol = ? AND date = ?",
        [(round(float(p), 4) if np.isfinite(p) else None, s, d)
         for p, s in zip(probs, today["symbol"])],
    )
    conn.commit()
    print(f"[Breakout] scored {len(today)} symbols for {d}.")
    return len(today)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Breakout classifier (Lever #4)")
    parser.add_argument("--train", action="store_true", help="Fit + report purged-OOF AUC")
    parser.add_argument("--report", action="store_true", help="Evaluate only, don't save a model")
    parser.add_argument("--leak-check", action="store_true", help="Run the leak-canary test (re-runs OOF CV on an extra-lagged copy of the features; expensive, opt-in)")
    parser.add_argument("--score", action="store_true", help="Write breakout_probability for latest date")
    args = parser.parse_args()
    if args.train or args.report:
        train(report_only=args.report, leak_check=args.leak_check)
    if args.score:
        score()
    if not (args.train or args.report or args.score):
        train(report_only=True)
