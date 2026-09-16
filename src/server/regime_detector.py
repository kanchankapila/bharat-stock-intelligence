#!/usr/bin/env python3
"""
5-state Gaussian HMM market regime detector.
States: BULL | SIDEWAYS | HIGH_VOL | BEAR | CRASH
Writes daily regime to market_regimes table.
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

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
# Sticky Dirichlet prior on the transition matrix diagonal: without this, a 5-state/full-
# covariance HMM fit on ~1200 daily rows with only 8 features is overparameterized (44 params/
# state) and readily finds a spurious local optimum where two states with nearly-identical means
# (e.g. two flavors of "calm, mildly-positive" market) get connected by a near-deterministic
# alternation instead of being one persistent regime -- literally 0% self-transition, so the
# Viterbi path flips between them every single trading day regardless of what the market actually
# did. Live-confirmed 2026-08-09: this happened for real (states labeled HIGH_VOL/BEAR had
# transmat_[i][i]==0 and near-identical means -- ret~+0.5%, vol~12%, VIX~14, i.e. not bearish or
# high-vol at all), and dominated 410 of 686 historical days (60%). A real market regime persists
# for at least a few days; this prior encodes that as a soft bias, not a hard constraint.
MIN_SELF_TRANSITION = 0.5  # expected regime duration >= 2 days; below this, reject the model
STICKY_PRIOR_WEIGHT = 15.0
# EM restarts for train_hmm(). Fixed list, not random, so a retrain stays reproducible.
RESTART_SEEDS = (42, 0, 1, 7, 123, 2024)


class NoRegimeData(Exception):
    """Raised when _load_hmm_features returns nothing for a date -- distinguishes a genuine
    "no data available" condition from the SIDEWAYS regime label (both used to be represented
    by the same string, so update_regime()'s daily cron could silently return "SIDEWAYS" and
    exit 0 without ever touching market_regimes -- indistinguishable from a real, correctly-
    computed SIDEWAYS day in every monitoring signal. See the 2026-08 job-health investigation:
    market_regimes' MAX(computed_at) was found frozen for weeks with no error anywhere."""

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

    # India VIX from macro_asset_prices (written daily by global_macro_fetcher.py as 'INDIAVIX')
    vix = _read_dated(
        "SELECT date, close FROM macro_asset_prices WHERE symbol='INDIAVIX' AND date>=? AND date<=? ORDER BY date",
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
    Sorts by mean nifty_ret_21d (dim 0) descending (best return = BULL, worst = CRASH-or-BEAR).
    Two vol-based (nifty_vol_21d, dim 1) swaps then correct the two positions whose *name*
    makes a volatility claim the raw return-rank alone doesn't verify:
      - Among the bottom 2 (BEAR/CRASH candidates), CRASH must be the higher-vol one.
      - Among the middle 2 (SIDEWAYS/HIGH_VOL candidates), HIGH_VOL must be the higher-vol one.
    Live-caught 2026-08-09: without the second swap, a real retrain produced "SIDEWAYS" with
    HIGHER vol (11.4%) than "HIGH_VOL" (8.5%) -- exactly backwards, because pure return-rank
    says nothing about which of two similarly-performing states is actually the choppy one.
    BULL is left alone (best return = BULL regardless of its own volatility, matching how the
    bottom-2 swap never changes which state is "worst return" -- only CRASH vs BEAR's order).
    """
    means  = model.means_[:, 0]  # nifty_ret_21d per state
    vols   = model.means_[:, 1]  # nifty_vol_21d per state
    order  = list(np.argsort(means)[::-1])  # descending return

    if len(order) >= 2:
        bottom2 = order[-2:]  # two lowest-return state indices
        # Ensure higher-vol state is last (CRASH), lower-vol is second-to-last (BEAR)
        if vols[bottom2[0]] > vols[bottom2[1]]:
            order[-2], order[-1] = bottom2[1], bottom2[0]

    if len(order) >= 4:
        mid2 = order[1:3]  # SIDEWAYS/HIGH_VOL candidate indices (ranks 1, 2)
        # Ensure higher-vol state is HIGH_VOL (rank 2), lower-vol is SIDEWAYS (rank 1)
        if vols[mid2[0]] > vols[mid2[1]]:
            order[1], order[2] = mid2[1], mid2[0]

    label_seq = ["BULL", "SIDEWAYS", "HIGH_VOL", "BEAR", "CRASH"]
    return {int(state_idx): label_seq[rank] for rank, state_idx in enumerate(order)}


def _log_likelihood_per_sample(model, scaler, X_raw: np.ndarray) -> float:
    """Average per-sample log-likelihood of raw (unscaled) rows under (model, scaler).

    Comparing two GaussianHMMs fit with DIFFERENT StandardScalers (e.g. the currently-active
    model vs. a freshly retrained one) by their raw `model.score()` isn't apples-to-apples --
    each scaler's own fitted std shifts the density by a Jacobian term
    (x' = (x-mean)/scale => dx'/dx = 1/scale => log|det J| = -sum(log(scale_i)) per sample), so
    a model whose training window happened to have larger feature variance would score itself
    as "better" purely from that constant, unrelated to fit quality. This undoes the Jacobian
    so both models are compared on the same raw density.
    """
    if len(X_raw) == 0:
        return float("-inf")
    ll_scaled = model.score(scaler.transform(X_raw))  # sum log-lik in transformed space
    jacobian = len(X_raw) * float(np.sum(np.log(scaler.scale_)))
    return (ll_scaled - jacobian) / len(X_raw)


def train_hmm(lookback_days: int = 1260, holdout_days: int = 60, force: bool = False) -> dict:
    """Train 5-state Gaussian HMM on market features.

    Champion/challenger gate (2026-08-01 audit): this model's daily label drives
    REGIME_WEIGHTS in unified_ranker.py -- the largest single blend-switch in the whole
    ranker -- but train_hmm() unconditionally overwrote hmm_regime.pkl with no held-out
    comparison, no model_registry entry, and no stability check, unlike every sibling ML file
    in this codebase (ml_ensemble.py, cs_ranker.py, movement_predictor.py, ...), which all
    already gate on a held-out metric. Scores the trailing `holdout_days` under BOTH the
    currently-active model and the freshly-retrained one (see _log_likelihood_per_sample for
    why the comparison needs a Jacobian correction) and only overwrites the live file if the
    new model doesn't regress; a regression is written to hmm_regime.pkl.candidate instead so
    it's inspectable without touching the live model. --force skips the gate (e.g. first-ever
    train, or a deliberate relabeling after DEFAULT_STATE_LABELS changed).
    """
    df = _load_hmm_features(lookback_days)

    if len(df) < 252:
        return {"error": f"Only {len(df)} rows — need 252 minimum"}

    effective_holdout = holdout_days if len(df) > holdout_days + 252 else 0
    train_df = df.iloc[:-effective_holdout] if effective_holdout else df
    holdout_df = df.iloc[-effective_holdout:] if effective_holdout else None

    scaler = StandardScaler()
    X = scaler.fit_transform(train_df.fillna(0))

    transmat_prior = np.ones((N_STATES, N_STATES)) + np.eye(N_STATES) * STICKY_PRIOR_WEIGHT

    # Multiple random restarts, keeping the best fit by TRAINING log-likelihood.
    #
    # EM converges to a local optimum, and for this panel the choice of seed moves the holdout
    # score by more than the champion/challenger gap the gate below is trying to measure.
    # Measured 2026-08-11 on the live 832x8 panel, holdout per-sample ll by seed:
    #   42 -> 9.95 | 0 -> 10.12 | 1 -> 9.98 | 7 -> 11.17 | 123 -> 10.87 | 2024 -> 10.75
    # against an incumbent at 11.02. So the hardcoded random_state=42 was not "the" retrained
    # model, it was one draw from a spread that straddles the champion -- the gate's verdict was
    # decided by seed luck rather than by whether the new model is better. One seed also drew a
    # non-converging fit ("Model is not converging", seed 0).
    #
    # Selection is on the TRAIN objective, never the holdout: picking restarts by holdout score
    # would be choosing on the very metric the promotion gate then uses, which is how a gate
    # gets gamed into promoting an overfit model. Best-of-N by training likelihood is just
    # standard EM restart practice; the gate below stays an honest out-of-sample test.
    best_model, best_train_ll = None, -np.inf
    for seed in RESTART_SEEDS:
        candidate = hmm.GaussianHMM(
            n_components=N_STATES, covariance_type="full",
            transmat_prior=transmat_prior,
            n_iter=200, random_state=seed,
        )
        candidate.fit(X)
        train_ll = candidate.score(X) / len(X)
        if train_ll > best_train_ll:
            best_model, best_train_ll = candidate, train_ll
    model = best_model
    print(f"[HMM] Best of {len(RESTART_SEEDS)} restarts by train ll/sample: {best_train_ll:.4f}")

    state_labels = _assign_state_labels(model)

    min_self_transition = float(np.min(np.diag(model.transmat_)))
    if min_self_transition < MIN_SELF_TRANSITION and not force:
        worst_state = int(np.argmin(np.diag(model.transmat_)))
        decision = {
            "promoted": False,
            "reason": f"degenerate transition matrix: state {worst_state} "
                      f"({state_labels.get(worst_state)}) has self-transition "
                      f"{min_self_transition:.3f} < {MIN_SELF_TRANSITION} -- not a persistent regime",
        }
    else:
        decision = {"promoted": True, "reason": "forced" if force else "no_prior_model_or_no_holdout"}
        if holdout_df is not None and not holdout_df.empty and HMM_PATH.exists() and not force:
            holdout_raw = holdout_df.fillna(0).values
            new_ll = _log_likelihood_per_sample(model, scaler, holdout_raw)
            try:
                with open(HMM_PATH, "rb") as f:
                    prior = pickle.load(f)
                old_ll = _log_likelihood_per_sample(prior["model"], prior["scaler"], holdout_raw)
                decision = {
                    "promoted": new_ll >= old_ll,
                    "reason": f"new_ll={new_ll:.4f} vs old_ll={old_ll:.4f}",
                    "new_ll": new_ll, "old_ll": old_ll,
                }
            except Exception as e:
                print(f"[HMM] Could not load prior model for comparison, promoting: {e}")

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"model": model, "scaler": scaler, "state_labels": state_labels}
    target = HMM_PATH if decision["promoted"] else HMM_PATH.parent / (HMM_PATH.name + ".candidate")
    with open(target, "wb") as f:
        pickle.dump(payload, f)

    print(f"[HMM] Trained on {len(train_df)} days (holdout={effective_holdout}). "
          f"State labels: {state_labels}. Promotion: {decision}")
    return {"state_labels": state_labels, "n_samples": len(train_df), "promotion": decision}


def _label_day(model, scaler, state_labels: dict, date: str, publish_live: bool = True) -> str:
    """Causal single-day regime label: Viterbi over a trailing 120-day window ending at
    `date`, and only `date`. Shared by update_regime (live) and backfill_regimes (looped
    per day) so both paths use identical, leak-free logic -- neither ever lets a later
    date's observations influence an earlier date's label.
    """
    df = _load_hmm_features(lookback_days=120, as_of_date=date)  # recent 6 months for inference
    if df.empty:
        raise NoRegimeData(f"no HMM features available for {date} (empty _load_hmm_features)")

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

    if publish_live:
        # Publish live regime to app_settings so ML ensemble, queues, and the technical-signals
        # scanner can gate dynamically without manual wiring. Skipped during backfill_regimes'
        # per-day loop so relabeling past dates doesn't clobber this with a stale historical value.
        execute(
            """INSERT INTO app_settings (key, value)
               VALUES ('current_nifty_regime', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
            (today_regime,),
        )
        print(f"[HMM] Published current_nifty_regime={today_regime} to app_settings")

    print(f"[HMM] Regime for {date}: {today_regime} (prob={today_prob:.2f}, state={today_state})")
    return today_regime


def update_regime(date: str = None) -> str:
    """Run Viterbi on recent history, write today's regime to market_regimes, and
    publish it live to app_settings."""
    if date is None:
        date = datetime.today().strftime("%Y-%m-%d")

    if not HMM_PATH.exists():
        # Was: print + `return "SIDEWAYS"` -- a clean exit 0 that never touches market_regimes,
        # indistinguishable from a real day's write in job_heartbeat/BullMQ. This is the live
        # daily cron path (dl-regime-daily), not backfill, so a missing model is a real
        # operational problem that must surface as a failed job, not a silent no-op.
        raise RuntimeError("[HMM] No model at " + str(HMM_PATH) + " — run --mode train first")

    with open(HMM_PATH, "rb") as f:
        bundle = pickle.load(f)
    return _label_day(bundle["model"], bundle["scaler"], bundle["state_labels"], date, publish_live=True)


def backfill_regimes(start_date: str, end_date: str) -> int:
    """Label every trading day in [start_date, end_date], one causal day at a time.

    Each day is decoded from ONLY a trailing 120-day window ending at that day (identical
    discipline to update_regime) -- never a single joint Viterbi pass over the whole
    [start_date, end_date] range. Viterbi finds the single best STATE SEQUENCE for whatever
    window it's given, so decoding the full range in one shot let a later date's
    observations shape an earlier date's label -- a real look-ahead leak for any consumer
    that reads market_regimes as an entry-time feature (e.g. ml_ensemble.py's nifty_regime).
    """
    if not HMM_PATH.exists():
        print("[HMM] No model — run --mode train first")
        return 0
    with open(HMM_PATH, "rb") as f:
        bundle = pickle.load(f)
    model, scaler, state_labels = bundle["model"], bundle["scaler"], bundle["state_labels"]

    trading_days = _read_dated(
        "SELECT date FROM stock_ohlcv WHERE symbol='NIFTY50' AND date>=? AND date<=? ORDER BY date",
        (start_date, end_date),
    ).index
    if len(trading_days) == 0:
        print("[HMM] no trading days in range")
        return 0

    n = 0
    skipped = 0
    for ts in trading_days:
        d = ts.strftime("%Y-%m-%d")
        try:
            _label_day(model, scaler, state_labels, d, publish_live=False)
            n += 1
        except NoRegimeData:
            # Unlike update_regime()'s live daily path, a single date missing its trailing
            # 120-day feature window during a long historical backfill (e.g. near the start
            # of stock_ohlcv's own history) is expected, not an operational failure -- skip
            # just that day and keep going, don't abort the whole backfill.
            skipped += 1
    print(f"[HMM] backfilled {n} regime days {start_date}..{end_date} (causal, day-by-day)"
          + (f", skipped {skipped} with no feature data" if skipped else ""))
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["train", "update", "backfill"], default="update")
    parser.add_argument("--date", help="Date to classify (default: today)")
    parser.add_argument("--start", help="Backfill start date (YYYY-MM-DD)")
    parser.add_argument("--end", help="Backfill end date (YYYY-MM-DD)")
    parser.add_argument("--force", action="store_true", help="Skip the promotion gate")
    args = parser.parse_args()

    if args.mode == "train":
        result = train_hmm(force=args.force)
        print(f"[HMM] Train result: {result}")
    elif args.mode == "backfill":
        rows = backfill_regimes(args.start, args.end)
        print(f"[HMM] Done: backfilled {rows} days")
    else:
        regime = update_regime(args.date)
        print(f"[HMM] Done: {regime}")

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
