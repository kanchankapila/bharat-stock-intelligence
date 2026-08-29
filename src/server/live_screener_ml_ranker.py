#!/usr/bin/env python3
"""
Live Screener ML Ranker
========================
The existing live_screener_optimizer.py finds good filter COMBINATIONS via a shallow
decision tree (max_depth=3) — useful for humans picking a strategy, but coarse: it can't
weigh a stock's own change_per/volume at match time, and it only ever activates the
newest tree unconditionally (no protection against a retrain that's actually worse).

This engine trains a single gradient-boosted classifier over the same NiftyTrader
filter-match data to predict P(same-day win) per (date, symbol), gated behind a
promotion check so a retrain that scores worse than the currently-active model never
replaces it (the underlying model_registry-less version of the ensemble.pkl promotion
bar in ml_ensemble.py).

Run:
    python live_screener_ml_ranker.py --train   # fit + honest held-out AUC, promote or reject
    python live_screener_ml_ranker.py --score   # write win_probability for the latest collection cycle
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode
import argparse
import datetime
import json
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import execute, executemany, query_one, read_df
from model_promotion import clears_promotion_bar, file_staleness_override_applies
import sys

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml_models", "live_screener_intraday_clf.pkl")
CANDIDATE_PATH = MODEL_PATH.replace(".pkl", "_candidate.pkl")

MIN_SAMPLES = 150          # minimum resolved (date, symbol) rows before training at all
MIN_DATES = 10             # minimum distinct trading days for an honest chronological split
TEST_FRAC = 0.2            # most recent 20% of dates held out, untouched by CV
PROMOTION_MARGIN = 0.01    # new held-out AUC must beat the active model's by this much

# ── Live-edge check (added 2026-07-31 after the intraday audit) ───────────────
# Held-out AUC only justifies promotion if it TRANSFERS. Measured against realised outcomes,
# the deployed model's live AUC was 0.3778 over 47,559 scored-and-resolved rows -- not merely
# skill-less but anti-predictive: its highest-confidence picks systematically underperformed.
# (An independent check over five sessions of 15m bars agreed: AUC 0.4962, daily rank IC
# -0.0017, and the top win_probability quintile was the worst-returning one.) The model is
# trained on live-screener filter-match features, which are momentum-flavoured, and momentum
# has a NEGATIVE cross-sectional IC intraday -- so the family is learning the wrong side.
#
# While live AUC sits below LIVE_AUC_FLOOR, a small held-out improvement is not evidence of
# anything: it is movement in a metric already shown not to transfer. Promotion therefore
# requires a much larger held-out gain (STRICT_PROMOTION_MARGIN) rather than being blocked
# outright -- blocking would freeze the current, worse model permanently in place.
LIVE_AUC_FLOOR = 0.52          # below this, the deployed family has no demonstrated live edge
LIVE_AUC_MIN_ROWS = 500        # below this the live estimate is too noisy to act on
STRICT_PROMOTION_MARGIN = 0.05  # required held-out gain while live edge is unproven


def _live_auc() -> tuple:
    """(auc, n_rows) for the DEPLOYED model's stored probabilities against realised outcomes.

    Grades what actually shipped -- live_screener_ml_scores joined through the appearance it
    scored to that appearance's realised same-day return -- rather than anything computed at
    training time. Returns (None, 0) when there is not enough resolved history.
    """
    try:
        df = read_df("""
            SELECT s.win_probability AS wp, o.return_intraday AS ret
            FROM live_screener_ml_scores s
            JOIN live_screener_appearances a ON a.run_id = s.run_id AND a.symbol = s.symbol
            JOIN live_screener_outcomes o ON o.appearance_id = a.id
            WHERE o.return_intraday IS NOT NULL AND s.win_probability IS NOT NULL
        """)
    except Exception as e:
        print(f"[LiveScreenerMLRanker] live-AUC lookup failed: {str(e)[:100]}", file=sys.stderr)
        return None, 0
    if df is None or df.empty or len(df) < LIVE_AUC_MIN_ROWS:
        return None, 0 if df is None or df.empty else len(df)
    y = (pd.to_numeric(df["ret"], errors="coerce") > 0).astype(int)
    wp = pd.to_numeric(df["wp"], errors="coerce")
    ok = wp.notna()
    y, wp = y[ok], wp[ok]
    if y.nunique() < 2:
        return None, int(len(y))   # single-class window -- AUC undefined
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score(y, wp)), int(len(y))


# ── feature construction ──────────────────────────────────────────────────────

def _load_training_frame() -> pd.DataFrame:
    return read_df("""
        SELECT o.symbol, o.filter_key, o.appeared_at, a.run_id, o.return_intraday,
               a.change_per, a.volume, r.created_at AS run_ts
        FROM live_screener_outcomes o
        JOIN live_screener_appearances a ON a.id = o.appearance_id
        JOIN live_screener_runs r ON r.id = a.run_id
        WHERE o.return_intraday IS NOT NULL
    """)


# ── point-in-time intraday reversal features ───────────────────────────────────
# vwap_deviation_pct / intraday_range_pos: the SAME two inputs intraday_ranker.py's
# _reversal_scores() already computes and this platform has independently validated as its
# best-ranked intraday signal (IC -0.090 t=-5.7 at 10:15, per the 2026-07-31 intraday audit)
# -- but that function only ever answers "as of right now" (today, via date.today()), which is
# fine for live scoring but useless for training on history. Reconstructed here point-in-time
# per historical run instead: for a given (symbol, run timestamp), only bars strictly at or
# before that timestamp, on that SAME trading day, ever contribute -- a run at 10:00 must never
# see the stock's 14:00 high. Processed one trading day at a time (not one global merge_asof
# across the whole date range) specifically so a day boundary can never accidentally let a run
# match a bar from a different session -- the exact class of leak this whole file was fixed
# for earlier today, in a new guise.
REVERSAL_FEATURE_COLS = ['vwap_deviation_pct', 'intraday_range_pos']


def _load_intraday_bars_for_date(session_date: str) -> pd.DataFrame:
    """On-grid 15m bars for one IST trading date. Drops the zero-volume synthetic 'last
    price' quotes intraday_fetcher.py appended before its 2026-07-31 fix (still present in
    older history) -- matches _reversal_scores()'s own on-grid filter (minute % 15 == 0,
    second == 0), just against a pandas Timestamp instead of string-slicing the raw text.
    A plain UTC calendar-date bound is sufficient here (not an IST-aware range): NSE's whole
    09:15-15:30 IST session falls inside 03:45-10:00 UTC of the SAME calendar date, since IST
    is ahead of UTC.
    """
    next_date = (pd.Timestamp(session_date) + pd.Timedelta(days=1)).strftime('%Y-%m-%d')
    df = read_df("""
        SELECT symbol, datetime, high, low, close, volume
        FROM intraday_ohlcv
        WHERE interval = '15m' AND datetime >= ? AND datetime < ?
    """, (session_date, next_date))
    if df.empty:
        return df
    dt = pd.to_datetime(df['datetime'], utc=True)
    on_grid = (dt.dt.minute % 15 == 0) & (dt.dt.second == 0)
    df = df.loc[on_grid].copy()
    df['datetime'] = dt.loc[on_grid]
    for c in ('high', 'low', 'close', 'volume'):
        df[c] = pd.to_numeric(df[c], errors='coerce')
    return df.dropna(subset=['high', 'low', 'close'])


def _empty_reversal_frame() -> pd.DataFrame:
    """Explicit dtypes (not bare pd.DataFrame(columns=...), which defaults every column to
    object) so a downstream .fillna()/arithmetic on an all-empty result doesn't hit pandas'
    object-dtype-downcast-on-fillna FutureWarning."""
    return pd.DataFrame({
        'run_id': pd.Series(dtype='int64'), 'symbol': pd.Series(dtype='object'),
        'vwap_deviation_pct': pd.Series(dtype='float64'),
        'intraday_range_pos': pd.Series(dtype='float64'),
    })


def _asof_reversal_for_date(bars: pd.DataFrame, as_of: pd.DataFrame) -> pd.DataFrame:
    """bars: one trading day's on-grid intraday_ohlcv rows (from _load_intraday_bars_for_date).
    as_of: DataFrame with columns [run_id, symbol, ts] -- every row must fall on the SAME
    trading day `bars` covers (caller's responsibility; _load_reversal_features enforces this
    by looping per date). Returns [run_id, symbol, vwap_deviation_pct, intraday_range_pos]."""
    if bars.empty or as_of.empty:
        return _empty_reversal_frame()

    # merge_asof (even with by=) requires the right frame globally sorted by the 'on' column,
    # not by (symbol, datetime) -- sorting by datetime alone still leaves each symbol's own
    # subsequence in chronological order (a subset of a sorted sequence stays sorted), which
    # is what groupby(...).cumsum()/cummax()/cummin() below need to be correct.
    b = bars.sort_values('datetime').copy()
    b['typical_pv'] = (b['high'] + b['low'] + b['close']) / 3.0 * b['volume']
    grp = b.groupby('symbol', sort=False)
    b['cum_pv'] = grp['typical_pv'].cumsum()
    b['cum_v'] = grp['volume'].cumsum()
    b['cum_hi'] = grp['high'].cummax()
    b['cum_lo'] = grp['low'].cummin()

    a = as_of.copy()
    # Cast to the SAME dtype as b['datetime'], not just utc=True -- pandas 2.x preserves
    # sub-second resolution from the source rather than always coercing to [ns]. `ts` reaches
    # this function from two different code paths with different native precisions
    # (_build_matrix's `run_ts` comes from a bulk read_df() SQL read, typically [ns];
    # score()'s comes from query_one()'s raw single-row cursor read, typically a plain Python
    # datetime.datetime -> [us] once wrapped in a DataFrame column) -- merge_asof raises a
    # hard MergeError on a [us] vs [ns] mismatch rather than silently coercing either side.
    a['ts'] = pd.to_datetime(a['ts'], utc=True).astype(b['datetime'].dtype)
    a = a.sort_values('ts')

    merged = pd.merge_asof(
        a, b, left_on='ts', right_on='datetime', by='symbol', direction='backward'
    )

    vwap = merged['cum_pv'] / merged['cum_v'].replace(0, np.nan)
    merged['vwap_deviation_pct'] = (merged['close'] - vwap) / vwap * 100.0
    span = merged['cum_hi'] - merged['cum_lo']
    merged['intraday_range_pos'] = (merged['close'] - merged['cum_lo']) / span.replace(0, np.nan)

    return merged[['run_id', 'symbol'] + REVERSAL_FEATURE_COLS]


def _load_reversal_features(run_asof: pd.DataFrame) -> pd.DataFrame:
    """run_asof: DataFrame with columns [run_id, symbol, ts, session_date] (session_date =
    'YYYY-MM-DD' IST trading date the run belongs to; ts = the run's own UTC timestamp).
    Returns [run_id, symbol, vwap_deviation_pct, intraday_range_pos] across all dates,
    processed one trading day at a time so a run can never match a bar from a different day.
    Missing for a (run_id, symbol) when that symbol had no intraday_ohlcv coverage that day
    (a real, known gap -- intraday_fetcher.py doesn't reach 100% of the universe every cycle)
    -- callers must fillna, not assume every row gets a value.
    """
    out = []
    for session_date, day_asof in run_asof.groupby('session_date'):
        try:
            bars = _load_intraday_bars_for_date(session_date)
        except Exception as e:
            print(f"[LiveScreenerMLRanker] reversal features skipped for {session_date}: {str(e)[:100]}", file=sys.stderr)
            continue
        out.append(_asof_reversal_for_date(bars, day_asof[['run_id', 'symbol', 'ts']]))
    return pd.concat(out, ignore_index=True) if out else _empty_reversal_frame()


def _build_matrix(df: pd.DataFrame):
    """One row per (run_id, symbol): binary filter-match columns (whichever filters matched
    IN THAT SCAN CYCLE) + change_per/log-volume captured AT THAT SCAN + the resulting
    same-day return.

    Deliberately grouped at (run_id, symbol) -- NOT (appeared_at, symbol) as this used to be.
    A filter match persists across many consecutive ~15-min scans in one trading day (median
    15 runs/day per matching symbol, confirmed live), and the old day-level groupby averaged
    change_per/volume across all of that day's runs (spread up to ~25pp within a single day)
    and OR'd together every filter the symbol EVER matched that day into one row -- neither is
    available at real scoring time, which only ever sees a single run's snapshot (see score()
    below: `WHERE run_id = ?`). That mismatch between what the model was trained on (a
    day-smoothed, day-unioned view) and what it actually receives live (one scan's raw,
    possibly-partial view) is a train/serve skew, confirmed live 2026-08-07 as a likely
    contributor to the deployed model's near-zero live AUC (see live_screener_ml_no_live_edge_
    2026_08_07 memory). Grouping by (run_id, symbol) instead makes every training row exactly
    the same shape as a scoring-time row: this scan's filter matches, this scan's change_per/
    volume, nothing from later in the day folded in.

    Also joins in vwap_deviation_pct/intraday_range_pos (see _load_reversal_features) --
    this platform's own best-validated intraday signal family, computed point-in-time as of
    each row's own run timestamp, never peeking at later bars from the same day.
    """
    agg = df.groupby(["run_id", "symbol"]).agg(
        appeared_at=("appeared_at", "first"),
        run_ts=("run_ts", "first"),
        return_intraday=("return_intraday", "mean"),
        change_per=("change_per", "mean"),
        volume=("volume", "mean"),
    ).reset_index()

    pivot = df.pivot_table(
        index=["run_id", "symbol"], columns="filter_key", aggfunc="size", fill_value=0
    ).clip(upper=1).reset_index()
    filter_cols = [c for c in pivot.columns if c not in ("run_id", "symbol")]

    matrix = pd.merge(pivot, agg, on=["run_id", "symbol"])
    matrix["log_volume"] = np.log1p(matrix["volume"].clip(lower=0).fillna(0))
    matrix["change_per"] = matrix["change_per"].fillna(0.0)

    run_asof = matrix[["run_id", "symbol", "appeared_at", "run_ts"]].rename(
        columns={"appeared_at": "session_date", "run_ts": "ts"}
    )
    reversal = _load_reversal_features(run_asof)
    matrix = matrix.merge(reversal, on=["run_id", "symbol"], how="left")
    # Explicit, semantically-neutral fills (not the blanket 0.0 train() applies to every
    # feature downstream) -- 0.0 = "at VWAP", 0.5 = "mid-range", for symbols with no
    # intraday_ohlcv coverage that day (a real, known coverage gap, not an error).
    matrix["vwap_deviation_pct"] = matrix["vwap_deviation_pct"].fillna(0.0)
    matrix["intraday_range_pos"] = matrix["intraday_range_pos"].fillna(0.5)

    feature_cols = filter_cols + ["change_per", "log_volume"] + REVERSAL_FEATURE_COLS
    return matrix.sort_values("appeared_at").reset_index(drop=True), feature_cols


def _make_model(spw: float):
    from lightgbm import LGBMClassifier
    return LGBMClassifier(
        n_estimators=150, learning_rate=0.05, num_leaves=15, max_depth=4,
        subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
        min_child_samples=20, scale_pos_weight=spw, n_jobs=-1, verbose=-1,
    )


# ── training ───────────────────────────────────────────────────────────────────

def _load_active_metrics() -> dict | None:
    if not os.path.exists(MODEL_PATH):
        return None
    try:
        with open(MODEL_PATH, "rb") as f:
            art = pickle.load(f)
        # Full field set (2026-08-07), not just test_auc/trained_at -- needed so a REJECTED
        # candidate's run can still refresh app_settings' live-edge status without overwriting
        # the still-active model's own cv_auc/test_acc/base_rate/n_samples/n_features with a
        # rejected candidate's numbers. See _persist_live_edge_status.
        return {k: art.get(k) for k in
                ("test_auc", "trained_at", "cv_auc", "test_acc", "base_rate",
                 "n_samples", "feature_names", "rejection_count", "first_rejected_at")}
    except Exception:
        return None


def _bump_rejection_bookkeeping(model_path: str) -> int:
    """Increments rejection_count / stamps first_rejected_at directly onto the active pickle
    (ml-promotion-gate-review, 2026-08-15: this file's baseline lives in a pickle, not
    model_registry, so it had no equivalent to ml_ensemble.py/cs_ranker.py's safety valve
    against a permanently-unbeatable stale baseline). Loads and rewrites the FULL artifact --
    not the trimmed _load_active_metrics() view -- so the live model/feature_names/etc. are
    preserved untouched. Returns the new rejection count (0 if there's no active model yet)."""
    if not os.path.exists(model_path):
        return 0
    try:
        with open(model_path, "rb") as f:
            art = pickle.load(f)
    except Exception:
        return 0
    rejection_count = int(art.get("rejection_count") or 0) + 1
    art["rejection_count"] = rejection_count
    if not art.get("first_rejected_at"):
        art["first_rejected_at"] = datetime.datetime.now().isoformat()
    with open(model_path, "wb") as f:
        pickle.dump(art, f)
    return rejection_count


def _persist_live_edge_status(active: dict, live_auc: float | None, live_n: int,
                               live_edge_proven: bool) -> None:
    """Refresh app_settings.live_screener_ml_model_status' live_auc/live_edge_proven fields
    for the model CURRENTLY DEPLOYED (MODEL_PATH) -- unconditionally, on every --train run,
    not just when a new candidate happens to get promoted.

    2026-08-07 fix: this used to be written only inside train()'s `if promote:` branch. Since
    scoring always uses whatever's in MODEL_PATH regardless of whether that day's retrain
    promotes, live_auc/live_edge_proven describe the DEPLOYED model, not the candidate -- but
    as long as promotion kept failing (confirmed live: the deployed model's live AUC is 0.4615
    over 671,257 resolved rows, essentially no real edge, and every subsequent candidate has
    also failed to clear the resulting elevated STRICT_PROMOTION_MARGIN), this health signal
    never reached app_settings at all. monitor.router.ts's "Intraday Edge" tab reads
    live_screener_ml_scores.win_probability directly with no gate on this signal whatsoever --
    a model with demonstrably no live edge was being rendered to users as a confidently
    color-coded "ML XX%" badge indistinguishable from a model that actually works.
    """
    if not active:
        return
    execute("""
        INSERT INTO app_settings (key, value, "updatedAt")
        VALUES ('live_screener_ml_model_status', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"
    """, (
        json.dumps({
            "trained_at": active.get("trained_at"), "cv_auc": active.get("cv_auc"),
            "test_auc": active.get("test_auc"), "test_acc": active.get("test_acc"),
            "base_rate": active.get("base_rate"), "n_samples": active.get("n_samples"),
            "n_features": len(active["feature_names"]) if active.get("feature_names") else None,
            "live_auc": live_auc, "live_auc_rows": live_n,
            "live_edge_proven": live_edge_proven,
        }),
        datetime.datetime.now().isoformat(),
    ))


def train():
    from sklearn.metrics import accuracy_score, roc_auc_score
    from sklearn.model_selection import TimeSeriesSplit

    df = _load_training_frame()
    if df.empty:
        print("[LiveScreenerMLRanker] No resolved return_intraday data yet — run live_screener_resolver.py first.")
        return
    matrix, feature_cols = _build_matrix(df)
    if len(matrix) < MIN_SAMPLES:
        print(f"[LiveScreenerMLRanker] Only {len(matrix)} resolved (date,symbol) samples "
              f"(need >= {MIN_SAMPLES}) — skipping.")
        return

    dates = np.array(sorted(matrix["appeared_at"].unique()))
    if len(dates) < MIN_DATES:
        print(f"[LiveScreenerMLRanker] Only {len(dates)} distinct trading days "
              f"(need >= {MIN_DATES} for an honest time-based split) — skipping.")
        return

    y = (matrix["return_intraday"] > 0).astype(int)
    X = matrix[feature_cols].fillna(0.0)
    base_rate = float(y.mean())
    spw = (1 - base_rate) / max(base_rate, 1e-6)

    # Held-out test window: the most recent TEST_FRAC of DATES (not rows — a cross-sectional
    # day can carry many symbols, so a row-based split can leak most of a boundary day into
    # both sides). CV below only ever touches the training window.
    n_test_dates = max(1, int(len(dates) * TEST_FRAC))
    test_dates = set(dates[-n_test_dates:])
    test_mask = matrix["appeared_at"].isin(test_dates).values
    train_mask = ~test_mask

    X_train, y_train = X[train_mask], y[train_mask]
    X_test, y_test = X[test_mask], y[test_mask]
    if y_train.nunique() < 2 or y_test.nunique() < 2:
        print("[LiveScreenerMLRanker] Train/test split has only one class on one side "
              "(all wins or all losses) — skipping until there's a more balanced sample.")
        return

    # Purged-in-time OOF AUC over the training window only (TimeSeriesSplit never trains on
    # rows chronologically after what it validates on).
    #
    # gap=1: unlike ml_ensemble.py/cs_ranker.py's multi-day-forward-return labels (which need a
    # multi-day embargo to stop a training row's forward window from touching a validation-fold
    # date), this label is same-day intraday resolution (return_intraday, resolved by that same
    # day's close) -- there's no forward window past the split boundary for a later fold to leak
    # into. gap=1 is added anyway for defensive consistency with every other CV site in this
    # codebase (ml_ensemble.py/cs_ranker.py/confluence_ml_engine.py/ml_signal_scorer.py all pass
    # gap=embargo), not because a leak was demonstrated here (2026-07-30 fifth full-stack-audit
    # pass assessed this and found no actual leak, just a convention inconsistency).
    n_splits = min(5, max(2, len(dates) // (MIN_DATES // 2)))
    tscv = TimeSeriesSplit(n_splits=n_splits, gap=1)
    cv_aucs = []
    for tr_idx, val_idx in tscv.split(X_train):
        y_tr, y_val = y_train.iloc[tr_idx], y_train.iloc[val_idx]
        if y_tr.nunique() < 2 or y_val.nunique() < 2:
            continue
        m = _make_model(spw)
        m.fit(X_train.iloc[tr_idx], y_tr)
        cv_aucs.append(roc_auc_score(y_val, m.predict_proba(X_train.iloc[val_idx])[:, 1]))
    cv_auc = float(np.mean(cv_aucs)) if cv_aucs else None

    # Final model: fit on the full training window, scored ONCE against the untouched test
    # window — the number that answers "does it generalize", not "how was it tuned".
    model = _make_model(spw)
    model.fit(X_train, y_train)
    test_proba = model.predict_proba(X_test)[:, 1]
    test_auc = float(roc_auc_score(y_test, test_proba))
    test_acc = float(accuracy_score(y_test, (test_proba > 0.5).astype(int)))

    print(f"[LiveScreenerMLRanker] n={len(matrix)} base_rate={base_rate:.3f} "
          f"cv_auc={cv_auc if cv_auc is None else round(cv_auc, 4)} test_auc={test_auc:.4f} "
          f"test_acc={test_acc:.4f} train_rows={len(X_train)} test_rows={len(X_test)} "
          f"dates={len(dates)}")

    baseline = _load_active_metrics()
    live_auc, live_n = _live_auc()
    live_edge_proven = live_auc is not None and live_auc >= LIVE_AUC_FLOOR
    # A held-out gain only counts as evidence when held-out AUC has been shown to transfer.
    margin = PROMOTION_MARGIN if (live_auc is None or live_edge_proven) else STRICT_PROMOTION_MARGIN
    if live_auc is not None:
        print(f"[LiveScreenerMLRanker] LIVE AUC of the deployed model = {live_auc:.4f} "
              f"over {live_n} scored-and-resolved rows (floor {LIVE_AUC_FLOOR}) -- "
              + ("live edge confirmed." if live_edge_proven else
                 f"NO demonstrated live edge; promotion margin raised to {margin}."))
    else:
        print(f"[LiveScreenerMLRanker] LIVE AUC unavailable ({live_n} gradeable rows, "
              f"need {LIVE_AUC_MIN_ROWS}) -- using standard promotion margin.")

    baseline_test_auc = baseline.get("test_auc") if baseline else None
    promote = clears_promotion_bar(test_auc, baseline_test_auc, margin)

    # STALENESS OVERRIDE (ml-promotion-gate-review, 2026-08-15): see
    # model_promotion.file_staleness_override_applies()'s docstring for the full contract.
    staleness_override, age_days, rejection_count = (False, 0.0, 0)
    if not promote and baseline is not None:
        staleness_override, age_days, rejection_count = file_staleness_override_applies(baseline)

    # Refit on ALL data (train + test windows) for the artifact that actually goes live --
    # matches the OOF/held-out probe above, same as breakout_classifier.py's convention.
    final_model = _make_model(spw)
    final_model.fit(X, y)
    artifact = {
        "model": final_model,
        "feature_names": feature_cols,
        "trained_at": datetime.datetime.now().isoformat(),
        "cv_auc": cv_auc,
        "test_auc": test_auc,
        "test_acc": test_acc,
        "base_rate": base_rate,
        "n_samples": len(matrix),
        "live_auc": live_auc,
        "live_auc_rows": live_n,
        "live_edge_proven": live_edge_proven,
    }
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)

    if promote or staleness_override:
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(artifact, f)
        # Surfaced so consumers (the Live Screener page's "Intraday Edge" tab) can tell a
        # model with demonstrated live discrimination from one without.
        _persist_live_edge_status(
            {"trained_at": artifact["trained_at"], "cv_auc": cv_auc, "test_auc": test_auc,
             "test_acc": test_acc, "base_rate": base_rate, "n_samples": len(matrix),
             "feature_names": feature_cols},
            live_auc, live_n, live_edge_proven,
        )
        if staleness_override and not promote:
            print(f"[LiveScreenerMLRanker] STALENESS OVERRIDE — baseline unbeaten {age_days:.1f}d "
                  f"across {rejection_count} rejections -- promoting anyway (test_auc={test_auc:.4f}).")
        else:
            print(f"[LiveScreenerMLRanker] Model ACTIVATED (test_auc={test_auc:.4f}"
                  + (f", beat baseline {baseline['test_auc']:.4f})" if baseline and baseline.get('test_auc') is not None else ", no prior model)"))
        if not live_edge_proven and live_auc is not None:
            print("[LiveScreenerMLRanker] WARNING: activated model's family has NO demonstrated "
                  f"live edge (live AUC {live_auc:.4f} < {LIVE_AUC_FLOOR}). Scores remain "
                  "advisory -- do not rank or size on them until live AUC clears the floor.")
    else:
        with open(CANDIDATE_PATH, "wb") as f:
            pickle.dump(artifact, f)
        rejection_count = _bump_rejection_bookkeeping(MODEL_PATH)
        # 2026-08-07 fix: refresh the DEPLOYED model's live-edge status even though this
        # candidate was rejected -- live_auc/live_edge_proven describe whatever's still in
        # MODEL_PATH (unchanged by a rejection), and that signal must keep reaching
        # app_settings on every run, not just the rare one that happens to promote. Uses
        # `baseline` (the still-active model's own metrics), not this rejected candidate's.
        _persist_live_edge_status(baseline, live_auc, live_n, live_edge_proven)
        print(f"[LiveScreenerMLRanker] Candidate REJECTED: test_auc={test_auc:.4f} did not "
              f"beat active model's {baseline['test_auc']:.4f} + {margin} margin. "
              f"Saved to {CANDIDATE_PATH} for inspection; active model unchanged "
              f"(rejection bookkeeping updated: {rejection_count} rejections so far).")


# ── scoring ──────────────────────────────────────────────────────────────────

def score():
    if not os.path.exists(MODEL_PATH):
        print("[LiveScreenerMLRanker] No active model yet — run --train first.")
        return
    with open(MODEL_PATH, "rb") as f:
        art = pickle.load(f)
    model, feature_names = art["model"], art["feature_names"]

    run_row = query_one(
        "SELECT id, created_at FROM live_screener_runs WHERE status IN ('SUCCESS','PARTIAL') "
        "ORDER BY id DESC LIMIT 1"
    )
    run_id, run_ts = (run_row[0], run_row[1]) if run_row else (None, None)
    if not run_id:
        print("[LiveScreenerMLRanker] No live screener run to score yet.")
        return

    appearances = read_df(
        "SELECT symbol, filter_key, change_per, volume FROM live_screener_appearances WHERE run_id = ?",
        (run_id,),
    )
    if appearances.empty:
        print(f"[LiveScreenerMLRanker] Run {run_id} has no appearances to score.")
        return

    agg = appearances.groupby("symbol").agg(
        change_per=("change_per", "mean"), volume=("volume", "mean")
    )
    flags = pd.crosstab(appearances["symbol"], appearances["filter_key"]).clip(upper=1)
    matrix = agg.join(flags, how="left").fillna(0.0)
    matrix["log_volume"] = np.log1p(matrix["volume"].clip(lower=0))

    # Point-in-time vwap_deviation_pct/intraday_range_pos for this run's own timestamp, via
    # the exact same function _build_matrix() uses for training -- only present in the
    # active model's feature_names once a model has been trained after this feature was
    # added (2026-08-07); a currently-deployed older model simply never selects these
    # columns below, so this is safe against an old model too.
    if run_ts is not None and any(f in REVERSAL_FEATURE_COLS for f in feature_names):
        session_date = str(run_ts)[:10]
        run_asof = pd.DataFrame({
            "run_id": run_id, "symbol": matrix.index, "ts": run_ts, "session_date": session_date,
        })
        reversal = _load_reversal_features(run_asof).set_index("symbol")
        matrix = matrix.join(reversal[REVERSAL_FEATURE_COLS], how="left")
        matrix["vwap_deviation_pct"] = matrix["vwap_deviation_pct"].fillna(0.0)
        matrix["intraday_range_pos"] = matrix["intraday_range_pos"].fillna(0.5)

    for f in feature_names:
        if f not in matrix.columns:
            matrix[f] = 0.0
    X = matrix[feature_names]

    proba = model.predict_proba(X)[:, 1]
    now = datetime.datetime.now().isoformat()
    version = art.get("trained_at", "unknown")
    rows = [(run_id, sym, float(round(p, 4)), version, now) for sym, p in zip(matrix.index, proba)]

    executemany("""
        INSERT INTO live_screener_ml_scores (run_id, symbol, win_probability, model_version, computed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, symbol) DO UPDATE SET
            win_probability = excluded.win_probability,
            model_version = excluded.model_version,
            computed_at = excluded.computed_at
    """, rows)
    print(f"[LiveScreenerMLRanker] Scored {len(rows)} symbols for run_id={run_id}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ML win-probability ranker for the NiftyTrader live screener")
    parser.add_argument("--train", action="store_true", help="Fit + report held-out AUC, promote or reject")
    parser.add_argument("--score", action="store_true", help="Write win_probability for the latest collection cycle")
    args = parser.parse_args()
    if args.train:
        train()
    if args.score:
        score()
    if not (args.train or args.score):
        parser.print_help()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
