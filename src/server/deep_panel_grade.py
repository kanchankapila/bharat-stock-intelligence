"""Grade the equal-weight deep-panel composite per liquidity / F&O tier, against BOTH benchmarks.

This is not an edge hunt. measurement.md already records a survivorship-reduced 2021-2026 replay (AF-20261008-29:
OOS IC +0.050, t 5.4, top-decile net -0.022%/period, t -0.38) and 58 structural levers none of which reached t 2.
This module extends that record to what it lacks -- a dated F&O tier, the median-vs-mean benchmark split on every
row, and the `atr_pct` warm-up question -- and prints whether it agrees. A null reading is a successful run.

Reads only: no production rows, no DDL. Outputs are files (verdicts.csv, control.csv, REPORT.md).
The estimator is factor_edge's own (`_metrics`, `_verdict`, `_effective_dates`), so a verdict here is comparable
with every other verdict in this repo.
"""
import argparse
import sys
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import pandas as pd

from deep_panel import column_zero_shares
from deep_panel_score import (
    FACTOR_GROUPS, assert_no_label_leak, composite_score, same_day_contemporaneity, shuffled_control,
    winsorise_returns,
)
from factor_edge import MIN_SYMBOLS_XS, _effective_dates, _forward_returns, _metrics, _verdict
from fno_universe_asof import fno_eligible_asof, fno_series_coverage, is_covered

HORIZONS = (1, 5, 15, 21)
TIERS = ("FNO", "ADT>=50cr", "ADT>=10cr", "ADT<10cr", "ADT>=1cr")
# forward_test_report.py's convention, verbatim: 20-session rolling MEAN of close*volume, min_periods=15, Rs 1cr floor.
ADT_FLOOR = 10_000_000
_CR = 10_000_000
TOP_FRAC = 0.10  # AF-20261008-29 quotes a top-DECILE book
MIN_N = 100  # factor_edge CLI default
# Frozen protocol: 25 bps a side, charged on the book only (the benchmark is a free index-like average).
ROUND_TRIP_COST_PCT = 0.5

_STORED = {1, 5, 15}
_CONV_STORED = "close[t+1]->close[t+1+N] (stored target_ret_Nd; entry lagged one session, overnight gap not credited)"
_CONV_COMPUTED = "close[t+1]->close[t+22] (computed from stock_ohlcv, same convention; feature_store has no target_ret_21d)"
_CONV_OPEN = "open[t+1]->open[t+6] (factor_edge entry=open; the frozen forward-test convention)"
OPEN_ARM = "fwd_open_5d"

ROW_ORDER = (
    "tier", "horizon", "label_col", "label_convention", "rank_ic", "ic_t_eff", "hit_auc", "n", "dates", "eff_dates",
    "symbols", "verdict", "median_benchmark_excess", "mean_benchmark_excess", "mean_excess_net_pct",
    "mean_excess_t_eff", "median_beater_flag", "median_benchmark_excess_raw", "mean_benchmark_excess_raw",
    "t_eff_raw", "median_beater_flag_raw", "zero_share_max", "zero_share_max_col", "contemporaneity", "span",
    "fno_span", "fno_match_rate", "fno_match_rate_by_date",
)


def tier_mask(panel: pd.DataFrame, tier: str) -> pd.Series:
    if tier == "FNO":
        return panel["fno_covered"].astype(bool) & panel["fno"].astype(bool)
    adt = panel["adt"]
    if tier == "ADT>=50cr":
        return adt >= 50 * _CR
    if tier == "ADT>=10cr":
        return adt >= 10 * _CR
    if tier == "ADT<10cr":
        return (adt >= ADT_FLOOR) & (adt < 10 * _CR)
    if tier == "ADT>=1cr":
        return adt >= ADT_FLOOR
    raise ValueError(f"unknown tier {tier!r}")


def _arms(panel, horizons):
    for h in horizons:
        col = f"target_ret_{h}d"
        if col not in panel:
            raise KeyError(f"panel has no {col}: a requested horizon is never silently dropped")
        yield h, col, (_CONV_STORED if h in _STORED else _CONV_COMPUTED)
        if h == 5 and OPEN_ARM in panel:
            yield 5, OPEN_ARM, _CONV_OPEN


def label_columns(panel, horizons=HORIZONS) -> list[str]:
    return [col for _, col, _ in _arms(panel, horizons)]


def _zero_share_max(sub):
    best, best_col = float("nan"), ""
    for c in (c for grp in FACTOR_GROUPS.values() for c in grp):
        if c not in sub:
            continue
        s = sub[c]
        nn = int(s.notna().sum())
        if nn and (z := float((s == 0).sum()) / nn) > (best if best == best else -1.0):
            best, best_col = z, c
    return best, best_col


def _ic_t_eff(d, col, horizon, min_per_date):
    a = d.groupby("date")["score"].rank()
    b = d.groupby("date")[col].rank()
    t = pd.DataFrame({"date": d["date"], "a": a, "b": b})
    ics = t.groupby("date").apply(lambda g: g["a"].corr(g["b"]) if len(g) >= min_per_date else np.nan).dropna()
    if len(ics) < 2 or not ics.std(ddof=1) > 0:
        return float("nan")
    return float(ics.mean() / (ics.std(ddof=1) / np.sqrt(max(_effective_dates(len(ics), horizon), 1.0))))


def _topdecile_excess(d, col, horizon, min_per_date):
    """Top-decile book minus the tier's equal-weight MEAN and MEDIAN, per date, in percent per period."""
    rk = d.groupby("date")["score"].rank(pct=True, method="first")
    g = d.groupby("date")[col]
    top = d[rk > 1 - TOP_FRAC].groupby("date")[col].mean()
    stats = pd.DataFrame({"top": top, "mean": g.mean(), "median": g.median(), "cnt": g.size()}).dropna()
    stats = stats[stats["cnt"] >= max(min_per_date, int(round(1 / TOP_FRAC)))]
    if len(stats) < 2:
        return float("nan"), float("nan"), float("nan")
    exc_mean = (stats["top"] - stats["mean"]) * 100
    exc_med = (stats["top"] - stats["median"]) * 100
    sd = exc_mean.std(ddof=1)
    t = float(exc_mean.mean() / (sd / np.sqrt(max(_effective_dates(len(exc_mean), horizon), 1.0)))) if sd > 0 else float("nan")
    return float(exc_med.mean()), float(exc_mean.mean()), t


def grade_tier(panel, score, tier, horizons=HORIZONS) -> list[dict]:
    m = tier_mask(panel, tier)
    sub, sc = panel[m], score[m]
    zmax, zcol = _zero_share_max(sub)
    try:
        contemp = same_day_contemporaneity(sub, sc, "ret_1d") if "ret_1d" in sub and len(sub) else float("nan")
    except ValueError:
        contemp = float("nan")
    fno_span = fno_rate = fno_rate_d = None
    if tier == "FNO":
        cov = sub["date"]
        fno_span = panel.attrs.get("fno_span") or (
            f"{cov.min():%Y-%m-%d}..{cov.max():%Y-%m-%d}" if len(cov) else "no covered date")
        fno_rate = panel.attrs.get("fno_match_rate")
        fno_rate_d = panel.attrs.get("fno_match_rate_by_date")
    rows = []
    for h, col, conv in _arms(panel, horizons):
        key = f"fwd_{h}"
        # Winsorise within the tier on observed values: a lone 99.0 print is not clipped by linear interpolation.
        d = pd.DataFrame({"date": sub["date"], "symbol": sub["symbol"], "score": sc,
                          key: winsorise_returns(sub[col])}).dropna(subset=["score", key])
        d[f"xs_{h}"] = d[key] - d.groupby("date")[key].transform("median")
        res = _metrics(d, "score", h, MIN_SYMBOLS_XS, MIN_N)
        if res is None:
            mic = auc = float("nan")
            n, dates, symbols = len(d), int(d["date"].nunique()), int(d["symbol"].nunique())
        else:
            mic, auc, n, dates, symbols = res
        med_x, mean_x, t_x = _topdecile_excess(d, key, h, MIN_SYMBOLS_XS)
        # Same books, UNclipped returns. factor_backtest benchmarks the raw universe mean, so this is the column
        # comparable with the record; the winsorised one shows how much of a t depends on the clipping.
        d_raw = d.assign(**{key: sub[col].replace([np.inf, -np.inf], np.nan).reindex(d.index)})
        med_r, mean_r, t_r = _topdecile_excess(d_raw, key, h, MIN_SYMBOLS_XS)
        rows.append({
            "tier": tier, "horizon": h, "label_col": col, "label_convention": conv,
            "rank_ic": mic, "ic_t_eff": _ic_t_eff(d, key, h, MIN_SYMBOLS_XS) if res else float("nan"),
            "hit_auc": auc, "n": n, "dates": dates, "eff_dates": _effective_dates(dates, h), "symbols": symbols,
            "verdict": _verdict(mic, auc, dates, symbols, h),
            "median_benchmark_excess": med_x, "mean_benchmark_excess": mean_x,
            "mean_excess_net_pct": mean_x - ROUND_TRIP_COST_PCT, "mean_excess_t_eff": t_x,
            # +IC machinery beside a book that loses to the universe MEAN: right skew sits in the names the score avoids.
            "median_beater_flag": bool(med_x > 0 and mean_x < 0),
            "median_benchmark_excess_raw": med_r, "mean_benchmark_excess_raw": mean_r, "t_eff_raw": t_r,
            "median_beater_flag_raw": bool(med_r > 0 and mean_r < 0),
            "zero_share_max": zmax, "zero_share_max_col": zcol, "contemporaneity": contemp,
            "span": f"{d['date'].min():%Y-%m-%d}..{d['date'].max():%Y-%m-%d}" if len(d) else "",
            "fno_span": fno_span, "fno_match_rate": fno_rate, "fno_match_rate_by_date": fno_rate_d,
        })
    return rows


def run_label_gate(panel, score, horizons=HORIZONS) -> dict[str, float]:
    return {col: assert_no_label_leak(panel, score, col) for col in label_columns(panel, horizons)}


def grade_all_tiers(panel, score, horizons=HORIZONS, tiers=TIERS, gate=True) -> pd.DataFrame:
    if gate:
        run_label_gate(panel, score, horizons)
    rows = [r for t in tiers for r in grade_tier(panel, score, t, horizons)]
    return pd.DataFrame(rows).reindex(columns=list(ROW_ORDER))


# ---------------------------------------------------------------- F&O membership

def resolve_fno_symbols(fno_symbols, panel_symbols, symbol_isins):
    """F&O symbol -> the symbol that carries its bars in the panel. Literal when it has bars; else by ISIN,
    but only when exactly one priced twin exists. Never intersect-and-drop: dropping the renames would grade only
    the survivors, which makes the F&O verdict optimistic in a way nothing downstream could detect."""
    by_isin: dict[str, set] = {}
    for s, isins in symbol_isins.items():
        for i in isins:
            by_isin.setdefault(i, set()).add(s)
    mapping, direct, via_isin, ambiguous, unresolved = {}, 0, 0, [], []
    for s in sorted(set(fno_symbols)):
        if s in panel_symbols:
            mapping[s] = s
            direct += 1
            continue
        twins = {t for i in symbol_isins.get(s, ()) for t in by_isin.get(i, ()) if t != s and t in panel_symbols}
        if len(twins) == 1:
            mapping[s] = next(iter(twins))
            via_isin += 1
        elif twins:
            ambiguous.append(s)
        else:
            unresolved.append(s)
    total = len(set(fno_symbols))
    return mapping, {"direct": direct, "by_isin": via_isin, "total": total, "ambiguous": ambiguous,
                     "unresolved": unresolved, "match_rate": (direct + via_isin) / total if total else float("nan")}


def add_fno_columns(panel, conn, mapping):
    """`fno_covered` per date (via is_covered -- an empty set is ambiguous) and `fno` per row. A date the series
    does not cover contributes NO eligible set: it is skipped, never read as 'no F&O names'."""
    out = panel.copy(deep=False)
    covered, pairs, shares = {}, [], []
    for d in pd.DatetimeIndex(out["date"].unique()).sort_values():
        ds = f"{d:%Y-%m-%d}"
        covered[d] = is_covered(conn, ds)
        if not covered[d]:
            continue
        elig = fno_eligible_asof(conn, ds)
        hit = {mapping[s] for s in elig if s in mapping}
        shares.append(sum(s in mapping for s in elig) / len(elig) if elig else float("nan"))
        pairs += [(d, s) for s in hit]
    out["fno_covered"] = out["date"].map(covered).fillna(False).astype(bool)
    keys = pd.MultiIndex.from_frame(out[["date", "symbol"]])
    out["fno"] = keys.isin(pd.MultiIndex.from_tuples(pairs, names=["date", "symbol"])) if pairs else False
    out.attrs = dict(panel.attrs)
    out.attrs["fno_match_rate_by_date"] = float(np.nanmean(shares)) if shares else float("nan")
    return out


# ---------------------------------------------------------------- loading (production reads only)

def _frame(buf, names):
    df = pd.DataFrame(buf, columns=names)
    df["date"] = pd.to_datetime(df["date"])
    for c in names:
        if c not in ("symbol", "date"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def _stream(conn, sql, names, params=()):
    from db_compat import iter_rows
    frames, buf = [], []
    for row in iter_rows(conn, sql, params):
        buf.append(row)
        if len(buf) >= 200_000:
            frames.append(_frame(buf, names))
            buf = []
    if buf:
        frames.append(_frame(buf, names))
    return pd.concat(frames, ignore_index=True)


def load_panel(conn, start, end) -> pd.DataFrame:
    feats = list(dict.fromkeys(c for grp in FACTOR_GROUPS.values() for c in grp))
    labels = ["target_ret_1d", "target_ret_5d", "target_ret_15d"]
    names = ["symbol", "date"] + feats + labels
    sql = ("SELECT symbol, date, " + ", ".join(f'"{c}"' for c in feats + labels) +
           " FROM feature_store WHERE timeframe = 'D' AND date >= ? AND date <= ?")
    p = _stream(conn, sql, names, (start, end))

    oh = _forward_returns(conn, start, [5], entry="open")  # factor_edge's own open-entry labeller
    g = oh.groupby("symbol")["close"]
    ext = oh[["symbol", "date"]].copy()
    ext[OPEN_ARM] = oh["fwd_5"]
    ext["target_ret_21d"] = g.transform(lambda s: s.shift(-22) / s.shift(-1) - 1)
    ext["_chk5"] = g.transform(lambda s: s.shift(-6) / s.shift(-1) - 1)
    del oh

    px = _stream(conn, "SELECT symbol, date, close, volume FROM stock_ohlcv "
                 "WHERE date >= ? AND (is_suspect IS NULL OR is_suspect = 0)", ["symbol", "date", "close", "volume"], (start,))
    px["dv"] = px["close"] * px["volume"]
    px = px.sort_values(["symbol", "date"])
    px["adt"] = px.groupby("symbol")["dv"].transform(lambda s: s.rolling(20, min_periods=15).mean())
    p = p.merge(ext, on=["symbol", "date"], how="left").merge(px[["symbol", "date", "adt"]], on=["symbol", "date"], how="left")
    return p


def benchmark_clip_effect(panel, horizons=HORIZONS) -> str:
    """Winsorising removes the right tail the median-beater trap lives in; show how much of the universe MEAN it removes."""
    sub = panel[tier_mask(panel, "ADT>=1cr")]
    lines = ["| label | per-date universe mean, raw | winsorised 1%/99% | per-date median | share of raw mean removed |", "|---|---|---|---|---|"]
    for h, col, _ in _arms(sub, horizons):
        d = pd.DataFrame({"date": sub["date"], "raw": sub[col].replace([np.inf, -np.inf], np.nan), "w": winsorise_returns(sub[col])}).dropna()
        gm = d.groupby("date")
        raw, w, med = gm["raw"].mean().mean() * 100, gm["w"].mean().mean() * 100, gm["raw"].median().mean() * 100
        lines.append(f"| {col} | {raw:+.3f}% | {w:+.3f}% | {med:+.3f}% | {(1 - w / raw) if raw else float('nan'):.0%} |")
    lines.append("\nAF-20261008-29 / factor_backtest quote the raw universe mean 1.4532%/21d period. Every `mean_benchmark_excess` "
                 "here is against the winsorised tier mean, so the median-beater flag is a LOWER bound on the trap.")
    return "\n".join(lines)


def convention_check(panel) -> str:
    both = panel[["target_ret_5d", "_chk5"]].dropna()
    if both.empty:
        return "no overlapping rows"
    agree = float(((both["target_ret_5d"] - both["_chk5"]).abs() < 1e-6).mean())
    return (f"stored target_ret_5d vs close[t+1]->close[t+6] recomputed from stock_ohlcv: {agree:.1%} of "
            f"{len(both):,} rows agree to 1e-6 (the 21d label uses that same recomputation)")


def atr_pct_audit(conn, panel, start, end) -> str:
    """Is the 2026-09-26 atr_pct reading (-0.056/-0.064/-0.077 at h=5/10/21) warm-up contaminated?"""
    lines = ["atr_pct is in FAKE_ZERO_COLUMNS: 100% of its 2021 zeros coincide with sma20 IS NULL (warm-up default-fill)."]
    for tag, lo, hi in (("2021 (contrast)", "2021-01-01", "2022-01-01"), (f"2024+ ({start if start > '2024-01-01' else '2024-01-01'}..{end})", "2024-01-01", None)):
        hi = hi or f"{(pd.Timestamp(end) + pd.Timedelta(days=1)):%Y-%m-%d}"
        r = conn.execute(
            'SELECT COUNT("atr_pct"), COUNT(*) FILTER (WHERE "atr_pct" = 0), '
            'COUNT(*) FILTER (WHERE "atr_pct" = 0 AND "sma20" IS NULL), COUNT(*) FILTER (WHERE "sma20" IS NULL) '
            "FROM feature_store WHERE timeframe = 'D' AND date >= ? AND date < ?", (lo, hi)).fetchone()
        nn, z, zc, nullc = (int(x or 0) for x in r)
        zs = column_zero_shares(conn, ["atr_pct"], start=lo, end=hi)["atr_pct"]
        lines.append(f"- {tag}: non-null {nn:,}; zero-share {zs:.4%} ({z:,} zeros); zeros whose sma20 is NULL "
                     f"{(zc / z if z else float('nan')):.1%} ({zc:,}); sma20 NULL on {nullc / nn if nn else float('nan'):.2%} of rows overall")
    a = _stream(conn, "SELECT symbol, date, atr_pct, sma20 FROM feature_store WHERE timeframe = 'D' AND date >= ? AND date <= ?",
                ["symbol", "date", "atr_pct", "sma20"], (max(start, "2024-01-01"), end))
    keep = ["symbol", "date", "adt", "target_ret_5d", "target_ret_15d", "target_ret_21d"]
    a = a.merge(panel[keep], on=["symbol", "date"], how="inner")
    lines.append("")
    lines.append("| universe | variant | h | rank IC | rows | eff dates |")
    lines.append("|---|---|---|---|---|---|")
    prior = {5: -0.056, 15: -0.064, 21: -0.077}  # recorded at h=5/10/21; h=15 sits between 10 and 21
    for uni, um in (("all priced", a["adt"].notna() | a["adt"].isna()), ("ADT>=10cr", a["adt"] >= 10 * _CR)):
        for variant, vm in (("all rows", pd.Series(True, index=a.index)), ("drop atr_pct==0", a["atr_pct"] != 0),
                            ("drop sma20 NULL", a["sma20"].notna())):
            for h, col in ((5, "target_ret_5d"), (15, "target_ret_15d"), (21, "target_ret_21d")):
                d = a.loc[um & vm, ["date", "symbol", "atr_pct", col]].rename(columns={"atr_pct": "score", col: f"fwd_{h}"})
                d[f"fwd_{h}"] = winsorise_returns(d[f"fwd_{h}"])
                d = d.dropna()
                d[f"xs_{h}"] = d[f"fwd_{h}"] - d.groupby("date")[f"fwd_{h}"].transform("median")
                res = _metrics(d, "score", h, MIN_SYMBOLS_XS, MIN_N)
                lines.append(f"| {uni} | {variant} | {h} | " + (f"{res[0]:+.4f} | {res[2]:,} | {_effective_dates(res[3], h):.1f}" if res else "n/a | 0 | 0") + " |")
    lines.append(f"\nPrior record (liquid panel, 2024-01-01+): h=5 {prior[5]:+.3f}, h=10 -0.064 (h=15 here), h=21 {prior[21]:+.3f}.")
    return "\n".join(lines)


# ---------------------------------------------------------------- report

def _fmt(v, f):
    return "n/a" if v is None or (isinstance(v, float) and v != v) else format(v, f)


def _table(df, cols):
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for _, r in df.iterrows():
        out.append("| " + " | ".join(
            _fmt(r[c], "+.4f") if c == "rank_ic" else
            _fmt(r[c], ".3f") if c in ("hit_auc", "contemporaneity", "zero_share_max") else
            _fmt(r[c], "+.3f") if c in ("median_benchmark_excess", "mean_benchmark_excess", "mean_excess_net_pct", "ic_t_eff", "mean_excess_t_eff",
                                         "median_benchmark_excess_raw", "mean_benchmark_excess_raw", "t_eff_raw") else
            _fmt(r[c], ".1f") if c == "eff_dates" else str(r[c]) for c in cols) + " |")
    return "\n".join(out)


def interpretation(v) -> str:
    """Two readings the `no edge` label hides, generated from the rows so they cannot drift from the table."""
    out = []
    sig = v[(v["rank_ic"] > 0) & (v["ic_t_eff"] > 2)]
    tiers = list(dict.fromkeys(sig["tier"]))
    best = v.loc[v["rank_ic"].idxmax()] if len(v) else None
    out.append(
        f"**IC significance vs the USABLE gate.** {len(sig)} of {len(v)} tier/horizon cells have a positive rank IC "
        f"distinguishable from zero (t_eff > 2), in {len(tiers)} tiers ({', '.join(tiers) or 'none'}). The verdict vocabulary is "
        "factor_edge's, unchanged: USABLE needs |IC| >= 0.03 AND AUC >= 0.55. "
        + (f"The largest IC here is {best['rank_ic']:+.4f} ({best['tier']}, {best['horizon']}d) with AUC {best['hit_auc']:.3f}; "
           f"the best AUC anywhere is {v['hit_auc'].max():.3f}. " if best is not None else "")
        + "So `no edge` on these rows means the signal is real but economically far below the gate (reaching AUC 0.55 takes "
        "an IC roughly 0.1), NOT that it is indistinguishable from zero. A small significant IC and a book that does not clear "
        "the universe mean are different findings, and this run reports both.")
    dep = v[(v["mean_excess_t_eff"] >= 3.33) & (v["t_eff_raw"] < 2)]
    if len(dep):
        out.append(
            "**Winsorisation-dependent cells.** These clear t 3.33 (the AF-20261008-31 Bonferroni bar) only on clipped returns "
            "and do NOT clear t 2 on raw returns, so they are noise that clipping made look significant, not a departure "
            "from the record: " + "; ".join(
                f"{r.tier} {r.horizon}d {r.label_col} (winsorised t {r.mean_excess_t_eff:+.2f} -> raw t {r.t_eff_raw:+.2f}, "
                f"mean excess {r.mean_benchmark_excess:+.3f}% -> raw {r.mean_benchmark_excess_raw:+.3f}%)" for r in dep.itertuples()) + ".")
    raw_flag = v[v["median_beater_flag_raw"]]
    out.append(f"**Median-beater, raw returns:** {len(raw_flag)} of {len(v)} rows"
               + (" (" + ", ".join(f"{r.tier} {r.horizon}d" for r in raw_flag.itertuples()) + ")" if len(raw_flag) else "")
               + f"; winsorised: {int(v['median_beater_flag'].sum())}.")
    return chr(10).join(x + chr(10) for x in out)


def render_report(v, ctrl, notes, header="") -> str:
    cols = ["tier", "horizon", "label_col", "rank_ic", "ic_t_eff", "hit_auc", "n", "dates", "eff_dates", "symbols", "verdict",
            "median_benchmark_excess", "mean_benchmark_excess", "mean_excess_net_pct", "mean_excess_t_eff", "median_beater_flag",
            "mean_benchmark_excess_raw", "t_eff_raw", "median_beater_flag_raw"]
    parts = [
        "# Deep-panel tiered grade", "", header, "",
        "Excess columns are the top-decile book minus the tier's equal-weight MEDIAN and MEAN, in percent per period "
        "(period = the horizon). `mean_excess_net_pct` subtracts a 0.5% round trip (the frozen protocol's 25 bps a side). "
        "**median-beater flag**: median excess > 0 while mean excess < 0, the factor_edge-vs-factor_backtest trap.",
        "", "Label conventions: stored `target_ret_Nd` are close[t+1]->close[t+1+N]; the 5d `fwd_open_5d` arm is the frozen "
        "protocol's open-entry convention. Both are reported and never averaged. Winsorised 1%/99% on observed values within "
        "each tier. Effective dates = dates / horizon.", "",
        "## How to read this", "", interpretation(v), "",
        "## Verdicts", "", _table(v, cols), "", "## Shuffled-score control (score permuted within each date)", "",
        _table(ctrl, ["tier", "horizon", "label_col", "rank_ic", "hit_auc", "dates", "verdict", "mean_benchmark_excess"]), "",
        "## F&O tier bound", "",
        "The F&O verdict holds only inside the dated series' span and only on covered dates; every FNO row carries it.",
        str(v.loc[v["tier"] == "FNO", "fno_span"].dropna().iloc[0]) if (v["tier"] == "FNO").any() and v.loc[v["tier"] == "FNO", "fno_span"].notna().any() else "n/a",
        "",
    ]
    for title, body in (notes or {}).items():
        parts += [f"## {title}", "", str(body), ""]
    return "\n".join(parts)


def run(panel, score, out_dir, notes=None, header="", horizons=HORIZONS):
    """Gate first, files last: if the label gate raises, nothing is written."""
    out_dir = Path(out_dir)
    gate = run_label_gate(panel, score, horizons)
    v = grade_all_tiers(panel, score, horizons, gate=False)
    ctrl = grade_all_tiers(panel, shuffled_control(panel, score), horizons, gate=False)
    notes = dict(notes or {})
    notes["Label gate"] = "\n".join(f"- {c}: mean per-date Spearman of score with label {r:+.4f} (limit 0.15)" for c, r in gate.items())
    out_dir.mkdir(parents=True, exist_ok=True)
    v.to_csv(out_dir / "verdicts.csv", index=False)
    ctrl.to_csv(out_dir / "control.csv", index=False)
    (out_dir / "REPORT.md").write_text(render_report(v, ctrl, notes, header), encoding="utf-8")
    return v, ctrl


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--start", default="2021-01-01")
    ap.add_argument("--end", default="2026-09-30")
    a = ap.parse_args(argv)

    from db_compat import connect, database_url
    conn = connect()
    # Server-side: a client-side timeout would orphan the query. Read-only on principle.
    conn.execute("SET statement_timeout = 900000")
    conn.execute("SET default_transaction_read_only = on")
    conn.commit()
    u = urlparse(database_url())
    print(f"[grade] {u.hostname}:{u.port}{u.path} read-only", file=sys.stderr)

    panel = load_panel(conn, a.start, a.end)
    print(f"[grade] panel {len(panel):,} rows, {panel['symbol'].nunique():,} symbols, {panel['date'].nunique():,} dates", file=sys.stderr)

    fno_syms = [r[0] for r in conn.execute("SELECT DISTINCT symbol FROM stock_option_features_history WHERE instrument = 'OPTSTK'").fetchall()]
    isins: dict[str, set] = {}
    for s, i in conn.execute("SELECT symbol, isin FROM stock_master WHERE isin IS NOT NULL UNION "
                             "SELECT symbol, isin FROM nse_stocks WHERE isin IS NOT NULL").fetchall():
        isins.setdefault(s, set()).add(i)
    mapping, rep = resolve_fno_symbols(fno_syms, set(panel["symbol"].unique()), isins)
    first, last = fno_series_coverage(conn)
    panel = add_fno_columns(panel, conn, mapping)
    panel.attrs.update(fno_span=f"{first}..{last}", fno_match_rate=rep["match_rate"])
    print(f"[grade] F&O {rep['direct']} direct + {rep['by_isin']} by ISIN of {rep['total']} = {rep['match_rate']:.1%}", file=sys.stderr)

    score = composite_score(panel)
    notes = {
        "F&O symbol resolution": (
            f"{rep['direct']} resolve directly, {rep['by_isin']} by ISIN (single priced twin), of {rep['total']} = "
            f"{rep['match_rate']:.1%}. Date-weighted share of each covered date's eligible names that map into the panel: "
            f"{panel.attrs['fno_match_rate_by_date']:.1%}.\n\nISIN-resolved: " +
            ", ".join(f"{k}->{v}" for k, v in sorted(mapping.items()) if k != v) +
            f"\n\nAmbiguous (reported, not guessed): {rep['ambiguous']}\n\nUnresolved: {rep['unresolved']}\n\n"
            f"Series span {first}..{last}; uncovered dates are skipped (fno_covered False)."),
        "Label convention check": convention_check(panel),
        "Benchmark winsorisation effect (ADT>=1cr)": benchmark_clip_effect(panel),
        "atr_pct on the 2024+ window": atr_pct_audit(conn, panel, a.start, a.end),
    }
    header = (f"Window {a.start}..{a.end}; panel {len(panel):,} rows; composite = equal-weight over the "
              f"{len({c for grp in FACTOR_GROUPS.values() for c in grp})} scored columns of the 47-column PINNED set (13 are excluded as price-level or "
              f"market-wide, see deep_panel_score), z-scored over the whole universe each date, then graded within tier. "
              f"Panel = feature_store symbols with a daily row, not AF-20261008-29's 3,491-symbol survivorship-reduced panel.")
    v, ctrl = run(panel, score, a.out, notes, header)
    pd.set_option("display.width", 250)
    print(v[v["horizon"] == 5][["tier", "label_col", "rank_ic", "hit_auc", "dates", "eff_dates", "symbols", "verdict",
                                "median_benchmark_excess", "mean_benchmark_excess", "median_beater_flag"]].to_string(index=False))
    conn.rollback()
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
