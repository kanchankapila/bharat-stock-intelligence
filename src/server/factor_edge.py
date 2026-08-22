#!/usr/bin/env python3
"""
factor_edge.py — does a candidate score column actually predict forward returns?

Answers the "is this vendor/derived score a usable factor, or priced-in noise?" question
empirically, the same way we validate our own win_probability. For each score column, per
forward horizon (and optionally per market regime), it reports:

  rank_IC  : mean over dates of Spearman(score, forward_return)   -- the factor information coeff.
  hit_AUC  : AUC of score vs (cross-sectional excess forward return > 0)
  n/dates  : sample behind the estimate  (dates<20 => LOW-DATA, do not trust yet)

No look-ahead: a score at date D is only ever compared to prices at D+N. Suspect OHLCV bars
(is_suspect) are excluded. Cross-sectional excess return (vs the universe median that day)
strips out market beta so we measure stock-selection, not direction.

Reusable for any table with (symbol, date, <score>) columns:
  python factor_edge.py --table trendlyne_dvm_scores --scores d_score,v_score,m_score
  python factor_edge.py --table technical_signals --scores ext_t80_tech_score,ext_mojo_quality_rank --by-regime
  python factor_edge.py --table trendlyne_dvm_scores --scores m_score --horizons 5,10,21,63 --quantiles

Verdict thresholds (per horizon, needs dates>=20 to count): usable factor if |rank_IC|>=0.03
AND hit_AUC>=0.55; otherwise "no edge". Momentum-style scores are expected to invert sign in
mean-reverting regimes, so read IC sign alongside AUC.
"""
import argparse
import sys
import warnings

warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score

from db_compat import connect

MIN_DATES_RELIABLE = 20


def _load(con, table, symbol_col, date_col, scores):
    cols = ", ".join([f"{symbol_col} AS symbol", f"{date_col} AS date"] + scores)
    df = pd.DataFrame(
        con.execute(f"SELECT {cols} FROM {table} WHERE {date_col} IS NOT NULL").fetchall(),
        columns=["symbol", "date"] + scores,
    )
    df["date"] = pd.to_datetime(df["date"])
    for s in scores:
        df[s] = pd.to_numeric(df[s], errors="coerce")
    return df


def _forward_returns(con, start_date, horizons, entry="close"):
    """Forward returns per (symbol, date).

    entry="close" (default, historical): fwd_N = close[d+N]/close[d] - 1. This credits the
    strategy with the overnight gap between date d's close and d+1's open -- a move that a
    signal generated after d's close cannot capture. Kept as the default ONLY so that
    factor_edge_history's existing rows stay comparable with new ones; it is not the honest
    convention.

    entry="open" (measurement.md's panel spec -- "Signals computed off a close cannot be
    bought at that close"): enter at d+1's OPEN, exit N sessions later at that day's open.

    Measured 2026-08-22 on engine_composite_scores, per-date then averaged: close-to-close
    overstates rank IC at every horizon -- h=1 +0.0451 -> +0.0210 (more than halved), h=5
    +0.0839 -> +0.0793, h=21 +0.0800 -> +0.0685. The gap is a fixed ~0.94% mean absolute
    overnight move, which is a large fraction of a 1-day return and a small one of a 21-day
    return. Read every close-entry IC as an upper bound; distrust h=1 most.
    """
    if entry not in ("close", "open"):
        raise ValueError(f"entry must be 'close' or 'open', got {entry!r}")
    oh = pd.DataFrame(
        con.execute(
            "SELECT symbol, date, open, close FROM stock_ohlcv "
            "WHERE date >= ? AND (is_suspect IS NULL OR is_suspect = 0) "
            "ORDER BY symbol, date",
            (start_date,),
        ).fetchall(),
        columns=["symbol", "date", "open", "close"],
    )
    oh["date"] = pd.to_datetime(oh["date"])
    for c in ("open", "close"):
        oh[c] = pd.to_numeric(oh[c], errors="coerce")
    g = oh.groupby("symbol")
    for N in horizons:
        if entry == "close":
            oh[f"fwd_{N}"] = g["close"].transform(lambda s: s.shift(-N) / s - 1)
        else:
            # shift(-1) is the next session's open (the first price actually purchasable);
            # shift(-N-1) is the open N sessions after that.
            oh[f"fwd_{N}"] = g["open"].transform(lambda s: s.shift(-N - 1) / s.shift(-1) - 1)
    return oh


def _metrics(d, score, N, min_per_date, min_n):
    d = d.dropna(subset=[score, f"fwd_{N}", f"xs_{N}"])
    if len(d) < min_n:
        return None
    ics = (
        d.groupby("date")
        .apply(lambda g: spearmanr(g[score], g[f"fwd_{N}"])[0]
               if g[score].nunique() > 3 and len(g) >= min_per_date else np.nan)
        .dropna()
    )
    mic = float(ics.mean()) if len(ics) else float("nan")
    y = (d[f"xs_{N}"] > 0).astype(int)
    auc = float(roc_auc_score(y, d[score])) if y.nunique() > 1 else float("nan")
    return mic, auc, len(d), int(d["date"].nunique())


def _verdict(mic, auc, dates):
    if dates < MIN_DATES_RELIABLE:
        return "LOW-DATA"
    if np.isnan(mic) or np.isnan(auc):
        return "n/a"
    if abs(mic) >= 0.03 and auc >= 0.55:
        return "USABLE"
    return "no edge"


def _ensure_history(con):
    con.execute("""
        CREATE TABLE IF NOT EXISTS factor_edge_history (
            run_at        TEXT NOT NULL,
            table_name    TEXT NOT NULL,
            score_col     TEXT NOT NULL,
            regime        TEXT NOT NULL,
            horizon_days  INTEGER NOT NULL,
            rank_ic       REAL,
            hit_auc       REAL,
            n             INTEGER,
            dates         INTEGER,
            verdict       TEXT,
            PRIMARY KEY (run_at, table_name, score_col, regime, horizon_days)
        )
    """)
    con.commit()


def run(table, scores, symbol_col, date_col, horizons, by_regime, min_per_date, min_n, quantiles,
        persist=False, entry="close"):
    con = connect()
    if persist:
        _ensure_history(con)
        run_at = __import__("datetime").datetime.now().isoformat()
    # A close-entry and an open-entry verdict for the same table are NOT comparable (see
    # _forward_returns' docstring: h=1 IC more than halves). Persisting both under the same
    # table_name would put two conventions in one column with nothing distinguishing them --
    # the same shape as this repo's label_definition collision in signal_outcomes, where two
    # structurally different label rules shared a table and produced 88-91% vs 41-44% win
    # rates that were read as skill. Open-entry rows get their own suffixed table_name.
    history_table = table if entry == "close" else f"{table}__open_entry"
    df = _load(con, table, symbol_col, date_col, scores)
    print(f"[factor_edge] {table}: rows={len(df)} symbols={df.symbol.nunique()} "
          f"dates={df.date.nunique()} span={df.date.min().date()}..{df.date.max().date()}")

    lo = (df["date"].min() - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    oh = _forward_returns(con, lo, horizons, entry=entry)
    m = df.merge(oh[["symbol", "date"] + [f"fwd_{N}" for N in horizons]],
                 on=["symbol", "date"], how="inner")
    for N in horizons:
        m[f"xs_{N}"] = m.groupby("date")[f"fwd_{N}"].transform(lambda x: x - x.median())
    print(f"[factor_edge] matched to forward prices: rows={len(m)} dates={m.date.nunique()}")

    groups = [("ALL", m)]
    if by_regime:
        reg = pd.DataFrame(con.execute("SELECT date, regime FROM market_regimes").fetchall(),
                           columns=["date", "regime"])
        reg["date"] = pd.to_datetime(reg["date"])
        m = m.merge(reg, on="date", how="left")
        groups = [("ALL", m)] + [(r, g) for r, g in m.groupby("regime")]

    print(f"\n{'score':22} {'regime':9} {'horiz':5} {'rank_IC':>8} {'hit_AUC':>8} {'n':>7} {'dates':>6}  verdict")
    print("-" * 82)
    for score in scores:
        for reg_name, g in groups:
            for N in horizons:
                res = _metrics(g, score, N, min_per_date, min_n)
                if res is None:
                    continue
                mic, auc, n, dates = res
                vd = _verdict(mic, auc, dates)
                print(f"{score:22} {reg_name:9} {N:4}d {mic:8.3f} {auc:8.3f} {n:7} {dates:6}  {vd}")
                if persist:
                    # NaN -> NULL (never store NaN in a REAL — it poisons downstream reads, same
                    # lesson as win_probability). run_at makes each row unique, so DO NOTHING is safe.
                    con.execute(
                        "INSERT INTO factor_edge_history "
                        "(run_at,table_name,score_col,regime,horizon_days,rank_ic,hit_auc,n,dates,verdict) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                        (run_at, history_table, score, reg_name, N,
                         None if mic != mic else round(mic, 4),
                         None if auc != auc else round(auc, 4),
                         n, dates, vd),
                    )

    if persist:
        con.commit()
        print(f"[factor_edge] persisted results to factor_edge_history (run_at={run_at})")

    if quantiles:
        score, N = scores[0], horizons[0]
        d = m.dropna(subset=[score, f"fwd_{N}"]).copy()
        try:
            d["q"] = d.groupby("date")[score].transform(
                lambda x: pd.qcut(x, 5, labels=False, duplicates="drop"))
            print(f"\n[quantile spread] {score} vs mean {N}d forward return (Q0=low .. Q4=high {score}):")
            qt = d.dropna(subset=["q"]).groupby("q")[f"fwd_{N}"].agg(["mean", "count"])
            for q, row in qt.iterrows():
                print(f"  Q{int(q)}: mean_fwd={row['mean']*100:+.2f}%  n={int(row['count'])}")
            if 4 in qt.index and 0 in qt.index:
                spread = (qt.loc[4, "mean"] - qt.loc[0, "mean"]) * 100
                print(f"  top-minus-bottom spread: {spread:+.2f}%  "
                      f"(positive => high {score} outperformed)")
        except Exception as e:
            print(f"  quantile view unavailable: {e}", file=sys.stderr)
    con.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", required=True)
    ap.add_argument("--scores", required=True, help="comma-separated score columns")
    ap.add_argument("--symbol-col", default="symbol")
    ap.add_argument("--date-col", default="date")
    ap.add_argument("--horizons", default="5,10,21", help="forward trading-day horizons, comma-separated")
    ap.add_argument("--by-regime", action="store_true", help="also break down by market_regimes.regime")
    ap.add_argument("--quantiles", action="store_true", help="print decile-spread for the first score+horizon")
    ap.add_argument("--min-per-date", type=int, default=10)
    ap.add_argument("--min-n", type=int, default=100)
    ap.add_argument("--persist", action="store_true", help="write results to factor_edge_history")
    ap.add_argument("--entry", choices=("close", "open"), default="close",
                    help="entry price convention. 'close' (default, historical) measures "
                         "close[d+N]/close[d], crediting the untradeable overnight gap. "
                         "'open' is measurement.md's panel spec: enter at d+1's open, exit N "
                         "sessions later at the open. Open-entry results persist under "
                         "table_name '<table>__open_entry' so the two conventions never mix.")
    a = ap.parse_args()
    run(a.table, [s.strip() for s in a.scores.split(",")], a.symbol_col, a.date_col,
        [int(h) for h in a.horizons.split(",")], a.by_regime, a.min_per_date, a.min_n, a.quantiles,
        a.persist, a.entry)
