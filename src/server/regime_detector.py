#!/usr/bin/env python3
"""
5-state Gaussian HMM market regime detector.
States: BULL | SIDEWAYS | HIGH_VOL | BEAR | CRASH
Writes daily regime to market_regimes table.
"""

import sys
import json
import sqlite3
import pickle
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from hmmlearn import hmm
from sklearn.preprocessing import StandardScaler

DB_PATH    = Path(__file__).parent.parent.parent / "stock_intelligence.db"
MODEL_DIR  = Path(__file__).parent / "ml_models"
HMM_PATH   = MODEL_DIR / "hmm_regime.pkl"
N_STATES   = 5

# State label assignment (manual, based on emission mean inspection post-training)
# Index → name mapping updated after each retrain
DEFAULT_STATE_LABELS = {0: "BULL", 1: "SIDEWAYS", 2: "HIGH_VOL", 3: "BEAR", 4: "CRASH"}


def _load_hmm_features(con: sqlite3.Connection, lookback_days: int = 756) -> pd.DataFrame:
    """Build 8-feature market-level matrix for HMM training/inference."""
    cutoff = (datetime.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

    # Nifty returns + vol
    nifty = pd.read_sql(
        "SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' AND date>=? ORDER BY date",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )

    df = pd.DataFrame(index=nifty.index)
    df["nifty_ret_21d"]       = nifty["close"].pct_change(21)
    log_ret = np.log(nifty["close"] / nifty["close"].shift(1))
    df["nifty_vol_21d"]       = log_ret.rolling(21).std() * np.sqrt(252)

    # VIX proxy from macro_asset_prices
    vix = pd.read_sql(
        "SELECT date, close FROM macro_asset_prices WHERE symbol='NSEBANK' AND date>=? ORDER BY date",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )
    df["nifty_vix"] = vix["close"].reindex(df.index, method="ffill")

    # FII 5d net normalized
    fii = pd.read_sql(
        "SELECT date, fii_net FROM fii_dii_flow WHERE date>=? ORDER BY date",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )
    fii5 = fii["fii_net"].rolling(5).sum()
    df["fii_5d_net_norm"] = (fii5 - fii5.mean()) / (fii5.std() + 1e-9)
    df["fii_5d_net_norm"] = df["fii_5d_net_norm"].reindex(df.index, method="ffill")

    # Advance/decline ratio from market_sentiment_snapshots
    ad = pd.read_sql(
        "SELECT DATE(snapshot_at) as date, overall_score FROM market_sentiment_snapshots "
        "WHERE snapshot_at>=? ORDER BY snapshot_at",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )
    df["advance_decline_ratio"] = ad["overall_score"].reindex(df.index, method="ffill")

    # Global macro from macro_asset_prices
    for sym, col in [("US10Y", "us10y_chg5d"), ("DXY", "dxy_ret_5d"), ("SP500", "sp500_ret_5d")]:
        macro = pd.read_sql(
            "SELECT date, ret_5d FROM macro_asset_prices WHERE symbol=? AND date>=? ORDER BY date",
            con, params=(sym, cutoff), parse_dates=["date"], index_col="date",
        )
        df[col] = macro["ret_5d"].reindex(df.index, method="ffill")

    return df.dropna()


def train_hmm(lookback_days: int = 1260) -> dict:
    """Train 5-state Gaussian HMM on market features."""
    con = sqlite3.connect(DB_PATH)
    df = _load_hmm_features(con, lookback_days)
    con.close()

    if len(df) < 252:
        return {"error": f"Only {len(df)} rows — need 252 minimum"}

    scaler = StandardScaler()
    X = scaler.fit_transform(df.fillna(0))

    model = hmm.GaussianHMM(
        n_components=N_STATES, covariance_type="full",
        n_iter=200, random_state=42,
    )
    model.fit(X)

    # Assign state labels by inspecting emission means (Nifty return dim = index 0)
    means = model.means_[:, 0]  # nifty_ret_21d mean per state
    order = np.argsort(means)[::-1]  # descending: best return = BULL
    state_labels = {}
    label_seq = ["BULL", "SIDEWAYS", "HIGH_VOL", "BEAR", "CRASH"]
    # Sort by vol (dim 1) within bottom 2 states for BEAR vs CRASH
    for rank, state_idx in enumerate(order):
        state_labels[int(state_idx)] = label_seq[rank]

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with open(HMM_PATH, "wb") as f:
        pickle.dump({"model": model, "scaler": scaler, "state_labels": state_labels}, f)

    print(f"[HMM] Trained on {len(df)} days. State labels: {state_labels}")
    return {"state_labels": state_labels, "n_samples": len(df)}


def update_regime(date: str = None) -> str:
    """Run Viterbi on recent history, write today's regime to market_regimes."""
    if date is None:
        date = datetime.today().strftime("%Y-%m-%d")

    if not HMM_PATH.exists():
        print("[HMM] No model — run --mode train first")
        return "SIDEWAYS"

    with open(HMM_PATH, "rb") as f:
        bundle = pickle.load(f)
    model: hmm.GaussianHMM = bundle["model"]
    scaler: StandardScaler = bundle["scaler"]
    state_labels: dict      = bundle["state_labels"]

    con = sqlite3.connect(DB_PATH)
    df = _load_hmm_features(con, lookback_days=120)  # recent 6 months for inference

    if df.empty:
        con.close()
        return "SIDEWAYS"

    X = scaler.transform(df.fillna(0))
    viterbi_states = model.predict(X)            # most probable state sequence
    fwd_probs      = model.predict_proba(X)      # forward algorithm probabilities

    today_state     = int(viterbi_states[-1])
    today_probs     = fwd_probs[-1]
    today_regime    = state_labels.get(today_state, "SIDEWAYS")
    today_prob      = float(today_probs[today_state])
    viterbi_path    = [state_labels.get(int(s), "SIDEWAYS") for s in viterbi_states[-30:]]

    features_dict = df.iloc[-1].to_dict()

    con.execute(
        """INSERT OR REPLACE INTO market_regimes
           (date, regime, regime_prob, hmm_state, viterbi_path_json, features_json, computed_at)
           VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)""",
        (date, today_regime, today_prob, today_state,
         json.dumps(viterbi_path), json.dumps({k: float(v) if pd.notna(v) else None
                                               for k, v in features_dict.items()})),
    )
    con.commit()
    con.close()

    print(f"[HMM] Regime for {date}: {today_regime} (prob={today_prob:.2f}, state={today_state})")
    return today_regime


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["train", "update"], default="update")
    parser.add_argument("--date", help="Date to classify (default: today)")
    args = parser.parse_args()

    if args.mode == "train":
        result = train_hmm()
        print(f"[HMM] Train result: {result}")
    else:
        regime = update_regime(args.date)
        print(f"[HMM] Done: {regime}")
