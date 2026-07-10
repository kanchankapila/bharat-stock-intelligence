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

RET_THRESHOLD = 0.06     # +6% forward move = breakout
HORIZON = 10             # within the next 10 trading days
MIN_PRICE = 20.0
EMBARGO = HORIZON        # purge `horizon` bars between train and validation folds
LOOKBACK_DAYS = 420
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml_models", "breakout.pkl")


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


# ── training data ────────────────────────────────────────────────────────────

def load_labeled_features(horizon: int = HORIZON) -> pd.DataFrame:
    """technical_signals feature rows joined to the forward breakout label. Only dates old
    enough to have a full forward window are kept."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    ohlcv = read_df(
        "SELECT symbol, date, close FROM stock_ohlcv "
        "WHERE date >= ? AND COALESCE(is_suspect, 0) = 0 ORDER BY date",
        (cutoff,),
    )
    if ohlcv.empty:
        return pd.DataFrame()
    ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.strftime("%Y-%m-%d")
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    labels = build_breakout_labels(close, horizon)
    if labels.empty:
        return pd.DataFrame()

    feats = read_df("SELECT * FROM technical_signals WHERE date >= ?", (cutoff,))
    if feats.empty:
        return pd.DataFrame()
    feats["date"] = feats["date"].astype(str).str[:10]
    df = feats.merge(labels, on=["symbol", "date"], how="inner")
    return df


def _feature_matrix(df: pd.DataFrame):
    from ml_ensemble import build_features
    d = df.copy()
    d["horizon_days"] = HORIZON
    X = build_features(d)
    return X.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def train(report_only: bool = False) -> dict:
    from sklearn.metrics import roc_auc_score
    from ml_ensemble import _base_models

    df = load_labeled_features()
    if df.empty or len(df) < 500:
        print(f"[Breakout] insufficient labeled data ({len(df)} rows); skipping.")
        return {"trained": False, "n": len(df)}

    df = df.sort_values("date").reset_index(drop=True)
    y = df["flew"].astype(int)
    X = _feature_matrix(df)
    base_rate = float(y.mean())
    spw = (1 - base_rate) / max(base_rate, 1e-6)

    # Purged walk-forward OOF AUC — the honest read on whether breakouts are predictable.
    # CRITICAL: purge by DATE, not by row. The label looks forward `horizon` trading days,
    # and each date holds ~170 rows, so a row-based gap (TimeSeriesSplit gap=10) leaves the
    # forward-label windows of adjacent folds massively overlapping -> leakage -> a
    # fantasy AUC. We hold out contiguous date blocks and drop `horizon` embargo dates
    # between train and validation so no training row's forward window touches a val date.
    dates = np.array(sorted(df["date"].unique()))
    oof = np.full(len(y), np.nan)
    n_folds = 4
    if len(dates) < 2 * EMBARGO:
        print(f"[Breakout] only {len(dates)} distinct dates; too few for a purged CV with "
              f"{EMBARGO}-day embargo — treat the AUC as provisional until history grows.")
    block = max(1, (len(dates) - EMBARGO) // (n_folds + 1))
    for i in range(1, n_folds + 1):
        train_end = block * i
        val_start = train_end + EMBARGO
        val_end = val_start + block
        if val_start >= len(dates) or train_end < 1:
            continue
        train_dates = set(dates[:train_end])
        val_dates = set(dates[val_start:min(val_end, len(dates))])
        tr = df["date"].isin(train_dates).values
        va = df["date"].isin(val_dates).values
        if tr.sum() < 200 or va.sum() < 50 or len(set(y[tr])) < 2:
            continue
        models = _base_models(scale_pos_weight=spw)
        va_pred = np.zeros(va.sum())
        for _, m in models:
            m.fit(X[tr], y[tr])
            va_pred += m.predict_proba(X[va])[:, 1]
        oof[va] = va_pred / len(models)
    mask = ~np.isnan(oof)
    if mask.sum() < 50 or len(set(y[mask])) < 2:
        print(f"[Breakout] purged CV left too few validation rows ({int(mask.sum())}); "
              f"need more history (technical_signals only spans {len(dates)} dates).")
        return {"trained": False, "n": len(y), "auc": float("nan"), "base_rate": base_rate}
    auc = float(roc_auc_score(y[mask], oof[mask]))

    # top-decile lift: of the highest-scored decile, how much more often do they break out?
    q = pd.Series(oof[mask])
    top = q >= q.quantile(0.9)
    top_rate = float(y[mask][top.values].mean()) if top.any() else float("nan")
    lift = (top_rate / base_rate) if base_rate > 0 else float("nan")

    print(f"[Breakout] n={len(y)} base_rate={base_rate:.3f} purged-OOF AUC={auc:.4f} "
          f"top-decile breakout rate={top_rate:.3f} (lift {lift:.2f}x)")

    if report_only:
        return {"trained": False, "n": len(y), "auc": auc, "base_rate": base_rate, "lift": lift}

    # Production model = the same base models refit on ALL data; prediction is their
    # average (identical to the OOF probe, so the stored model matches what AUC measured).
    prod_models = _base_models(scale_pos_weight=spw)
    for _, m in prod_models:
        m.fit(X, y)
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump({"models": [m for _, m in prod_models], "feature_names": list(X.columns),
                     "horizon": HORIZON, "trained_at": datetime.date.today().isoformat(),
                     "oof_auc": auc}, f)
    print(f"[Breakout] saved model (OOF AUC {auc:.4f}) → {MODEL_PATH}")
    return {"trained": True, "n": len(y), "auc": auc, "base_rate": base_rate, "lift": lift}


def score() -> int:
    """Write breakout_probability onto technical_signals for the most recent date."""
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

    latest = read_df("SELECT MAX(date) AS d FROM technical_signals")
    if latest.empty or latest.iloc[0]["d"] is None:
        return 0
    d = str(latest.iloc[0]["d"])[:10]
    feats = read_df("SELECT * FROM technical_signals WHERE date = ?", (d,))
    if feats.empty:
        return 0
    X = _feature_matrix(feats)
    for col in art["feature_names"]:
        if col not in X.columns:
            X[col] = 0.0
    X = X[art["feature_names"]].astype(np.float32)
    preds = np.zeros(len(X))
    for m in art["models"]:
        preds += m.predict_proba(X)[:, 1]
    probs = preds / len(art["models"])
    cur.executemany(
        "UPDATE technical_signals SET breakout_probability = ? WHERE symbol = ? AND date = ?",
        [(round(float(p), 4) if np.isfinite(p) else None, s, d)
         for p, s in zip(probs, feats["symbol"])],
    )
    conn.commit()
    print(f"[Breakout] scored {len(feats)} rows for {d}.")
    return len(feats)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Breakout classifier (Lever #4)")
    parser.add_argument("--train", action="store_true", help="Fit + report purged-OOF AUC")
    parser.add_argument("--report", action="store_true", help="Evaluate only, don't save a model")
    parser.add_argument("--score", action="store_true", help="Write breakout_probability for latest date")
    args = parser.parse_args()
    if args.train or args.report:
        train(report_only=args.report)
    if args.score:
        score()
    if not (args.train or args.report or args.score):
        train(report_only=True)
