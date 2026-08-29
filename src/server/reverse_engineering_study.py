"""
Mover Reverse-Engineering Study
===============================
Answers "why do mover stocks move?" with data instead of folklore:

For every ground-truth mover day (from `mover_snapshots`), it reconstructs the PRE-EVENT
state of each stock (features as of T-1 close) from tables we already store, then measures:

  1. Rank-IC  -- Spearman correlation between each factor's T-1 value and the forward
                 return of the mover cohort (and of the full cross-section).
  2. Cohort lift -- P(mover | factor in top-quartile) / P(mover | bottom-quartile),
                 per class (gap-up / open_eq_low / volume shocker / breakout / ...).
  3. Engine hit-rate -- what fraction of actual movers our engines had ranked in their
                 top-N on T-1 (the audit the user asked for: are we even SEEING these?).

Output: a markdown report + `mover_study_results` rows for every run (auditable history).

Usage:
    python reverse_engineering_study.py                       # last 90 days, all classes
    python reverse_engineering_study.py --days 250 --classes calc_gap_up,calc_open_eq_low
    python reverse_engineering_study.py --top-n 20            # engine top-N hit-rate window

NOTE: this is deliberately read-only except for its own results table.
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

import argparse
import datetime
import json
import os
import sys
import time

import numpy as np
import pandas as pd

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from db_compat import connect, get_engine, translate  # noqa: E402

# ---------------------------------------------------------------------------
# Config: factor families -> concrete columns that exist today.
# Every lookup is defensive: a missing table/column degrades to NaN, never crashes.
# ---------------------------------------------------------------------------

FACTOR_SQL = {
    "momentum": """
        SELECT symbol, MAX(CASE WHEN rn = 1 THEN ret_5d END)  AS f_mom_5d,
               MAX(CASE WHEN rn = 1 THEN ret_21d END)         AS f_mom_21d,
               MAX(CASE WHEN rn = 1 THEN rs_vs_nifty END)     AS f_rs_vs_nifty
        FROM (
            SELECT s.symbol, s.date,
                   ROUND(100.0 * (s.close / NULLIF(LAG(s.close, 5) OVER w, 0) - 1)::numeric, 4) AS ret_5d,
                   ROUND(100.0 * (s.close / NULLIF(LAG(s.close, 21) OVER w, 0) - 1)::numeric, 4) AS ret_21d,
                   ROUND(100.0 * (s.close /
                       NULLIF((SELECT c2.close FROM stock_ohlcv c2
                               WHERE c2.symbol = 'NIFTY50' AND c2.date = s.date), 0)
                     - 1)::numeric, 4) AS rs_vs_nifty,
                   ROW_NUMBER() OVER (PARTITION BY s.symbol ORDER BY s.date DESC) AS rn
            FROM stock_ohlcv s
            WHERE s.date <= ? AND s.date >= ?
            WINDOW w AS (PARTITION BY s.symbol ORDER BY s.date)
        ) WHERE rn = 1 GROUP BY symbol""",
    "technicals": """
        SELECT symbol, MAX(CASE WHEN rn = 1 THEN rsi END)      AS f_rsi,
               MAX(CASE WHEN rn = 1 THEN adx END)              AS f_adx,
               MAX(CASE WHEN rn = 1 THEN mc_vol_ratio END)     AS f_vol_ratio
        FROM (
            SELECT ts.symbol, ts.date, ts.rsi, ts.adx, ts.mc_vol_ratio,
                   ROW_NUMBER() OVER (PARTITION BY ts.symbol ORDER BY ts.date DESC) AS rn
            FROM technical_signals ts
            WHERE ts.date = ?
        ) WHERE rn = 1 GROUP BY symbol""",
    "fno": """
        SELECT symbol, MAX(CASE WHEN rn = 1 THEN rollover_pct END)   AS f_rollover_pct,
               MAX(CASE WHEN rn = 1 THEN cost_of_carry_ann END)      AS f_cost_of_carry
        FROM (
            SELECT fo.symbol, fo.date, fo.rollover_pct, fo.cost_of_carry_ann,
                   ROW_NUMBER() OVER (PARTITION BY fo.symbol ORDER BY fo.date DESC) AS rn
            FROM fno_rollover fo
            WHERE fo.date <= ? AND fo.date > ?
        ) WHERE rn = 1 GROUP BY symbol""",
    "delivery": """
        SELECT symbol, MAX(delivery_pct) AS f_delivery_pct
        FROM stock_delivery_data
        WHERE date <= ? AND date > ? GROUP BY symbol""",
    "flows": """
        SELECT 'NIFTY' AS symbol, NULL AS f_fii_net_3d WHERE 1=0""",
    "fundamentals": """
        SELECT symbol, MAX(CASE WHEN rn = 1 THEN earnings_yield END) AS f_earnings_yield
        FROM (
            SELECT fs.symbol, fs.date, fs.earnings_yield,
                   ROW_NUMBER() OVER (PARTITION BY fs.symbol ORDER BY fs.date DESC) AS rn
            FROM historical_fundamentals fs
            WHERE fs.date <= ?
        ) WHERE rn = 1 GROUP BY symbol""",
}

# ---------------------------------------------------------------------------
# Event loading
# ---------------------------------------------------------------------------

def load_events(days: int, classes: list | None, engine) -> pd.DataFrame:
    """Ground-truth mover days joined to the T-1 session close for each event."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    ev = pd.read_sql(f"SELECT source, trade_date, symbol, pct_change FROM mover_snapshots "
                     f"WHERE trade_date >= '{cutoff}' "
                     f"ORDER BY trade_date DESC, source, symbol", engine)
    if len(ev) == 0:
        return ev
    if classes:
        ev = ev[ev["source"].isin(classes)]
    # drop our own synthetic index rows and any non-equity junk defensively
    ev = ev[~ev["symbol"].astype(str).str.contains("NIFTY|SENSEX|^USD", na=False)]
    # T-1 session per event date: last stock_ohlcv date strictly before trade_date.
    # NOTE: the index series is stored as 'NIFTY50' (no space) in this DB; 'NIFTY 50'
    # matches zero rows and silently drops EVERY event through the T-1 filter below
    # (found 2026-08-25: study saw 205k events -> 0 because of this).
    dates = pd.read_sql("SELECT DISTINCT date FROM stock_ohlcv WHERE symbol='NIFTY50' "
                        "ORDER BY date", engine)
    dser = pd.to_datetime(dates["date"])
    t1 = {}
    for td in pd.to_datetime(ev["trade_date"].unique()):
        prev = dser[dser < td]
        if len(prev):
            t1[td.strftime("%Y-%m-%d")] = prev.iloc[-1].strftime("%Y-%m-%d")
    ev = ev[ev["trade_date"].isin(t1.keys())].copy()
    if not len(ev):
        return ev
    ev["t1_date"] = ev["trade_date"].map(t1)
    # realized forward outcome: day change on the event day itself from OHLCV
    # fwd.date arrives as Timestamp (PG DATE) while ev.trade_date is TEXT -- merging
    # them raw matched NOTHING and silently NaN-ed every outcome (found 2026-08-25).
    fwd = pd.read_sql(
        f"SELECT symbol, date, "
        f"ROUND(100.0 * (close / NULLIF(LAG(close) OVER (PARTITION BY symbol ORDER BY date), 0) - 1)::numeric, 4) "
        f"AS fwd_ret FROM stock_ohlcv WHERE date >= '{min(t1.values())}'",
        engine)
    fwd["date"] = fwd["date"].astype(str)
    ev = ev.merge(fwd.rename(columns={"date": "trade_date"}),
                  on=["symbol", "trade_date"], how="left")
    return ev


def load_factors_for_date(engine, t1_date: str) -> pd.DataFrame:
    """Wide frame: one row per symbol of T-1 factor values. Missing pieces -> NaN.

    Dates are inlined (not bound params) because each template's placeholder count
    differs; t1_date is always an ISO date string we produced ourselves.
    """
    d = t1_date
    wide = None
    for fam, tpl in FACTOR_SQL.items():
        try:
            if fam == "momentum":
                lo = (pd.Timestamp(d) - pd.Timedelta(days=60)).strftime("%Y-%m-%d")
                sql = tpl.replace("s.date <= ?", f"s.date <= '{d}'") \
                         .replace("s.date >= ?", f"s.date >= '{lo}'")
            else:
                sql = tpl.replace("?", f"'{d}'")
            df = pd.read_sql(sql, engine)
            wide = df if wide is None else wide.merge(df, on="symbol", how="outer")
        except Exception as e:
            # tail, not head -- the SQL prefix is useless; the driver's message is at the end
            print(f"[study] factor family '{fam}' unavailable (...{str(e)[-220:]}) -> skipped", file=sys.stderr)
    if wide is None:
        return pd.DataFrame(columns=["symbol"])
    for c in wide.columns:
        if c != "symbol":
            wide[c] = pd.to_numeric(wide[c], errors="coerce")
    return wide


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def _rank_ic(x: pd.Series, y: pd.Series) -> float:
    """Spearman rank correlation, NaN-safe."""
    ok = x.notna() & y.notna()
    if ok.sum() < 30:
        return float("nan")
    return float(x[ok].rank().corr(y[ok].rank()))


def factor_ic_table(ev: pd.DataFrame, fac: pd.DataFrame) -> pd.DataFrame:
    """Per-factor Spearman IC vs realized same-day mover returns (event days)."""
    if not len(ev) or not len(fac):
        return pd.DataFrame()
    m = ev[["symbol", "fwd_ret"]].merge(fac, on="symbol", how="inner")
    rows = []
    for col in [c for c in fac.columns if c.startswith("f_")]:
        rows.append({"factor": col, "ic": round(_rank_ic(m[col], m["fwd_ret"]), 4),
                     "n": int((m[col].notna() & m["fwd_ret"].notna()).sum())})
    out = pd.DataFrame(rows).dropna(subset=["ic"])
    return out.sort_values("ic", ascending=False) if len(out) else out


def cohort_lift_table(ev: pd.DataFrame, fac: pd.DataFrame,
                      classes: list | None = None) -> pd.DataFrame:
    """P(class member | factor top-quartile) / P(... | bottom-quartile), per class x factor.

    Computed per class so a factor that predicts gap-ups but not breakouts stays visible
    instead of being washed out by aggregation.
    """
    if not len(ev) or not len(fac):
        return pd.DataFrame()
    fcols = [c for c in fac.columns if c.startswith("f_")]
    ev_u = ev[["source", "symbol"]].drop_duplicates()
    base_classes = classes or sorted(ev_u["source"].unique())
    universe_n = max(1, len(fac))
    rows = []
    for cls in base_classes:
        members = set(ev_u[ev_u["source"] == cls]["symbol"]) & set(fac["symbol"])
        if len(members) < 10:
            continue
        member_mask = fac["symbol"].isin(members)
        for col in fcols:
            s = fac[col]
            q1, q3 = s.quantile(0.25), s.quantile(0.75)
            if pd.isna(q1) or pd.isna(q3) or q1 == q3:
                continue
            top, bot = s >= q3, s <= q1
            p_top = len(fac.loc[top & member_mask, "symbol"]) / max(1, int(top.sum()))
            p_bot = len(fac.loc[bot & member_mask, "symbol"]) / max(1, int(bot.sum()))
            if p_bot <= 0:
                continue
            rows.append({"class": cls, "factor": col,
                         "lift": round(p_top / p_bot, 3),
                         "p_top": round(p_top, 4), "p_bot": round(p_bot, 4),
                         "n_members": len(members)})
    out = pd.DataFrame(rows)
    return out.sort_values("lift", ascending=False) if len(out) else out


# ---------------------------------------------------------------------------
# Engine hit-rate: are we even SEEING tomorrow's winners today?
# ---------------------------------------------------------------------------

def engine_hit_rate(events: pd.DataFrame, top_n: int = 20) -> pd.DataFrame:
    """Of the movers on date D, what share did each ranking engine hold in its top-N on T-1?

    Engines audited: unified_signals.technical_score (per-day snapshot) and
    confluence_signals.confluence_score (latest computed_at strictly before D).
    """
    engine = get_engine()
    try:
        sig = pd.read_sql("SELECT signal_date AS d, symbol, technical_score "
                          "FROM unified_signals WHERE technical_score IS NOT NULL", engine)
    except Exception:
        sig = pd.DataFrame()
    try:
        conf = pd.read_sql("SELECT DATE(computed_at) AS d, symbol, confluence_score "
                           "FROM confluence_signals", engine)
    except Exception:
        conf = pd.DataFrame()
    truth = {td: set(g["symbol"]) for td, g in events.groupby("trade_date")}
    rows = []
    for label, df, col in (("technical_rank", sig, "technical_score"),
                           ("confluence_rank", conf, "confluence_score")):
        if not len(df):
            continue
        df = df.copy()
        df["d"] = df["d"].astype(str)
        for td, members in sorted(truth.items()):
            avail = sorted(d for d in df["d"].unique() if str(d) < str(td))
            if not avail:
                continue
            snap = df[(df["d"] == avail[-1]) & df[col].notna() & (df[col] > 0)]
            if len(snap) < max(50, top_n * 2):
                continue
            tops = set(snap.nlargest(top_n, col)["symbol"])
            rows.append({"engine": label, "event_date": td, "asof": avail[-1],
                         "top_n": top_n,
                         "hit_rate": round(len(tops & members) / max(1, len(members)), 4),
                         "n_movers": len(members)})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Persistence + report
# ---------------------------------------------------------------------------

RESULTS_DDL = """
CREATE TABLE IF NOT EXISTS mover_study_results (
    id           SERIAL PRIMARY KEY,
    run_at       TEXT NOT NULL,
    study_kind   TEXT NOT NULL,
    class_name   TEXT,
    factor       TEXT,
    metric       TEXT,
    value        REAL,
    n_obs        INTEGER,
    detail_json  TEXT
)
"""


def ensure_results_schema(con) -> None:
    cur = con.cursor()
    cur.execute(translate(RESULTS_DDL))
    con.commit()


def persist_results(con, run_at: str, ic: pd.DataFrame, lift: pd.DataFrame,
                    hits: pd.DataFrame) -> int:
    cur = con.cursor()
    n = 0
    # NOTE: `df or pd.DataFrame()` is ambiguous for DataFrames (ValueError on bool());
    # these are always DataFrames, so guard on len() instead.
    for _, r in (ic if ic is not None and len(ic) else pd.DataFrame()).iterrows():
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, factor, metric, value, n_obs) "
                              "VALUES (?,?,?,?,?,?)"),
                    (run_at, "factor_ic", r["factor"], "spearman_ic", r["ic"], int(r["n"])))
        n += 1
    for _, r in (lift if lift is not None and len(lift) else pd.DataFrame()).iterrows():
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, class_name, factor, metric, value, n_obs) "
                              "VALUES (?,?,?,?,?,?,?)"),
                    (run_at, "cohort_lift", r["class"], r["factor"], "lift_q3_over_q1",
                     r["lift"], int(r["n_members"])))
        n += 1
    for _, r in (hits if hits is not None and len(hits) else pd.DataFrame()).iterrows():
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, class_name, metric, value, n_obs, detail_json) "
                              "VALUES (?,?,?,?,?,?,?)"),
                    (run_at, "engine_hit_rate", f"{r['engine']}@top{int(r['top_n'])}",
                     "hit_rate", r["hit_rate"], int(r["n_movers"]),
                     json.dumps({"asof": str(r["asof"]), "event_date": str(r["event_date"])})))
        n += 1
    con.commit()
    return n


def _md_table(df: pd.DataFrame, max_rows: int = 15) -> str:
    if df is None or not len(df):
        return "_no data_\n"
    d = df.head(max_rows).copy()
    return d.to_markdown(index=False)


def write_report(run_at: str, ev: pd.DataFrame, ic: pd.DataFrame, lift: pd.DataFrame,
                 hits: pd.DataFrame, out_path: str) -> None:
    lines = [
        "# Mover Reverse-Engineering Study", "",
        f"Run: `{run_at}`  |  events analyzed: **{len(ev):,}** across "
        f"{ev['source'].nunique() if len(ev) else 0} classes", "",
        "## Event counts by class", "",
        (ev.groupby("source").size().rename("events").to_frame()
           .to_markdown() if len(ev) else "_none_"), "",
        "## Factor rank-IC vs realized mover returns", "",
        _md_table(ic), "",
        "## Cohort lift (P(mover | top-quartile factor) / P(mover | bottom-quartile))", "",
        _md_table(lift), "",
        "## Engine hit-rate (movers found in engine top-N on T-1)", "",
        (_md_table(hits.assign(hit_rate_pct=(hits["hit_rate"] * 100).round(2))
                   [["engine", "event_date", "asof", "top_n", "hit_rate_pct",
                     "n_movers"]]) if len(hits) else
         "_engines had no T-1 snapshots for the event window_"), "",
        "### How to read this",
        "- IC > ~0.05 with decent n = factor carries real information about which movers pay.",
        "- Lift > 1.5 on a class = conditioning signal worth adding to that detector's ranker.",
        "- Hit-rate near 0% = the engine never saw the mover coming; that gap, not the math, "
        "is the first thing to fix.",
    ]
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Reverse-engineer what drives mover stocks")
    ap.add_argument("--days", type=int, default=90, help="event lookback window in days")
    ap.add_argument("--classes", type=str, default="",
                    help="comma-separated mover classes (default: all)")
    ap.add_argument("--top-n", type=int, default=20,
                    help="engine top-N list size for the hit-rate audit")
    ap.add_argument("--report", type=str, default="docs/mover_study_report.md")
    args = ap.parse_args()
    classes = [c.strip() for c in args.classes.split(",") if c.strip()] or None

    t0 = time.time()
    run_at = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    engine = get_engine()

    ev = load_events(args.days, classes, engine)
    print(f"[study] events: {len(ev):,} rows across "
          f"{ev['source'].nunique() if len(ev) else 0} classes "
          f"({ev['trade_date'].nunique() if len(ev) else 0} dates)")

    # T-1 factor snapshot per event date (cached: many events share a date)
    fac_frames = {}
    for d in sorted(set(ev["t1_date"]) if len(ev) else []):
        fac_frames[d] = load_factors_for_date(engine, d)
        print(f"[study] factors loaded for T-1 {d}: {len(fac_frames[d])} symbols")

    ic_parts, lift_parts = [], []
    for d, fac in fac_frames.items():
        ev_d = ev[ev["t1_date"] == d]
        ic_d = factor_ic_table(ev_d, fac)
        if len(ic_d):
            ic_d.insert(0, "t1_date", d)
        ic_parts.append(ic_d)
        lift_d = cohort_lift_table(ev_d, fac, classes=classes)
        if len(lift_d):
            lift_d.insert(0, "t1_date", d)
        lift_parts.append(lift_d)
    ic = pd.concat([p for p in ic_parts if len(p)], ignore_index=True) if ic_parts \
        else pd.DataFrame()
    lift = pd.concat([p for p in lift_parts if len(p)], ignore_index=True) if lift_parts \
        else pd.DataFrame()
    hits = engine_hit_rate(ev, top_n=args.top_n)

    con = connect()
    ensure_results_schema(con)
    persisted = persist_results(con, run_at, ic, lift, hits)
    con.close()
    write_report(run_at, ev, ic, lift, hits, args.report)

    print(f"[study] persisted {persisted} result rows; report -> {args.report} "
          f"({time.time() - t0:.1f}s)")


if __name__ == "__main__":
    main()






def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
