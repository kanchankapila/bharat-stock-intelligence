"""
breakout_return_alpha_backtest.py — the same go/no-go check as
flyer_return_alpha_backtest.py, applied to breakout_classifier.py (already live in
unified_ranker.py's blend, weighted 0.05-0.15 across regimes, on the strength of a purged
purged-OOF AUC ~0.61 -- classification skill only). It has never actually been checked for
tradeable RETURN alpha the way flyer_classifier.py's model just was, and this platform's
own history says that gap matters (the heuristic lift score and flyer_classifier both
looked reasonable on AUC/rationale alone and one of the two had negative real-world alpha).

Execution here differs from the 1-day flyer check: breakout's label is "does the max close
over the NEXT 10 trading days clear +6%", so the realistic trade is entered at the NEXT
session's open (the earliest point after the signal is known) and held through the close of
the 10th day of that same forward window (a plain fixed-holding-period return -- no
lucky-peak assumption, no target/stop timing games). Read-only, makes no writes without
--persist.

Run:
    python scripts/breakout_return_alpha_backtest.py [--top-n 20] [--min-adtv 5e7]
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "server"))

import numpy as np
import pandas as pd
from scipy import stats

from breakout_classifier import (
    _load_ohlcv, evaluate_purged_cv, load_labeled_features, HORIZON, EMBARGO, TRAIN_LOOKBACK_DAYS,
)

MIN_PRICE = 20.0
COST_LEVELS_PCT = (0.0, 0.15, 0.25)


def _persist(verdict: dict) -> None:
    from db_compat import connect, translate
    conn = connect()
    cur = conn.cursor()
    cur.execute(translate(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
        ("breakout_classifier_backtest", json.dumps(verdict)))
    conn.commit()
    print(f"\nPersisted verdict to app_settings.breakout_classifier_backtest")


def run(top_n: int, min_adtv: float, persist: bool = False) -> None:
    df = load_labeled_features()
    if df.empty:
        print("No labeled data available.")
        return

    result = evaluate_purged_cv(df, embargo=EMBARGO)
    if not result["trained"]:
        print("evaluate_purged_cv did not produce out-of-sample scores; nothing to backtest.")
        return

    scored = result["df"][["symbol", "date"]].copy()
    scored["oof_prob"] = result["oof"]
    scored = scored.dropna(subset=["oof_prob"])
    print(f"Out-of-sample scored rows: {len(scored)} across {scored['date'].nunique()} distinct dates.")

    cutoff = (datetime.date.today() - datetime.timedelta(days=TRAIN_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)

    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    volume = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()
    open_ = ohlcv.pivot_table(index="date", columns="symbol", values="open").sort_index()
    adtv = (close * volume).rolling(20).mean()

    # For a signal computed as of `date` (position i in the shared calendar), the earliest
    # executable entry is dates[i+1]'s open; the label's own forward window ends at
    # dates[i+HORIZON] -- a plain fixed-holding-period exit at that day's close, matching
    # exactly what the label claims to predict (no lucky-peak/target-hit assumption).
    all_dates = sorted(close.index)
    n = len(all_dates)
    date_to_pos = {d: i for i, d in enumerate(all_dates)}
    scored = scored[scored["date"].isin(date_to_pos)].copy()
    scored["pos"] = scored["date"].map(date_to_pos)
    scored = scored[scored["pos"] + HORIZON < n]  # need a full forward window to exist
    scored["entry_date"] = scored["pos"].map(lambda p: all_dates[p + 1])
    scored["exit_date"] = scored["pos"].map(lambda p: all_dates[p + HORIZON])

    # Vectorized joins (not row-wise lookups) against long (symbol, date, value) frames.
    open_long = open_.stack(future_stack=True).rename("entry_open").reset_index()
    open_long.columns = ["entry_date", "symbol", "entry_open"]
    close_long = close.stack(future_stack=True).rename("value").reset_index()
    close_long.columns = ["date", "symbol", "value"]
    adtv_long = adtv.stack(future_stack=True).rename("feat_adtv").reset_index()
    adtv_long.columns = ["date", "symbol", "feat_adtv"]

    scored = scored.merge(open_long, on=["symbol", "entry_date"], how="left")
    scored = scored.merge(
        close_long.rename(columns={"date": "exit_date", "value": "exit_close"}),
        on=["symbol", "exit_date"], how="left")
    scored = scored.merge(
        close_long.rename(columns={"value": "feat_close"}), on=["symbol", "date"], how="left")
    scored = scored.merge(adtv_long, on=["symbol", "date"], how="left")
    scored["trade_ret"] = (scored["exit_close"] - scored["entry_open"]) / scored["entry_open"].replace(0, np.nan)

    tradeable = scored.dropna(subset=["trade_ret", "feat_adtv", "feat_close"])
    tradeable = tradeable[(tradeable["feat_adtv"] >= min_adtv) & (tradeable["feat_close"] >= MIN_PRICE)]
    print(f"Tradeable rows after >=Rs{min_adtv/1e7:.1f}cr ADTV + >=Rs{MIN_PRICE:.0f} price filter: {len(tradeable)}")
    if tradeable.empty:
        print("No rows survive the liquidity/price filter — cannot backtest.")
        return

    ic_by_date = tradeable.groupby("date").apply(
        lambda g: g["oof_prob"].corr(g["trade_ret"], method="spearman") if len(g) >= 10 else np.nan,
        include_groups=False,
    ).dropna()
    if len(ic_by_date) > 1:
        ic_t = stats.ttest_1samp(ic_by_date.values, 0.0)
        print(f"\nCross-sectional Spearman IC (oof_prob vs {HORIZON}-day fixed-hold return): "
              f"mean={ic_by_date.mean():.4f} t={ic_t.statistic:.2f} n_dates={len(ic_by_date)}")

    def _day_stats(g: pd.DataFrame):
        universe_ret = g["trade_ret"].mean()
        basket = g.sort_values("oof_prob", ascending=False).head(top_n)
        basket_ret = basket["trade_ret"].mean() if len(basket) else np.nan
        return pd.Series({"universe_ret": universe_ret, "basket_ret": basket_ret})

    daily = tradeable.groupby("date").apply(_day_stats, include_groups=False).dropna()
    # Overlapping HORIZON-day holds share the same signal date's cross-section but not the
    # same calendar days across rows, so this stays a simple per-signal-date comparison
    # (mirrors flyer_return_alpha_backtest.py's daily convention) rather than a true
    # non-overlapping-rebalance P&L curve -- reported as %/holding-period, not %/day.
    print(f"\nBasket vs. universe, {len(daily)} signal dates, top-{top_n} by oof_prob, "
          f"entry next session's open, exit at the close of trading day +{HORIZON}:")
    print(f"{'cost(rt%)':>10} {'basket%':>13} {'universe%':>15} {'spread%':>13} {'t-stat':>8}")
    for cost_pct in COST_LEVELS_PCT:
        basket_net = daily["basket_ret"] - cost_pct / 100.0
        spread = basket_net - daily["universe_ret"]
        t = stats.ttest_1samp(spread.values, 0.0)
        print(f"{cost_pct:>10.2f} {basket_net.mean()*100:>12.4f}% {daily['universe_ret'].mean()*100:>14.4f}% "
              f"{spread.mean()*100:>12.4f}% {t.statistic:>8.2f}")

    verdict_spread = (daily["basket_ret"] - COST_LEVELS_PCT[1] / 100.0 - daily["universe_ret"])
    verdict_t = stats.ttest_1samp(verdict_spread.values, 0.0)
    is_edge = bool(verdict_t.pvalue < 0.05 and verdict_spread.mean() > 0)
    print(f"\nVERDICT (at {COST_LEVELS_PCT[1]}% round-trip cost, {HORIZON}-day hold): "
          f"{'REAL EDGE' if is_edge else 'NO PROVEN EDGE'} "
          f"(spread={verdict_spread.mean()*100:.4f}%/hold, t={verdict_t.statistic:.2f}, p={verdict_t.pvalue:.4f})")

    if persist:
        _persist({
            "as_of": datetime.date.today().isoformat(),
            "oof_auc": result["auc"],
            "test_auc": result["test_auc"],
            "horizon_label": f"{HORIZON} days",
            "n_backtest_signals": int(len(daily)),
            "top_n": top_n,
            "min_adtv": min_adtv,
            "cost_pct_used": COST_LEVELS_PCT[1],
            "spread_pct": float(verdict_spread.mean() * 100),
            "spread_t_stat": float(verdict_t.statistic),
            "spread_p_value": float(verdict_t.pvalue),
            "ic_mean": float(ic_by_date.mean()) if len(ic_by_date) > 1 else None,
            "ic_t_stat": float(ic_t.statistic) if len(ic_by_date) > 1 else None,
            "is_edge": is_edge,
            "note": "breakout_classifier is already LIVE in unified_ranker's blend -- this "
                    "tests it as a standalone top-N strategy, not the blended unified_score.",
        })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Return-alpha go/no-go backtest for breakout_classifier.py")
    parser.add_argument("--top-n", type=int, default=20)
    parser.add_argument("--min-adtv", type=float, default=5e7)
    parser.add_argument("--persist", action="store_true")
    args = parser.parse_args()
    run(top_n=args.top_n, min_adtv=args.min_adtv, persist=args.persist)