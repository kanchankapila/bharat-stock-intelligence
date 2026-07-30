#!/usr/bin/env python3
"""
Day-Movement Predictor
=======================
Cross-sectional model answering a different question than breakout_classifier.py (which
predicts a >=6% UP-move over the next 10 days). This predicts, for TODAY, which stocks are
most likely to have an outsized INTRADAY RANGE -- regardless of direction. Useful as a
same-day watchlist for intraday/options trading: a name doesn't need to go up to be a good
trade, it needs to MOVE.

Label: day_range_pct[t] = (high[t] - low[t]) / close[t-1] * 100, cross-sectional top-decile
flag among eligible (liquid, non-surveillance) symbols on date t. Resolves entirely within
day t's own bar -- no forward-looking window like breakout_classifier's 10-day label, so no
multi-day embargo is needed for the LABEL itself. The embargo below exists only to keep
lagged-feature autocorrelation from bleeding across the train/val boundary.

Two tiers of features, reported SEPARATELY and honestly:
  - CORE (deep history, ~5.5y via stock_ohlcv): pure OHLCV technical/volatility precursors,
    reusing breakout_classifier.compute_ohlcv_features. Every core feature is lagged one
    trading day per-symbol before being joined to day t's label, so "today's row" only ever
    contains what was knowable at yesterday's close.
  - ENRICHMENT (shallow history, ~6-7wk -- screener_catalog membership tracking and
    technical_signals both only go back that far as of 2026-07): screener-count precursors
    (breakout/momentum/volatility/event/derivatives categories, AS-OF the prior trading
    day via trendlyne_screener_stocks.first_seen/last_seen), news sentiment (3y history,
    AS-OF prior day), and technical_signals-derived IV rank / PCR / earnings-proximity
    flags (AS-OF <= prior day). Evaluated on its own overlapping window against the CORE
    model as a baseline, NOT blended into one number -- the enrichment sample is too thin
    right now to trust a combined metric, and this codebase has already been burned once
    this session by a "medium" timeframe join that silently zeroed an entire model's
    training signal (see strategy_optimizer.py fix, 2026-07-17). Don't repeat that by
    quietly upweighting a low-sample feature tier without saying so.

Run:
    python movement_predictor.py --train            # core model: purged-OOF AUC + lift
    python movement_predictor.py --train --enrich    # + enrichment-window lift check
    python movement_predictor.py --score             # write today's movement_probability
"""

import argparse
import datetime
import json
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import connect, read_df, translate
from breakout_classifier import compute_ohlcv_features, FEATURE_COLS as OHLCV_FEATURE_COLS

TOP_PCT = 0.90            # top decile of day-range = "high movement"
MIN_PRICE = 20.0
MIN_TURNOVER_CR = 1.0     # same liquidity floor as intraday_ranker.py, for consistency
TRAIN_LOOKBACK_DAYS = 2000    # ~5.5y -- matches breakout_classifier's full backfilled history
SCORE_LOOKBACK_DAYS = 400
EMBARGO = 3                # small buffer against lagged-feature autocorrelation at the fold edge
ENRICH_LOOKBACK_DAYS = 60   # screener/technical_signals history only goes back ~6-7 weeks
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml_models", "movement.pkl")
# New held-out test_auc must beat the active model's by at least this much to be promoted.
# Same value as ml_ensemble.py's PROMOTION_MARGIN.
MOVEMENT_PROMOTION_MARGIN = 0.005

# Screener categories that plausibly precede a big intraday move -- deliberately excludes
# slow-moving fundamental/valuation/ownership categories.
MOVEMENT_CATEGORIES = (
    "technical_breakout", "technical_momentum", "technical_reversal",
    "volatility", "derivatives_positioning", "event_corporate_action", "volume_liquidity",
)

ENRICH_FEATURE_COLS = [
    "screener_bull_count", "screener_bear_count", "screener_total_count",
    "news_sentiment_score", "news_impact_count",
    "iv_rank", "pcr_oi", "days_to_next_results_flag", "earnings_shocker_flag",
    "mc_tech_rating",  # SCRATCH TEST 2026-07-25: does MC's daily technical rating add lift?
]


# ── label: cross-sectional day-range top decile ────────────────────────────────

def build_movement_labels(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """Long OHLCV -> long label frame (symbol, date, moved). moved=1 when day_range_pct is
    in the top TOP_PCT cross-sectional percentile among eligible symbols that day.
    Eligibility: price >= MIN_PRICE and 20-day avg turnover >= MIN_TURNOVER_CR (both as of
    the day itself -- eligibility isn't a forward-looking concern, it's just excluding
    penny/illiquid noise from the ranking universe)."""
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    high = ohlcv.pivot_table(index="date", columns="symbol", values="high").sort_index()
    low = ohlcv.pivot_table(index="date", columns="symbol", values="low").sort_index()
    vol = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()

    prev_close = close.shift(1)
    day_range_pct = (high - low) / prev_close.replace(0, np.nan) * 100.0

    turnover_cr = (vol * close) / 1e7
    avg_turnover20 = turnover_cr.rolling(20).mean()
    eligible = (close >= MIN_PRICE) & (avg_turnover20 >= MIN_TURNOVER_CR)

    ranked = day_range_pct.where(eligible).rank(axis=1, pct=True)
    moved = (ranked >= TOP_PCT).where(day_range_pct.notna() & eligible)

    long = moved.stack(future_stack=True).rename("moved").reset_index()
    long.columns = ["date", "symbol", "moved"]
    long = long.dropna(subset=["moved"])  # future_stack=True keeps NaN rows; drop before astype
    long["moved"] = long["moved"].astype(int)
    day_range_long = day_range_pct.stack(future_stack=True).rename("day_range_pct").reset_index()
    day_range_long.columns = ["date", "symbol", "day_range_pct"]
    return long.merge(day_range_long, on=["date", "symbol"], how="left")


def _lag_by_symbol(feats: pd.DataFrame, cols: list) -> pd.DataFrame:
    """Shift every column in `cols` forward one row WITHIN each symbol's own date-sorted
    sequence -- the row now labelled with date d carries feature values as of the symbol's
    PRIOR trading date, never d itself. A positional per-symbol shift (not a fixed calendar
    shift) so this is correct across weekends/holidays without special-casing them."""
    feats = feats.sort_values(["symbol", "date"]).reset_index(drop=True)
    shifted = feats.groupby("symbol")[cols].shift(1)
    out = feats[["date", "symbol"]].join(shifted)
    return out


# ── core (OHLCV) training data ──────────────────────────────────────────────────

def _load_ohlcv(cutoff: str) -> pd.DataFrame:
    ohlcv = read_df(
        "SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv "
        "WHERE date >= ? AND COALESCE(is_suspect, 0) = 0 ORDER BY date",
        (cutoff,),
    )
    if not ohlcv.empty:
        ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.strftime("%Y-%m-%d")
    return ohlcv


def load_core_training_data() -> pd.DataFrame:
    cutoff = (datetime.date.today() - datetime.timedelta(days=TRAIN_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)
    if ohlcv.empty:
        return pd.DataFrame()

    labels = build_movement_labels(ohlcv)
    labels = labels.dropna(subset=["moved"])

    raw_feats = compute_ohlcv_features(ohlcv)
    lagged = _lag_by_symbol(raw_feats, OHLCV_FEATURE_COLS)

    df = labels.merge(lagged, on=["symbol", "date"], how="inner")
    return df.dropna(subset=OHLCV_FEATURE_COLS, how="any").reset_index(drop=True)


# ── enrichment (screener/news/technical_signals) precursors ────────────────────

def load_screener_precursors(cutoff: str) -> pd.DataFrame:
    """(symbol, date, screener_bull_count, screener_bear_count, screener_total_count) for
    every trading date, counting screener membership AS OF the PRIOR day via
    first_seen/last_seen windows -- a stock counts as a member of a screener on date d only
    if first_seen <= d-1 and (last_seen is null or last_seen >= d-1), i.e. it must have
    already been in the screener before the day we're predicting, not on it."""
    cats = ",".join(f"'{c}'" for c in MOVEMENT_CATEGORIES)
    q = f"""
        SELECT tss.symbol, tss.first_seen, tss.last_seen, sc.signal_bias
        FROM trendlyne_screener_stocks tss
        JOIN screener_catalog sc ON sc.screener_id = tss.screener_id AND sc.source = 'trendlyne'
        WHERE sc.category IN ({cats}) AND tss.first_seen IS NOT NULL AND tss.first_seen >= ?
    """
    rows = read_df(q, (cutoff,))
    if rows.empty:
        return pd.DataFrame(columns=["symbol", "date", "screener_bull_count",
                                      "screener_bear_count", "screener_total_count"])

    trading_days = read_df(
        "SELECT DISTINCT date FROM stock_ohlcv WHERE date >= ? ORDER BY date", (cutoff,)
    )["date"].tolist()

    rows["first_seen"] = pd.to_datetime(rows["first_seen"])
    rows["last_seen"] = pd.to_datetime(rows["last_seen"]).fillna(pd.Timestamp.today())

    # Label each row with date d (the day being PREDICTED) but compute membership as of
    # trading_days[i-1] (the PRIOR day) -- the first cut here compared first_seen/last_seen
    # to d itself, which is a same-day leak (screener state "known" on the day it's
    # supposedly predicting). Caught before trusting the enrichment number.
    out = []
    for i in range(1, len(trading_days)):
        d, d_prev_ts = trading_days[i], pd.Timestamp(trading_days[i - 1])
        active = rows[(rows["first_seen"] <= d_prev_ts) & (rows["last_seen"] >= d_prev_ts)]
        if active.empty:
            continue
        agg = active.groupby("symbol")["signal_bias"].agg(
            bull=lambda s: (s == "bullish").sum(),
            bear=lambda s: (s == "bearish").sum(),
            total="count",
        )
        agg = agg.reset_index()
        agg["date"] = d
        out.append(agg)
    if not out:
        return pd.DataFrame(columns=["symbol", "date", "screener_bull_count",
                                      "screener_bear_count", "screener_total_count"])
    combined = pd.concat(out, ignore_index=True)
    combined.columns = ["symbol", "screener_bull_count", "screener_bear_count",
                         "screener_total_count", "date"]
    return combined[["symbol", "date", "screener_bull_count", "screener_bear_count",
                      "screener_total_count"]]


def load_news_precursors(cutoff: str) -> pd.DataFrame:
    """(symbol, date, news_sentiment_score, news_impact_count) -- 3-day avg sentiment + 5-day
    high-impact article count as of the PRIOR day (published_at < that day's date), same
    windows as feature_engineering.py's _merge_sentiment for consistency."""
    q = """
        SELECT symbols_json, sentiment_score, impact, published_at
        FROM news_sentiment_items
        WHERE published_at >= ? AND symbols_json IS NOT NULL AND symbols_json != '' AND symbols_json != '[]'
    """
    rows = read_df(q, (cutoff,))
    if rows.empty:
        return pd.DataFrame(columns=["symbol", "date", "news_sentiment_score", "news_impact_count"])
    rows["published_at"] = pd.to_datetime(rows["published_at"], errors="coerce", utc=True).dt.tz_localize(None)
    rows = rows.dropna(subset=["published_at"])

    long = []
    for _, r in rows.iterrows():
        try:
            syms = json.loads(r["symbols_json"])
        except Exception:
            continue
        for s in syms:
            long.append({"symbol": s, "date": r["published_at"].normalize(),
                         "score": r["sentiment_score"] or 0.0,
                         "high_impact": 1 if r["impact"] == "HIGH" else 0})
    if not long:
        return pd.DataFrame(columns=["symbol", "date", "news_sentiment_score", "news_impact_count"])
    nl = pd.DataFrame(long).groupby(["symbol", "date"]).agg(
        score=("score", "mean"), high_impact=("high_impact", "sum")
    ).reset_index()

    out = []
    for sym, g in nl.groupby("symbol"):
        g = g.set_index("date").sort_index()
        full_idx = pd.date_range(g.index.min(), g.index.max(), freq="D")
        g = g.reindex(full_idx)
        # .shift(1) so day d's row reflects news through d-1 only -- the unshifted rolling
        # window included the current day's own (possibly intraday, possibly post-move)
        # news in that day's row, a same-day leak. Caught before trusting the enrichment
        # number.
        sent3 = g["score"].rolling(3, min_periods=1).mean().shift(1)
        imp5 = g["high_impact"].rolling(5, min_periods=1).sum().shift(1)
        f = pd.DataFrame({"news_sentiment_score": sent3, "news_impact_count": imp5})
        f["symbol"] = sym
        f["date"] = f.index
        out.append(f.reset_index(drop=True))
    combined = pd.concat(out, ignore_index=True)
    combined["date"] = combined["date"].dt.strftime("%Y-%m-%d")
    return combined


def load_ts_precursors(cutoff: str) -> pd.DataFrame:
    """(symbol, date, iv_rank, pcr_oi, days_to_next_results_flag, earnings_shocker_flag),
    lagged one row per symbol before returning -- the raw query below reads technical_signals
    row AS COMPUTED for date d (an EOD scan using day d's own closing data), so joining it
    directly onto day d's label would be a same-day leak identical in kind to the ones fixed
    in ml_ensemble.py/exit_policy.py earlier this session. _lag_by_symbol makes the row now
    labelled date d carry the PRIOR technical_signals row instead."""
    q = """
        SELECT ts.symbol, ts.date, ts.iv_rank, ts.pcr_oi,
               CASE WHEN ts.days_to_next_results IS NOT NULL AND ts.days_to_next_results <= 2
                    THEN 1 ELSE 0 END AS days_to_next_results_flag,
               COALESCE(ts.earnings_shocker_flag, 0) AS earnings_shocker_flag,
               COALESCE(ts.mc_tech_rating, 0) AS mc_tech_rating
        FROM technical_signals ts
        WHERE ts.date >= ?
    """
    rows = read_df(q, (cutoff,))
    if rows.empty:
        return rows
    cols = ["iv_rank", "pcr_oi", "days_to_next_results_flag", "earnings_shocker_flag", "mc_tech_rating"]
    return _lag_by_symbol(rows, cols)


# ── model ────────────────────────────────────────────────────────────────────

def _feature_matrix(df: pd.DataFrame, cols: list):
    return df[cols].replace([np.inf, -np.inf], np.nan).fillna(0.0)


def _make_model(spw: float, min_child_samples: int = 200):
    from lightgbm import LGBMClassifier
    return LGBMClassifier(
        n_estimators=400, learning_rate=0.03, num_leaves=63, max_depth=-1,
        subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
        min_child_samples=min_child_samples, scale_pos_weight=spw, n_jobs=-1, verbose=-1,
    )


def _purged_oof(df: pd.DataFrame, feature_cols: list, n_folds: int = 4,
                 min_child_samples: int = 200) -> tuple:
    """Purged date-block walk-forward OOF probabilities. Returns (oof_array, mask).

    min_child_samples defaults to 200 for the CORE model (610k+ rows, appropriate there).
    The ENRICH tier passes a much smaller value: with only ~60 trading days of alt-data
    history, a sparse-but-real feature (e.g. only ~130 non-zero rows total across the whole
    window) can never form a valid split at min_child_samples=200 regardless of whether it's
    predictive -- the enrichment lift check would silently read as "no signal" purely from a
    leaf-size floor sized for the CORE model, not because the feature lacks a real effect.
    Found via mc_tech_rating: raw correlation vs next-day range was 0.15-0.27 (two independent
    windows) yet the enrichment purged-OOF delta was identically +0.0000 with min_child_samples=200."""
    from sklearn.metrics import roc_auc_score

    y = df["moved"].astype(int).values
    X = _feature_matrix(df, feature_cols)
    base_rate = float(y.mean())
    spw = (1 - base_rate) / max(base_rate, 1e-6)

    dates = np.array(sorted(df["date"].unique()))
    oof = np.full(len(y), np.nan)
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
        m = _make_model(spw, min_child_samples=min_child_samples)
        m.fit(X[tr], y[tr])
        oof[va] = m.predict_proba(X[va])[:, 1]

    mask = ~np.isnan(oof)
    if mask.sum() < 50 or len(set(y[mask])) < 2:
        return None, None, base_rate
    auc = float(roc_auc_score(y[mask], oof[mask]))
    q = pd.Series(oof[mask])
    top = q >= q.quantile(0.9)
    top_rate = float(y[mask][top.values].mean()) if top.any() else float("nan")
    lift = (top_rate / base_rate) if base_rate > 0 else float("nan")
    return auc, lift, base_rate


def _holdout_test_auc(df: pd.DataFrame, feature_cols: list, holdout_dates: set) -> float:
    """Train on everything before `holdout_dates` (minus an embargo) and score against them.
    These dates never appear in any _purged_oof fold's train or validation split, so this is
    an independent read on generalization rather than the number CV was tuned against."""
    from sklearn.metrics import roc_auc_score

    if not holdout_dates:
        return float("nan")
    all_dates = np.array(sorted(df["date"].unique()))
    pre_holdout = sorted(set(all_dates) - holdout_dates)
    train_dates = set(pre_holdout[:max(1, len(pre_holdout) - EMBARGO)])

    y = df["moved"].astype(int).values
    X = _feature_matrix(df, feature_cols)
    tr = df["date"].isin(train_dates).values
    va = df["date"].isin(holdout_dates).values
    if tr.sum() < 200 or va.sum() < 50 or len(set(y[tr])) < 2 or len(set(y[va])) < 2:
        print(f"[Movement] held-out test skipped - insufficient rows/class balance "
              f"(train={tr.sum()}, holdout={va.sum()})")
        return float("nan")

    base_rate = float(y[tr].mean())
    spw = (1 - base_rate) / max(base_rate, 1e-6)
    m = _make_model(spw)
    m.fit(X[tr], y[tr])
    return float(roc_auc_score(y[va], m.predict_proba(X[va])[:, 1]))


def _load_baseline_test_auc(model_path: str) -> float | None:
    """The currently-active model's own stored test_auc, or None if there's no existing
    model or it can't be read."""
    if not os.path.exists(model_path):
        return None
    try:
        with open(model_path, "rb") as f:
            existing = pickle.load(f)
        return existing.get("test_auc")
    except Exception as e:
        print(f"[Movement] Could not read existing model at {model_path} for comparison "
              f"({e}) -- treating as no baseline.")
        return None


def _movement_promotion_decision(test_auc: float, baseline_test_auc: float | None) -> tuple[bool, str | None]:
    """Pure gate decision (Finding #80): returns (promote, refusal_reason).

    A NaN held-out AUC (insufficient holdout rows) must never auto-promote just because
    there happens to be no prior baseline to fail against -- "no baseline" and "invalid
    metric" are different states that were conflated before this fix.
    """
    if np.isnan(test_auc):
        return False, "held-out test AUC is NaN (insufficient holdout data) -- cannot confirm this model is safe to promote."
    if baseline_test_auc is None:
        return True, None
    if test_auc >= baseline_test_auc + MOVEMENT_PROMOTION_MARGIN:
        return True, None
    return False, (f"new held-out test AUC {test_auc:.4f} did not beat active model's "
                    f"{baseline_test_auc:.4f} + {MOVEMENT_PROMOTION_MARGIN} margin.")


def train(report_only: bool = False, enrich: bool = False, leak_check: bool = False) -> dict:
    core = load_core_training_data()
    if core.empty or len(core) < 500:
        print(f"[Movement] insufficient core data ({len(core)} rows); skipping.")
        return {"trained": False, "n": len(core)}

    core = core.sort_values("date").reset_index(drop=True)
    all_dates = sorted(core["date"].unique())
    if len(all_dates) > 200:
        keep = set(all_dates[::2])   # halve for CV speed, same rationale as breakout_classifier
        core = core[core["date"].isin(keep)].reset_index(drop=True)

    # Reserve the most recent 15% of dates as a final holdout, untouched by any CV fold below,
    # for one independent generalization check (see _holdout_test_auc).
    core_dates_sorted = np.array(sorted(core["date"].unique()))
    n_holdout_dates = max(EMBARGO, int(len(core_dates_sorted) * 0.15))
    holdout_dates = set(core_dates_sorted[-n_holdout_dates:]) if len(core_dates_sorted) > 4 * EMBARGO else set()
    cv_core = core[~core["date"].isin(holdout_dates)] if holdout_dates else core

    auc, lift, base_rate = _purged_oof(cv_core, OHLCV_FEATURE_COLS)
    if auc is None:
        print(f"[Movement] purged CV left too few validation rows; need more history.")
        return {"trained": False, "n": len(core)}
    print(f"[Movement][CORE] n={len(core)} base_rate={base_rate:.3f} purged-OOF AUC={auc:.4f} "
          f"top-decile move-rate lift={lift:.2f}x")

    test_auc = _holdout_test_auc(core, OHLCV_FEATURE_COLS, holdout_dates)
    if not np.isnan(test_auc):
        print(f"[Movement][CORE] held-out test AUC={test_auc:.4f} on {len(holdout_dates)} "
              f"never-cross-validated final dates")

    if leak_check:
        from ml_leak_check import leak_canary

        def _oof_auc_only(frame, cols):
            a, _, _ = _purged_oof(frame, cols)
            return a

        canary = leak_canary(cv_core, OHLCV_FEATURE_COLS, _oof_auc_only)
        print(f"[Movement][LEAK-CHECK][CORE] {canary['note']}")

    result = {"trained": False, "n": len(core), "core_auc": auc, "core_test_auc": test_auc,
              "core_lift": lift, "base_rate": base_rate}

    if enrich:
        e_cutoff = (datetime.date.today() - datetime.timedelta(days=ENRICH_LOOKBACK_DAYS)).isoformat()
        screener = load_screener_precursors(e_cutoff)
        news = load_news_precursors(e_cutoff)
        ts = load_ts_precursors(e_cutoff)

        enriched = core[core["date"] >= e_cutoff].copy()
        for extra in (screener, news, ts):
            if not extra.empty:
                enriched = enriched.merge(extra, on=["symbol", "date"], how="left")
        for c in ENRICH_FEATURE_COLS:
            if c not in enriched.columns:
                enriched[c] = 0.0

        if len(enriched) < 200 or enriched["date"].nunique() < 2 * EMBARGO:
            print(f"[Movement][ENRICH] only {len(enriched)} rows / "
                  f"{enriched['date'].nunique()} dates in the {ENRICH_LOOKBACK_DAYS}d enrichment "
                  f"window -- too thin for a purged CV yet. Skipping the enrichment check "
                  f"rather than report a number nobody should trust.")
        else:
            # min_child_samples=30 (not the CORE model's 200): the enrichment window is thin by
            # nature (~60d of alt-data history) and several columns are sparse-but-potentially-
            # real (e.g. mc_tech_rating had ~130 non-zero rows total in one test window) -- 200
            # would structurally block LightGBM from ever splitting on them regardless of signal.
            # See _purged_oof's docstring for how this was found.
            ENRICH_MIN_CHILD_SAMPLES = 30
            all_cols = OHLCV_FEATURE_COLS + ENRICH_FEATURE_COLS
            e_auc, e_lift, e_base = _purged_oof(enriched, all_cols, n_folds=2,
                                                 min_child_samples=ENRICH_MIN_CHILD_SAMPLES)
            c_auc, c_lift, _ = _purged_oof(enriched, OHLCV_FEATURE_COLS, n_folds=2,
                                            min_child_samples=ENRICH_MIN_CHILD_SAMPLES)
            if e_auc is not None and c_auc is not None:
                print(f"[Movement][ENRICH-WINDOW] same {enriched['date'].nunique()}-day window -- "
                      f"core-only AUC={c_auc:.4f} vs core+enrichment AUC={e_auc:.4f} "
                      f"(delta {e_auc - c_auc:+.4f}). Provisional: {enriched['date'].nunique()} "
                      f"days is a thin sample -- treat as directional, not conclusive.")
                result.update({"enrich_window_days": enriched["date"].nunique(),
                                "core_only_auc_same_window": c_auc,
                                "core_plus_enrichment_auc": e_auc})
                if leak_check:
                    from ml_leak_check import leak_canary

                    def _enrich_oof_only(frame, cols):
                        a, _, _ = _purged_oof(frame, cols, n_folds=2,
                                               min_child_samples=ENRICH_MIN_CHILD_SAMPLES)
                        return a

                    e_canary = leak_canary(enriched, all_cols, _enrich_oof_only, min_rows=100)
                    print(f"[Movement][LEAK-CHECK][ENRICH] {e_canary['note']}")
            else:
                print("[Movement][ENRICH] purged CV on the enrichment window left too few rows.")

    if report_only:
        return result

    # Promotion gate (Finding #80, 2026-07-28 full-stack audit): this used to unconditionally
    # overwrite MODEL_PATH whenever not report_only -- it never loaded the existing pickle's
    # own stored test_auc to compare against the freshly computed one, even though the
    # artifact already stores it. score() blindly loads whatever is at MODEL_PATH, so a
    # retrain that regresses (bad fold, unlucky init) silently replaced a better production
    # model with a worse one. Mirrors live_screener_ml_ranker.py's
    # _load_active_metrics()/PROMOTION_MARGIN pattern, which this sibling file didn't reuse.
    baseline_test_auc = _load_baseline_test_auc(MODEL_PATH)
    promote, refusal_reason = _movement_promotion_decision(test_auc, baseline_test_auc)
    if not promote:
        print(f"[Movement] REFUSED: {refusal_reason} Active model at {MODEL_PATH} left unchanged.")
        result["trained"] = False
        result["promoted"] = False
        return result

    X = _feature_matrix(core, OHLCV_FEATURE_COLS)
    y = core["moved"].astype(int)
    spw = (1 - base_rate) / max(base_rate, 1e-6)
    prod = _make_model(spw)
    prod.fit(X, y)
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump({"model": prod, "feature_names": OHLCV_FEATURE_COLS,
                     "trained_at": datetime.date.today().isoformat(), "oof_auc": auc,
                     "test_auc": test_auc}, f)
    print(f"[Movement] saved model (core OOF AUC {auc:.4f}, held-out test AUC {test_auc:.4f}"
          + (f", beat baseline {baseline_test_auc:.4f}" if baseline_test_auc is not None else ", no prior model")
          + f") -> {MODEL_PATH}")
    result["trained"] = True
    result["promoted"] = True
    return result


def score() -> int:
    """Compute today's movement_probability for every symbol with a fresh OHLCV bar, and
    write it onto technical_signals (new column, additive -- not read by anything else yet
    until this is wired into a consumer)."""
    if not os.path.exists(MODEL_PATH):
        print("[Movement] no model; run --train first.")
        return 0
    with open(MODEL_PATH, "rb") as f:
        art = pickle.load(f)
    conn = connect()
    cur = conn.cursor()
    try:
        cur.execute(translate("ALTER TABLE technical_signals ADD COLUMN movement_probability REAL"))
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
        print(f"[Movement] no feature rows for {d}.")
        return 0
    X = today[art["feature_names"]].replace([np.inf, -np.inf], np.nan).fillna(0.0).astype(np.float32)
    probs = art["model"].predict_proba(X)[:, 1]
    cur.executemany(
        "UPDATE technical_signals SET movement_probability = ? WHERE symbol = ? AND date = ?",
        [(round(float(p), 4) if np.isfinite(p) else None, s, d)
         for p, s in zip(probs, today["symbol"])],
    )
    conn.commit()
    print(f"[Movement] scored {len(today)} symbols for {d}.")
    return len(today)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Day-movement predictor (high intraday range)")
    parser.add_argument("--train", action="store_true", help="Fit + report purged-OOF AUC")
    parser.add_argument("--report", action="store_true", help="Evaluate only, don't save a model")
    parser.add_argument("--enrich", action="store_true", help="Also report the screener/news/options enrichment lift check")
    parser.add_argument("--leak-check", action="store_true", help="Run the leak-canary test (re-runs OOF CV on an extra-lagged copy of the features; expensive, opt-in)")
    parser.add_argument("--score", action="store_true", help="Write movement_probability for latest date")
    args = parser.parse_args()
    if args.train or args.report:
        train(report_only=args.report, enrich=args.enrich, leak_check=args.leak_check)
    if args.score:
        score()
    if not (args.train or args.report or args.score):
        train(report_only=True, enrich=True)
