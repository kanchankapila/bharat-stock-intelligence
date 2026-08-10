"""
flyer_return_alpha_backtest.py — read-only go/no-go check for flyer_classifier.py.

A good purged-CV AUC is not the same as tradeable return alpha. high_flyer_retrospective.py's
own heuristic precursor-lift candidate list looked reasonable on paper too, and a 2026-07-10
walk-forward validation found it had ZERO next-day return alpha (+0.025%/day, t=0.19 --
noise). This script applies the identical bar to flyer_classifier.py's purged-CV
out-of-sample scores (evaluate_purged_cv's `oof` array — genuinely out-of-sample, never
trained on the date it's scoring): rank the tradeable universe by flyer_probability each
day, form a top-N basket, execute a REALISTIC entry (the signal day's own OPEN — the
earliest a real trader could act on a probability computed from the PRIOR session's close)
through that day's close, and measure the daily spread against an equal-weight tradeable-
universe benchmark, at several cost assumptions, with a t-stat matching this codebase's
established reporting convention. Read-only — makes no writes, schedules nothing.

Run:
    python scripts/flyer_return_alpha_backtest.py [--top-n 20] [--min-adtv 5e7]
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

from breakout_classifier import _load_ohlcv, evaluate_purged_cv
from flyer_classifier import load_labeled_features, EMBARGO


def _persist(verdict: dict) -> None:
    """Opt-in only (--persist). Writes the last verdict to app_settings so
    getFlyerClassifierStatus (market.router.ts) can serve it to a read-only frontend
    status card — same JSON-blob-in-app_settings pattern as high_flyer_precursor_lift /
    regime_edge_status. This script otherwise makes no writes."""
    from db_compat import connect, translate
    conn = connect()
    cur = conn.cursor()
    cur.execute(translate(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
        ("flyer_classifier_backtest", json.dumps(verdict)))
    conn.commit()
    print(f"\nPersisted verdict to app_settings.flyer_classifier_backtest")

MIN_PRICE = 20.0
COST_LEVELS_PCT = (0.0, 0.15, 0.25)   # round-trip %, matching the intraday audit's own cost sweep


def _load_open_close(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """Per (symbol, date) open/close, for computing a realistic open-to-close return on the
    signal's own trade day. `ohlcv` is already the same frame flyer_classifier's feature
    builder consumes (from breakout_classifier's survivorship-filled loader)."""
    oc = ohlcv[["symbol", "date", "open", "close", "volume"]].copy()
    oc["oc_ret"] = (oc["close"] - oc["open"]) / oc["open"].replace(0, np.nan)
    return oc


def _adtv_asof_feat_date(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """20-day rolling average rupee turnover as of each date — pre-trade-known liquidity,
    used to filter the tradeable universe (and benchmark) the same way
    topgainers_reverse_engineering_practice's own convention does (>= ~Rs5cr ADTV)."""
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    volume = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()
    turnover = close * volume
    adtv = turnover.rolling(20).mean()
    long = adtv.stack(future_stack=True).rename("adtv").reset_index()
    long.columns = ["feat_date", "symbol", "adtv"]
    return long


def run(top_n: int, min_adtv: float, persist: bool = False) -> None:
    df = load_labeled_features()
    if df.empty:
        print("No labeled data available.")
        return

    result = evaluate_purged_cv(df, embargo=EMBARGO)
    if not result["trained"]:
        print("evaluate_purged_cv did not produce out-of-sample scores; nothing to backtest.")
        return

    # oof is row-aligned to result["df"] (the same df evaluate_purged_cv operated on
    # internally, after its own every-other-day striding) — NOT the `df` passed in above.
    scored = result["df"][["symbol", "date"]].copy()
    scored["oof_prob"] = result["oof"]
    scored = scored.dropna(subset=["oof_prob"])
    print(f"Out-of-sample scored rows: {len(scored)} across {scored['date'].nunique()} distinct dates "
          f"(walk-forward — every score here comes from a model that never trained on that date).")

    # Re-fetch the same OHLCV window for open/close prices + liquidity, matching what
    # load_labeled_features/_load_ohlcv already pulled.
    import datetime
    from flyer_classifier import TRAIN_LOOKBACK_DAYS
    cutoff = (datetime.date.today() - datetime.timedelta(days=TRAIN_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)
    oc = _load_open_close(ohlcv)
    adtv = _adtv_asof_feat_date(ohlcv)

    # Trade-day economics: join the SIGNAL day's own open/close (the trade actually executes
    # on `date`, using a probability computed from data through the PRIOR session).
    merged = scored.merge(oc[["symbol", "date", "oc_ret"]], on=["symbol", "date"], how="inner")
    # Liquidity/price filter must use data known BEFORE the trade -- the trailing ADTV as of
    # the day before the signal day (feat_date), joined via a shift, not same-day ADTV.
    dates_sorted = sorted(oc["date"].unique())
    prev_of = dict(zip(dates_sorted[1:], dates_sorted[:-1]))
    merged["feat_date"] = merged["date"].map(prev_of)
    merged = merged.merge(adtv, on=["symbol", "feat_date"], how="left")
    price_asof = oc.rename(columns={"date": "feat_date", "close": "feat_close"})[["symbol", "feat_date", "feat_close"]]
    merged = merged.merge(price_asof, on=["symbol", "feat_date"], how="left")
    tradeable = merged[(merged["adtv"] >= min_adtv) & (merged["feat_close"] >= MIN_PRICE)].copy()
    tradeable = tradeable.dropna(subset=["oc_ret"])
    print(f"Tradeable rows after >=Rs{min_adtv/1e7:.1f}cr ADTV + >=Rs{MIN_PRICE:.0f} price filter: {len(tradeable)}")

    if tradeable.empty:
        print("No rows survive the liquidity/price filter — cannot backtest.")
        return

    # ── Secondary robustness check: cross-sectional IC (oof_prob vs same-day open-close return) ──
    ic_by_date = tradeable.groupby("date").apply(
        lambda g: g["oof_prob"].corr(g["oc_ret"], method="spearman") if len(g) >= 10 else np.nan,
        include_groups=False,
    ).dropna()
    if len(ic_by_date) > 1:
        ic_t = stats.ttest_1samp(ic_by_date.values, 0.0)
        print(f"\nCross-sectional Spearman IC (oof_prob vs open->close return): "
              f"mean={ic_by_date.mean():.4f} t={ic_t.statistic:.2f} n_days={len(ic_by_date)}")

    # ── Primary check: top-N basket daily spread vs equal-weight tradeable universe ──
    def _day_stats(g: pd.DataFrame):
        universe_ret = g["oc_ret"].mean()
        basket = g.sort_values("oof_prob", ascending=False).head(top_n)
        basket_ret = basket["oc_ret"].mean() if len(basket) else np.nan
        return pd.Series({"universe_ret": universe_ret, "basket_ret": basket_ret, "n_universe": len(g),
                           "n_basket": len(basket)})

    daily = tradeable.groupby("date").apply(_day_stats, include_groups=False).dropna()
    print(f"\nDaily basket vs. universe, {len(daily)} trading days, top-{top_n} by oof_prob, "
          f"entry at the signal day's own OPEN, exit at its CLOSE:")
    print(f"{'cost(rt%)':>10} {'basket%/day':>13} {'universe%/day':>15} {'spread%/day':>13} {'t-stat':>8}")
    for cost_pct in COST_LEVELS_PCT:
        basket_net = daily["basket_ret"] - cost_pct / 100.0
        spread = basket_net - daily["universe_ret"]
        t = stats.ttest_1samp(spread.values, 0.0)
        print(f"{cost_pct:>10.2f} {basket_net.mean()*100:>12.4f}% {daily['universe_ret'].mean()*100:>14.4f}% "
              f"{spread.mean()*100:>12.4f}% {t.statistic:>8.2f}")

    verdict_spread = (daily["basket_ret"] - COST_LEVELS_PCT[1] / 100.0 - daily["universe_ret"])
    verdict_t = stats.ttest_1samp(verdict_spread.values, 0.0)
    is_edge = bool(verdict_t.pvalue < 0.05 and verdict_spread.mean() > 0)
    print(f"\nVERDICT (at {COST_LEVELS_PCT[1]}% round-trip cost): "
          f"{'REAL EDGE' if is_edge else 'NO PROVEN EDGE'} "
          f"(spread={verdict_spread.mean()*100:.4f}%/day, t={verdict_t.statistic:.2f}, p={verdict_t.pvalue:.4f})")

    if persist:
        _persist({
            "as_of": datetime.date.today().isoformat(),
            "oof_auc": result["auc"],
            "test_auc": result["test_auc"],
            "horizon_label": "1 day",
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
        })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Return-alpha go/no-go backtest for flyer_classifier.py")
    parser.add_argument("--top-n", type=int, default=20)
    parser.add_argument("--min-adtv", type=float, default=5e7, help="Minimum 20d avg rupee turnover (default Rs5cr)")
    parser.add_argument("--persist", action="store_true", help="Write the verdict to app_settings for the frontend status card")
    args = parser.parse_args()
    run(top_n=args.top_n, min_adtv=args.min_adtv, persist=args.persist)