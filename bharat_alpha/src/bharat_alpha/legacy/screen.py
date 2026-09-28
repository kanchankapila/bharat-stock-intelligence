"""Evidence screen: which imported legacy columns earn a place as model inputs.

Each (source, field) is graded with the standard harness — per-date rank IC of the
cross-sectionally ranked value against next-open forward returns, overlap-corrected — using
ONLY decisions whose labels were realised by `cutoff`. Pick the cutoff at or before the start
of the first walk-forward test fold (`default_cutoff`), so the choice of features never sees
the data the model is later evaluated on (selection leakage).

Admission: eff_dates >= min_effective_dates, |Newey-West t| >= promotion_min_t, and the field
covers >= MIN_COVERAGE of the universe on an average date. A sign-consistent NEGATIVE IC is
admitted too (trees and the ridge use either direction); absence of evidence is not admission.
"""
from __future__ import annotations

import datetime as dt

import pandas as pd
import psycopg

from bharat_alpha.config import get_settings
from bharat_alpha.db import read_df, upsert
from bharat_alpha.evaluation.metrics import per_date_ic, summarize_ic
from bharat_alpha.features import _known_date, cs_rank_gauss, universe_mask
from bharat_alpha.labels import forward_returns
from bharat_alpha.marketdata import Panel, load_panel

MIN_COVERAGE = 0.30
MAX_STALE_SESSIONS = 260


def external_panels(conn: psycopg.Connection, p: Panel, only_admitted: bool = False,
                    horizons: tuple[int, ...] | None = None) -> dict[str, pd.DataFrame]:
    """Wide as-of panels per external field, keyed by feature name x_<table>__<field>."""
    q = "SELECT source, field, instrument_id, value, knowable_at FROM alpha.external_fact"
    params: tuple = ()
    if only_admitted:
        q += """ WHERE (source, field) IN (SELECT DISTINCT ON (source, field, horizon) source, field
                                         FROM alpha.external_screen WHERE horizon = ANY(%s) AND admitted
                                         ORDER BY source, field, horizon, cutoff DESC)"""
        params = (list(horizons or get_settings().horizons),)
    df = read_df(conn, q, params)
    if df.empty:
        return {}
    df["known"] = _known_date(df["knowable_at"])
    out = {}
    for (src, field), g in df.groupby(["source", "field"]):
        w = g.pivot_table(index="known", columns="instrument_id", values="value", aggfunc="last")
        w = w.reindex(w.index.union(p.dates)).sort_index().ffill(limit=MAX_STALE_SESSIONS).reindex(p.dates)
        out[f"x_{src.split(':', 1)[1]}__{field}"] = w.reindex(columns=p.close.columns)
    return out


def default_cutoff(conn: psycopg.Connection, start: dt.date) -> dt.date:
    """The last date before the first walk-forward test block of a training run starting at `start`."""
    s = get_settings()
    d = read_df(conn, "SELECT trade_date FROM alpha.trading_day WHERE trade_date >= %s ORDER BY 1 LIMIT %s",
                (start, s.train_min_dates))
    return d.trade_date.max()


def screen(conn: psycopg.Connection, start: dt.date, cutoff: dt.date, horizon: int) -> pd.DataFrame:
    s = get_settings()
    p = load_panel(conn, start, cutoff)
    uni = universe_mask(p)
    lab = forward_returns(p, horizon, s.winsor_pct)          # labels past `cutoff` are unknown -> NaN
    rows = []
    for name, w in external_panels(conn, p).items():
        table, field = name[2:].split("__", 1)
        z = cs_rank_gauss(w, uni)
        cov = float((z.notna().sum(axis=1) / uni.sum(axis=1).replace(0, float("nan"))).mean())
        ic = per_date_ic(z, lab.fwd_w.where(uni))
        summ = summarize_ic(ic, horizon, s.min_effective_dates)
        t = summ.t_nw if summ.t_nw == summ.t_nw else 0.0
        if cov < MIN_COVERAGE:
            ok, why = False, f"coverage {cov:.0%} < {MIN_COVERAGE:.0%}"
        elif not summ.reliable:
            ok, why = False, f"LOW-DATA: {summ.eff_dates} effective dates"
        elif abs(t) < s.promotion_min_t:
            ok, why = False, f"no evidence: |t|={abs(t):.2f}"
        else:
            ok, why = True, f"IC {summ.mean_ic:+.4f}, t={t:.2f} on {summ.eff_dates} effective dates"
        rows.append({"source": f"legacy:{table}", "field": field, "cutoff": cutoff, "horizon": horizon,
                     "n_dates": summ.n_dates, "eff_dates": summ.eff_dates, "coverage": cov,
                     "mean_ic": summ.mean_ic, "t_nw": t, "admitted": ok, "reason": why})
    upsert(conn, "alpha.external_screen", rows, key=("source", "field", "cutoff", "horizon"))
    conn.commit()
    return pd.DataFrame(rows)
