#!/usr/bin/env python3
"""
5-state Gaussian HMM market regime detector.
States: BULL | SIDEWAYS | HIGH_VOL | BEAR | CRASH
Writes daily regime to market_regimes table.
"""

import sys
import json
import pickle
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from hmmlearn import hmm
from sklearn.preprocessing import StandardScaler

from db_compat import read_df, execute

MODEL_DIR  = Path(__file__).parent / "ml_models"
HMM_PATH   = MODEL_DIR / "hmm_regime.pkl"
N_STATES   = 5

# State label assignment (manual, based on emission mean inspection post-training)
# Index → name mapping updated after each retrain
DEFAULT_STATE_LABELS = {0: "BULL", 1: "SIDEWAYS", 2: "HIGH_VOL", 3: "BEAR", 4: "CRASH"}


def _read_dated(sql: str, params: tuple) -> pd.DataFrame:
    """read_df + normalize the 'date' column to a datetime index (read_df has no parse_dates)."""
    df = read_df(sql, params)
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")


def _load_hmm_features(lookback_days: int = 756,
                        as_of_date: str = None) -> pd.DataFrame:
    """Build 8-feature market-level matrix for HMM training/inference."""
    anchor = as_of_date or datetime.today().strftime("%Y-%m-%d")
    anchor_dt = datetime.strptime(anchor, "%Y-%m-%d")
    cutoff_dt = anchor_dt - timedelta(days=lookback_days)
    # DATE-typed columns (stock_ohlcv, macro_asset_prices) and DATE(snapshot_at)::date on PG
    # need date-object params; the TEXT-typed fii_dii_flow.date needs string params (rule #6).
    cutoff_d, anchor_d = cutoff_dt.date(), anchor_dt.date()
    cutoff_s, anchor_s = cutoff_d.isoformat(), anchor_d.isoformat()

    # Nifty returns + vol
    nifty = _read_dated(
        "SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' AND date>=? AND date<=? ORDER BY date",
        (cutoff_d, anchor_d),
    )

    df = pd.DataFrame(index=nifty.index)
    df["nifty_ret_21d"]       = nifty["close"].pct_change(21)
    log_ret = np.log(nifty["close"] / nifty["close"].shift(1))
    df["nifty_vol_21d"]       = log_ret.rolling(21).std() * np.sqrt(252)

    # VIX proxy from macro_asset_prices
    vix = _read_dated(
        "SELECT date, close FROM macro_asset_prices WHERE symbol='NSEBANK' AND date>=? AND date<=? ORDER BY date",
        (cutoff_d, anchor_d),
    )
    df["nifty_vix"] = vix["close"].reindex(df.index, method="ffill")

    # FII 5d net normalized (sparse — fill 0 when no data); fii_dii_flow.date is TEXT
    fii = _read_dated(
        "SELECT date, fii_net FROM fii_dii_flow WHERE date>=? AND date<=? ORDER BY date",
        (cutoff_s, anchor_s),
    )
    if not fii.empty:
        fii5 = fii["fii_net"].rolling(5, min_periods=1).sum()
        fii_series = (fii5 - fii5.mean()) / (fii5.std() + 1e-9)
        df["fii_5d_net_norm"] = fii_series.reindex(df.index, method="ffill").fillna(0.0)
    else:
        df["fii_5d_net_norm"] = 0.0

    # Advance/decline breadth from our own universe (market_breadth.adv_decline_ratio, 0-1).
    ad = _read_dated(
        "SELECT date, adv_decline_ratio FROM market_breadth WHERE date>=? AND date<=? ORDER BY date",
        (cutoff_s, anchor_s),
    )
    if not ad.empty:
        df["advance_decline_ratio"] = ad["adv_decline_ratio"].reindex(df.index, method="ffill").fillna(0.5)
    else:
        df["advance_decline_ratio"] = 0.5

    # Global macro from macro_asset_prices
    for sym, col in [("US10Y", "us10y_chg5d"), ("DXY", "dxy_ret_5d"), ("SP500", "sp500_ret_5d")]:
        macro = _read_dated(
            "SELECT date, ret_5d FROM macro_asset_prices WHERE symbol=? AND date>=? AND date<=? ORDER BY date",
            (sym, cutoff_d, anchor_d),
        )
        df[col] = macro["ret_5d"].reindex(df.index, method="ffill").fillna(0.0)

    # Drop only rows where core Nifty features are NaN (rolling window warmup)
    return df.dropna(subset=["nifty_ret_21d", "nifty_vol_21d"])


def _assign_state_labels(model) -> dict[int, str]:
    """
    Assign human-readable labels to HMM states.
    Sorts by mean nifty_ret_21d (dim 0) descending (best return = BULL).
    Among the bottom 2 states, assigns CRASH to the higher-volatility one
    (nifty_vol_21d, dim 1) for label-switching resilience across retrains.
    """
    means  = model.means_[:, 0]  # nifty_ret_21d per state
    vols   = model.means_[:, 1]  # nifty_vol_21d per state
    order  = list(np.argsort(means)[::-1])  # descending return

    if len(order) >= 2:
        bottom2 = order[-2:]  # two lowest-return state indices
        # Ensure higher-vol state is last (CRASH), lower-vol is second-to-last (BEAR)
        if vols[bottom2[0]] > vols[bottom2[1]]:
            order[-2], order[-1] = bottom2[1], bottom2[0]

    label_seq = ["BULL", "SIDEWAYS", "HIGH_VOL", "BEAR", "CRASH"]
    return {int(state_idx): label_seq[rank] for rank, state_idx in enumerate(order)}


def train_hmm(lookback_days: int = 1260) -> dict:
    """Train 5-state Gaussian HMM on market features."""
    df = _load_hmm_features(lookback_days)

    if len(df) < 252:
        return {"error": f"Only {len(df)} rows — need 252 minimum"}

    scaler = StandardScaler()
    X = scaler.fit_transform(df.fillna(0))

    model = hmm.GaussianHMM(
        n_components=N_STATES, covariance_type="full",
        n_iter=200, random_state=42,
    )
    model.fit(X)

    state_labels = _assign_state_labels(model)

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

    df = _load_hmm_features(lookback_days=120, as_of_date=date)  # recent 6 months for inference

    if df.empty:
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

    execute(
        """INSERT INTO market_regimes
           (date, regime, regime_prob, hmm_state, viterbi_path_json, features_json, computed_at)
           VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(date) DO UPDATE SET
             regime=excluded.regime, regime_prob=excluded.regime_prob,
             hmm_state=excluded.hmm_state, viterbi_path_json=excluded.viterbi_path_json,
             features_json=excluded.features_json, computed_at=CURRENT_TIMESTAMP""",
        (date, today_regime, today_prob, today_state,
         json.dumps(viterbi_path), json.dumps({k: float(v) if pd.notna(v) else None
                                               for k, v in features_dict.items()})),
    )

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
