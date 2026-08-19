#!/usr/bin/env python3
"""
Flyer Classifier — purged-CV successor to high_flyer_retrospective.py's rejected heuristic
============================================================================================
high_flyer_retrospective.py already reverse-engineers real 1-day "flyers" (big up-move on
volume, or a fresh 52-week high) and learns a per-precursor lift score from a rolling 60
sessions. A 2026-07-10 walk-forward validation of that heuristic candidate list found ZERO
return alpha (next-day +0.025%/day, t=0.19) — the lift score captures flyer INCIDENCE (who
flies), not TIMING (when). Its own conclusion, never acted on: "Principled next step: use
the flyer label as an ML classification target ... (purged-CV infra exists)." This is that
model, as its own file mirroring breakout_classifier.py's shape and lifecycle exactly,
rather than bolted onto ml_ensemble.py's already-large surface.

Label = high_flyer_retrospective's own detect_flyers() definition, via its own imported
constants (never re-derived, so this can't silently drift from the live daily job's
definition of "flyer") — vectorized across full history instead of one day at a time
(detect_flyers is O(n) per call via .ffill() over the whole trailing frame; looping it
per day over ~1400 trading days is too slow for training). test_flyer_classifier.py
cross-checks the vectorized boolean output against detect_flyers() directly.

Features = breakout_classifier.py's own OHLCV factor set, reused unchanged (not
duplicated) — a related "will this stock pop" question, already independently vetted.
Taken as of the PRIOR session relative to the label day: pairing same-day features with
the label would trivially leak it (dist_52w_high computed on the flyer day itself is ~0
by construction on a new-high flyer).

Advisory-only, same as breakout_classifier was before it earned its way into
unified_ranker's blend: writes technical_signals.flyer_probability. Per this platform's
own hard-won discipline (five prior audit passes on exactly this kind of thing), it is NOT
wired into unified_ranker.py in this file — only after real held-out AND live edge is
demonstrated, the same bar breakout_classifier had to clear first.

VERDICT 2026-08-10 — IT DID NOT CLEAR THAT BAR. DO NOT WIRE THIS IN, AND DO NOT SCHEDULE IT.
------------------------------------------------------------------------------------------
scripts/flyer_return_alpha_backtest.py was run over the full walk-forward out-of-sample set
(766,199 scored rows, 475 distinct dates, every score from a model that never trained on the
date it is scoring). Ranking the tradeable universe by flyer_probability is not merely
unproven — it is significantly NEGATIVE:

    cross-sectional Spearman IC (oof_prob vs open->close):  -0.0410   t=-9.02   473 days
    top-20 basket vs universe @ 0.00% cost:                 -0.0504%/day  t=-1.35
    top-20 basket vs universe @ 0.15% cost:                 -0.2004%/day  t=-5.36
    top-20 basket vs universe @ 0.25% cost:                 -0.3004%/day  t=-8.03

The purged-OOF AUC is 0.81 and the held-out test AUC is 0.81. That is the whole point of the
go/no-go script and the reason this block exists: a high AUC here means the model is good at
identifying WHO flies, and says nothing about WHEN — exactly the incidence-not-timing failure
the 2026-07-10 walk-forward already found in high_flyer_retrospective.py's heuristic
predecessor, reproduced by its ML successor. An AUC of 0.81 read on its own is a trap.

Consequently this file is deliberately left UNSCHEDULED (it appears in no queues.ts /
jobs/*.ts chain), and flyer_probability is in densify_feature_matrix.NEVER_FILL so its
residue cannot be forward-filled into the ML feature matrix. Re-run the backtest before
reconsidering; the verdict is also persisted to app_settings.flyer_classifier_backtest.

Run:
    python flyer_classifier.py --train    # fit + report purged-OOF AUC
    python flyer_classifier.py --report   # evaluate only, don't save a model
    python flyer_classifier.py --score    # write flyer_probability for latest date
"""

import argparse
import datetime
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import connect, read_df, translate
from model_promotion import decide_promotion_with_nan_guard, file_staleness_override_applies
from breakout_classifier import compute_ohlcv_features, _load_ohlcv, _make_model, evaluate_purged_cv
from high_flyer_retrospective import (
    RET_THRESHOLD as FLYER_RET_THRESHOLD,
    VOL_RATIO_THRESHOLD as FLYER_VOL_RATIO_THRESHOLD,
    MIN_PRICE as FLYER_MIN_PRICE,
    MIN_BARS as FLYER_MIN_BARS,
)

# Judgment call: the label's own horizon is 1 day, but a "new 52w high" flag tends to
# persist across several sessions once a name starts running, making adjacent-day rows
# highly correlated beyond the single-day horizon itself. 5 sessions mirrors this
# codebase's other short-daily-label purge convention (cs_ranker.py's 5-day gap) rather
# than inventing a new number for a case that's genuinely a judgment call either way.
EMBARGO = 5
TRAIN_LOOKBACK_DAYS = 2000    # ~5.5y, same as breakout_classifier
SCORE_LOOKBACK_DAYS = 600
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml_models", "flyer.pkl")
CANDIDATE_PATH = MODEL_PATH + ".candidate"
FLYER_PROMOTION_MARGIN = 0.005   # same margin as every other model_promotion.py consumer


# ── label + feature alignment ───────────────────────────────────────────────

def build_flyer_labels(close: pd.DataFrame, volume: pd.DataFrame) -> pd.DataFrame:
    """Long frame (symbol, date, flew), vectorized equivalent of
    high_flyer_retrospective.detect_flyers() across every date at once. Uses that module's
    own threshold constants (imported, not re-derived) so the two can't drift apart."""
    ret = close.ffill().pct_change()
    vol_avg20 = volume.shift(1).rolling(20).mean()
    vol_ratio = volume / vol_avg20.where(vol_avg20 > 0)
    high_252_prior = close.shift(1).rolling(252, min_periods=1).max()
    new_high = (close > high_252_prior) & (ret > 0)
    enough_hist = close.notna().expanding().sum() >= FLYER_MIN_BARS
    is_flyer = enough_hist & (close >= FLYER_MIN_PRICE) & (
        ((ret >= FLYER_RET_THRESHOLD) & (vol_ratio >= FLYER_VOL_RATIO_THRESHOLD)) | new_high
    )
    long = is_flyer.astype(int).stack(future_stack=True).rename("flew").reset_index()
    long.columns = ["date", "symbol", "flew"]
    return long[["symbol", "date", "flew"]]


def _prev_trading_day_map(dates: list) -> dict:
    """date -> the immediately preceding date in the given trading calendar. The anti-leak
    mechanism: label(date) must only ever be paired with feat_date = prev_trading_day(date),
    never date itself."""
    dates = sorted(dates)
    return dict(zip(dates[1:], dates[:-1]))


def load_labeled_features() -> pd.DataFrame:
    """OHLCV-derived features (as of the PRIOR session) joined to the flyer label, over the
    full backfilled history."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=TRAIN_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)   # breakout_classifier's loader — same survivorship fill
    if ohlcv.empty:
        return pd.DataFrame()
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    volume = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()
    labels = build_flyer_labels(close, volume)
    if labels.empty:
        return pd.DataFrame()

    prev_of = _prev_trading_day_map(list(close.index))
    labels = labels[labels["date"].isin(prev_of)].copy()
    labels["feat_date"] = labels["date"].map(prev_of)

    feats = compute_ohlcv_features(ohlcv).rename(columns={"date": "feat_date"})
    df = labels.merge(feats, on=["symbol", "feat_date"], how="inner")
    feature_cols = [c for c in feats.columns if c not in ("symbol", "feat_date")]
    return df.dropna(subset=feature_cols, how="any").reset_index(drop=True)


def _load_baseline_test_auc(model_path: str) -> float | None:
    """Mirrors breakout_classifier.py's helper of the same name."""
    if not os.path.exists(model_path):
        return None
    try:
        with open(model_path, "rb") as f:
            existing = pickle.load(f)
        return existing.get("test_auc")
    except Exception as e:
        print(f"[Flyer] Could not read existing model at {model_path} for comparison "
              f"({e}) -- treating as no baseline.")
        return None


def _load_baseline_metrics(model_path: str) -> dict | None:
    """Full baseline dict (not just test_auc) -- needed for the staleness-override rejection
    bookkeeping (first_rejected_at/rejection_count, ml-promotion-gate-review 2026-08-15).
    Mirrors breakout_classifier.py's helper of the same name."""
    if not os.path.exists(model_path):
        return None
    try:
        with open(model_path, "rb") as f:
            return pickle.load(f)
    except Exception:
        return None


def _promote_or_reject_flyer(payload: dict, test_auc: float, auc: float) -> bool:
    """Mirrors breakout_classifier.py's _promote_or_reject_breakout -- see that function's
    docstring for the full staleness-override contract. Extracted from train() for testability."""
    baseline = _load_baseline_metrics(MODEL_PATH)
    baseline_test_auc = baseline.get("test_auc") if baseline else None
    promote, refusal_reason = decide_promotion_with_nan_guard(
        test_auc, baseline_test_auc, FLYER_PROMOTION_MARGIN, metric_name="test AUC")

    staleness_override, age_days, rejection_count = (False, 0.0, 0)
    if not promote:
        staleness_override, age_days, rejection_count = file_staleness_override_applies(baseline)

    if promote or staleness_override:
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(payload, f)
        if staleness_override and not promote:
            print(f"[Flyer] STALENESS OVERRIDE — baseline unbeaten {age_days:.1f}d across "
                  f"{rejection_count} rejections ({refusal_reason}) -- promoting anyway -> {MODEL_PATH}")
        else:
            print(f"[Flyer] PROMOTED (OOF AUC {auc:.4f}, held-out test AUC {test_auc:.4f}, "
                  f"baseline {baseline_test_auc}) -> {MODEL_PATH}")
        return True

    if baseline is not None:
        baseline["rejection_count"] = rejection_count + 1
        baseline.setdefault("first_rejected_at", datetime.datetime.now().isoformat())
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(baseline, f)
    with open(CANDIDATE_PATH, "wb") as f:
        pickle.dump(payload, f)
    print(f"[Flyer] REJECTED — {refusal_reason} Candidate saved to {CANDIDATE_PATH}; "
          f"active model at {MODEL_PATH} left untouched (rejection bookkeeping updated: "
          f"{rejection_count + 1} rejections so far).")
    return False


def train(report_only: bool = False) -> dict:
    df = load_labeled_features()
    if df.empty or len(df) < 500:
        print(f"[Flyer] insufficient labeled data ({len(df)} rows); skipping.")
        return {"trained": False, "n": len(df)}

    result = evaluate_purged_cv(df, embargo=EMBARGO)
    if not result["trained"]:
        return result
    auc, test_auc, base_rate, lift = result["auc"], result["test_auc"], result["base_rate"], result["lift"]
    X, y, spw = result["X"], result["y"], result["spw"]

    if report_only:
        return {"trained": False, "n": len(y), "auc": auc, "test_auc": test_auc,
                "base_rate": base_rate, "lift": lift}

    prod = _make_model(spw)
    prod.fit(X, y)
    payload = {"models": [prod], "feature_names": list(X.columns),
               "trained_at": datetime.date.today().isoformat(),
               "oof_auc": auc, "test_auc": test_auc}
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    promoted = _promote_or_reject_flyer(payload, test_auc, auc)

    return {"trained": True, "n": len(y), "auc": auc, "test_auc": test_auc, "base_rate": base_rate,
            "lift": lift, "promoted": promoted}


def score() -> int:
    """Compute OHLCV features as of the latest completed session and write flyer_probability
    onto the FOLLOWING session's technical_signals rows. Advisory-only column — nothing
    reads it yet.

    Date-alignment fix (2026-08-19, found tracing an IC finding end-to-end): the model is
    trained on features(feat_date) -> label(flew on the NEXT trading day, see
    load_labeled_features's feat_date = prev_trading_day(label date)) -- so a prediction made
    from today's close is a forecast for TOMORROW, not today. This used to write under `d`
    (the feature date itself), mislabeling every live-scored row by one trading day. Fixed to
    look up the real next technical_signals date from the DB (not a calendar computation --
    NSE holidays make "d+1 calendar day" wrong) and write there instead; harmless today since
    score() has zero consumers and was never scheduled."""
    if not os.path.exists(MODEL_PATH):
        print("[Flyer] no model; run --train first.")
        return 0
    with open(MODEL_PATH, "rb") as f:
        art = pickle.load(f)
    conn = connect()
    cur = conn.cursor()
    try:
        cur.execute(translate("ALTER TABLE technical_signals ADD COLUMN flyer_probability REAL"))
        conn.commit()
    except Exception:
        conn.rollback()

    cutoff = (datetime.date.today() - datetime.timedelta(days=SCORE_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)
    if ohlcv.empty:
        return 0
    feats = compute_ohlcv_features(ohlcv)
    d = feats["date"].max()
    today = feats[feats["date"] == d]
    if today.empty:
        print(f"[Flyer] no feature rows for {d}.")
        return 0

    row = cur.execute(translate(
        "SELECT MIN(date) FROM technical_signals WHERE date > ?"), (d,)).fetchone()
    d_next = row[0] if row and row[0] else None
    if not d_next:
        print(f"[Flyer] no technical_signals row exists yet for the session after {d} -- "
              f"a prediction from {d}'s close describes tomorrow, and tomorrow's row hasn't "
              f"been created. Nothing to write to; skipping.")
        return 0

    X = today[art["feature_names"]].replace([np.inf, -np.inf], np.nan).fillna(0.0).astype(np.float32)
    preds = np.zeros(len(X))
    for m in art["models"]:
        preds += m.predict_proba(X)[:, 1]
    probs = preds / len(art["models"])
    cur.executemany(
        "UPDATE technical_signals SET flyer_probability = ? WHERE symbol = ? AND date = ?",
        [(round(float(p), 4) if np.isfinite(p) else None, s, d_next)
         for p, s in zip(probs, today["symbol"])],
    )
    conn.commit()
    print(f"[Flyer] scored {len(today)} symbols for {d_next} (features as of {d}).")
    return len(today)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Flyer classifier — purged-CV successor to the rejected precursor-lift heuristic")
    parser.add_argument("--train", action="store_true", help="Fit + report purged-OOF AUC")
    parser.add_argument("--report", action="store_true", help="Evaluate only, don't save a model")
    parser.add_argument("--score", action="store_true", help="Write flyer_probability for latest date")
    args = parser.parse_args()
    if args.train or args.report:
        train(report_only=args.report)
    if args.score:
        score()
    if not (args.train or args.report or args.score):
        train(report_only=True)