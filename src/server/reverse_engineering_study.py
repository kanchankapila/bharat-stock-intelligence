"""
Mover Reverse-Engineering Study
===============================
Answers "why do mover stocks move?" with data instead of folklore:

For every ground-truth mover day (from `mover_snapshots`), it reconstructs the PRE-EVENT
state of each stock (features as of T-1 close) from tables we already store, then measures:

  1. Rank-IC  -- Spearman correlation between each factor's T-1 value and the realized
                 event-day return, reported separately for movers and the eligible cross-section.
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


# Whole-market and "near high/low" snapshots are context, not mover truth.  Including them in
# the old default made nearly every listed stock a "mover" and mechanically drove top-20 engine
# hit rates toward 1%.  Keep the default to the concrete cohorts the trading desk actually asks
# us to predict.  Callers can still opt into another source explicitly with --classes.
DEFAULT_MOVER_CLASSES = [
    "calc_gap_up", "calc_gap_down", "calc_open_eq_low", "calc_open_eq_high",
    "calc_volume_shocker", "calc_intraday_breakout", "nt_top_gainers",
    "mojo_gainers", "mojo_losers", "mc_price_shockers", "nteod_gain5",
    "nteod_loss5", "nteod_high_delivery",
]

MIN_ADT_CR = 1.0
EVENT_PREOPEN_FACTORS = {"f_preopen_gap_pct", "f_preopen_imbalance"}

# ---------------------------------------------------------------------------
# Config: factor families -> concrete columns that exist today.
# Every lookup is defensive: a missing table/column degrades to NaN, never crashes.
# ---------------------------------------------------------------------------

FACTOR_SQL = {
    # `nifty` must stay MATERIALIZED: inlined, the planner (row estimate 2 vs ~100k actual)
    # re-scanned the whole `latest` window once per symbol -- 7.9s per T-1 date vs 0.22s,
    # ~90% of the 250-day study's runtime (2026-10-15).
    "momentum": """
        WITH bars AS (
            SELECT symbol, date, close,
                   LAG(close, 5) OVER (PARTITION BY symbol ORDER BY date) AS close_5d,
                   LAG(close, 21) OVER (PARTITION BY symbol ORDER BY date) AS close_21d
            FROM stock_ohlcv WHERE date <= ? AND date >= ? AND COALESCE(is_suspect, 0) = 0
        ), latest AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
            FROM bars
        ), nifty AS MATERIALIZED (
            SELECT date, close / NULLIF(close_21d, 0) - 1 AS nifty_ret_21d
            FROM latest WHERE symbol = 'NIFTY50'
        )
        SELECT l.symbol,
               ROUND(100.0 * (l.close / NULLIF(l.close_5d, 0) - 1)::numeric, 4) AS f_mom_5d,
               ROUND(100.0 * (l.close / NULLIF(l.close_21d, 0) - 1)::numeric, 4) AS f_mom_21d,
               ROUND(100.0 * ((l.close / NULLIF(l.close_21d, 0) - 1) - n.nifty_ret_21d)::numeric, 4)
                   AS f_rs_vs_nifty
        FROM latest l LEFT JOIN nifty n ON n.date = l.date
        WHERE l.rn = 1 AND l.symbol <> 'NIFTY50'""",
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
        WITH deals AS (
            SELECT symbol,
                   SUM(net_qty)::float        AS f_block_net_qty_30d,
                   SUM(total_value_cr)::float AS f_block_value_cr_30d
            FROM stock_block_deal_daily
            WHERE date <= ? AND date > ?
            GROUP BY symbol
        ), mf AS (
            SELECT symbol, mf_holding_pct AS f_mf_holding_pct,
                   chg_vs_prev AS f_mf_holding_change
            FROM (
                SELECT symbol, date, mf_holding_pct, chg_vs_prev,
                       ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
                FROM stock_mf_holdings
                WHERE date <= ? AND date > ?
            ) x WHERE rn = 1
        )
        SELECT COALESCE(d.symbol, m.symbol) AS symbol,
               d.f_block_net_qty_30d, d.f_block_value_cr_30d,
               m.f_mf_holding_pct, m.f_mf_holding_change
        FROM deals d FULL OUTER JOIN mf m ON m.symbol = d.symbol""",
    "fundamentals": """
        SELECT symbol, MAX(CASE WHEN rn = 1 THEN earnings_yield END) AS f_earnings_yield
        FROM (
            SELECT fs.symbol, fs.date, fs.earnings_yield,
                   ROW_NUMBER() OVER (PARTITION BY fs.symbol ORDER BY fs.date DESC) AS rn
            FROM historical_fundamentals fs
            WHERE fs.date <= ?
        ) WHERE rn = 1 GROUP BY symbol""",
    # 2026-09-15 extension (P1-6): pre-open microstructure, F&O positioning, news tone.
    # Same defensive contract as every family above: a missing table/column degrades to a
    # loader-caught exception (family skipped), never a fabricated value.
    "preopen": """
        SELECT symbol, MAX(iep_gap_pct)      AS f_preopen_gap_pct,
                      MAX(preopen_imbalance) AS f_preopen_imbalance
        FROM preopen_stock_snapshot
        WHERE snapshot_date = ? GROUP BY symbol""",
    "fno_positioning": """
        SELECT symbol, MAX(CASE WHEN rn = 1 THEN pcr END)       AS f_so_pcr,
                      MAX(CASE WHEN rn = 1 THEN fut_oi_chg END) AS f_fut_oi_chg
        FROM (
            SELECT symbol, date, pcr, fut_oi_chg,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
            FROM so_stock_oi_summary
            WHERE date <= ? AND date > (DATE ? - INTERVAL '5 days')
        ) t WHERE rn = 1 GROUP BY symbol""",
    "news": """
        SELECT symbol, AVG(sentiment_score) AS f_news_sent,
               COUNT(*)::float              AS f_news_count
        FROM news_symbol_link
        WHERE published_at::date <= ? AND published_at::date > (DATE ? - INTERVAL '3 days')
        GROUP BY symbol""",
}

# ---------------------------------------------------------------------------
# Event loading
# ---------------------------------------------------------------------------

def load_eligible_universe(engine, event_dates) -> pd.DataFrame:
    """Point-in-time comparison population with a clean outcome and pre-event liquidity.

    Membership comes from NSE's historical bhavcopy, not today's active master.  The current
    master is used only as a durable instrument-identity veto for known ETFs; an absent master
    row is retained so delisted equities are not removed retrospectively.

    ADT uses 20 prior observed bars and tolerates one suspect/missing-volume bar inside them.
    That bar contributes nothing to the average. Requiring 20/20 clean barred 876 liquid names
    on 2026-10-13 and distorted 18 sessions after NSE's 2026-09-14 suspect batch.
    """
    dates = sorted({pd.Timestamp(d).strftime("%Y-%m-%d") for d in event_dates})
    cols = ["symbol", "trade_date", "fwd_ret", "intraday_ret", "adt20_cr"]
    if not dates:
        return pd.DataFrame(columns=cols)
    history_floor = (pd.Timestamp(dates[0]) - pd.Timedelta(days=60)).strftime("%Y-%m-%d")
    date_sql = ",".join("'" + d.replace("'", "''") + "'" for d in dates)
    eligible = pd.read_sql(
        "WITH bars AS ("
        " SELECT symbol, date, is_suspect, open, close, volume,"
        " LAG(close) OVER (PARTITION BY symbol ORDER BY date) AS prev_close,"
        " LAG(COALESCE(is_suspect, 0)) OVER (PARTITION BY symbol ORDER BY date) AS prev_suspect,"
        " COUNT(*) OVER (PARTITION BY symbol ORDER BY date"
        "          ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS prior_rows,"
        " AVG(CASE WHEN COALESCE(is_suspect, 0)=0 AND close > 0 AND volume IS NOT NULL"
        "          THEN close * volume END) OVER (PARTITION BY symbol ORDER BY date"
        "          ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) / 10000000.0 AS adt20_cr,"
        " COUNT(CASE WHEN COALESCE(is_suspect, 0)=0 AND close > 0 AND volume IS NOT NULL"
        "            THEN 1 END) OVER (PARTITION BY symbol ORDER BY date"
        "            ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS adt_obs"
        f" FROM stock_ohlcv WHERE date >= '{history_floor}' AND date <= '{dates[-1]}'"
        ") SELECT b.symbol, b.date AS trade_date,"
        " ROUND(100.0 * (b.close / NULLIF(b.prev_close, 0) - 1)::numeric, 4) AS fwd_ret,"
        " ROUND(100.0 * (b.close / NULLIF(b.open, 0) - 1)::numeric, 4) AS intraday_ret,"
        " b.adt20_cr"
        " FROM bars b"
        f" WHERE b.date IN ({date_sql})"
        " AND COALESCE(b.is_suspect, 1)=0 AND COALESCE(b.prev_suspect, 1)=0"
        " AND b.open > 0 AND b.close > 0 AND b.prev_close > 0"
        " AND b.prior_rows=20 AND b.adt_obs>=19"
        f" AND b.adt20_cr >= {MIN_ADT_CR}"
        " AND EXISTS (SELECT 1 FROM nse_universe_history u"
        "             WHERE u.date=b.date AND u.symbol=b.symbol AND u.series='EQ')"
        " AND NOT EXISTS (SELECT 1 FROM nse_stocks m"
        "                 WHERE m.symbol=b.symbol AND m.instrument_type='etf')",
        engine,
    )
    if not len(eligible):
        return pd.DataFrame(columns=cols)
    eligible["trade_date"] = eligible["trade_date"].astype(str)
    return eligible.drop_duplicates(["symbol", "trade_date"])[cols]


def load_events(days: int, classes: list | None, engine) -> pd.DataFrame:
    events, _ = load_events_and_universe(days, classes, engine)
    return events


def load_events_and_universe(days: int, classes: list | None, engine):
    """Load unique, liquid, non-suspect ground-truth mover events.

    Liquidity is measured only from sessions preceding the event, so the universe filter is
    knowable before the move.  The event-day return is close-to-close and is never taken from a
    vendor's claimed percentage.
    """
    cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    selected = classes or DEFAULT_MOVER_CLASSES
    selected_sql = ",".join("'" + s.replace("'", "''") + "'" for s in selected)
    ev = pd.read_sql(f"SELECT source, trade_date, symbol, pct_change FROM mover_snapshots "
                     f"WHERE trade_date >= '{cutoff}' AND source IN ({selected_sql}) "
                     f"ORDER BY trade_date DESC, source, symbol", engine)
    if len(ev) == 0:
        return ev, pd.DataFrame(columns=["symbol", "trade_date", "fwd_ret", "intraday_ret", "adt20_cr"])
    # A source can be captured repeatedly during a session.  A mover event is one
    # (source, session, symbol), not one row per poll.
    ev = ev.drop_duplicates(["source", "trade_date", "symbol"], keep="last")
    # drop our own synthetic index rows and any non-equity junk defensively
    ev = ev[~ev["symbol"].astype(str).str.contains("NIFTY|SENSEX|^USD", na=False)]
    # Use NSE's point-in-time universe as the session authority, not vendor OHLCV.  The latter
    # can contain convincing whole-universe bars on a non-session date: 2026-07-11 (Saturday)
    # had 2,121 OHLCV rows and 1,424 mover snapshots but no nse_universe_history record.  Treating
    # it as a trading day contaminated both its own outcome and Monday's T-1 mapping.
    dates = pd.read_sql("SELECT DISTINCT date FROM nse_universe_history ORDER BY date", engine)
    ev = _attach_trading_sessions(ev, dates["date"])
    if not len(ev):
        return ev, pd.DataFrame(columns=["symbol", "trade_date", "fwd_ret", "intraday_ret", "adt20_cr"])

    eligible = load_eligible_universe(engine, ev["trade_date"].unique())
    ev = ev.merge(eligible, on=["symbol", "trade_date"], how="inner")
    return ev, eligible


def _attach_trading_sessions(ev: pd.DataFrame, session_dates) -> pd.DataFrame:
    """Drop non-session events and attach the preceding authoritative NSE session."""
    if not len(ev):
        return ev.copy()
    dser = pd.Series(pd.to_datetime(pd.Series(session_dates), errors="coerce").dropna().unique())
    dser = dser.sort_values().reset_index(drop=True)
    valid = set(dser.dt.strftime("%Y-%m-%d"))
    out = ev.copy()
    out["trade_date"] = out["trade_date"].astype(str)
    out = out[out["trade_date"].isin(valid)].copy()
    t1 = {}
    for td in pd.to_datetime(out["trade_date"].unique()):
        prev = dser[dser < td]
        if len(prev):
            t1[td.strftime("%Y-%m-%d")] = prev.iloc[-1].strftime("%Y-%m-%d")
    out = out[out["trade_date"].isin(t1)].copy()
    out["t1_date"] = out["trade_date"].map(t1)
    return out


def _render_dates(template: str, *dates: str) -> str:
    """Replace positional date markers one at a time and fail on a count mismatch."""
    sql = template
    for value in dates:
        if "?" not in sql:
            raise ValueError("too many date values for factor SQL template")
        sql = sql.replace("?", "'" + value.replace("'", "''") + "'", 1)
    if "?" in sql:
        raise ValueError("not enough date values for factor SQL template")
    return sql


def load_factors_for_date(engine, t1_date: str, event_date: str | None = None) -> pd.DataFrame:
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
                sql = _render_dates(tpl, d, lo)
            elif fam in {"fno", "delivery"}:
                lo = (pd.Timestamp(d) - pd.Timedelta(days=30)).strftime("%Y-%m-%d")
                sql = _render_dates(tpl, d, lo)
            elif fam == "flows":
                # Both subqueries need their own as-of/lookback pair. Reusing a single pair
                # implicitly is not supported by `_render_dates`: every marker is positional so
                # a template change fails loudly instead of silently binding the wrong date.
                lo = (pd.Timestamp(d) - pd.Timedelta(days=30)).strftime("%Y-%m-%d")
                sql = _render_dates(tpl, d, lo, d, lo)
            elif fam == "preopen":
                # The event-session pre-open snapshot exists before the 09:15 entry and is
                # therefore usable; using T-1 here discarded the very gap signal being studied.
                sql = _render_dates(tpl, event_date or d)
            elif fam in {"fno_positioning", "news"}:
                sql = _render_dates(tpl, d, d)
            else:
                sql = _render_dates(tpl, d)
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
    xr, yr = x[ok].rank(), y[ok].rank()
    if xr.nunique(dropna=True) < 2 or yr.nunique(dropna=True) < 2:
        return float("nan")
    return float(xr.corr(yr))


def factor_ic_table(ev: pd.DataFrame, fac: pd.DataFrame,
                    scope: str = "mover_cohort") -> pd.DataFrame:
    """Per-factor Spearman IC vs realized same-day mover returns (event days)."""
    if not len(ev) or not len(fac):
        return pd.DataFrame()
    # One symbol can appear in several mover sources on the same day.  Counting it once per
    # source would overweight the most duplicated vendor consensus names in the IC.
    outcome_cols = ["symbol", "fwd_ret"]
    if "intraday_ret" in ev.columns:
        outcome_cols.append("intraday_ret")
    m = ev[outcome_cols].drop_duplicates("symbol").merge(
        fac, on="symbol", how="inner")
    rows = []
    for col in [c for c in fac.columns if c.startswith("f_")]:
        if col in EVENT_PREOPEN_FACTORS and "intraday_ret" not in m.columns:
            continue
        outcome = ("open_to_close" if col in EVENT_PREOPEN_FACTORS
                   else "prior_close_to_close")
        target = "intraday_ret" if outcome == "open_to_close" else "fwd_ret"
        rows.append({"scope": scope, "factor": col,
                     "outcome": outcome, "metric": "spearman_ic",
                     "ic": round(_rank_ic(m[col], m[target]), 4),
                     "n": int((m[col].notna() & m[target].notna()).sum())})
        # Close-to-close includes the overnight gap, which is not harvestable here
        # (AF-20261025-08); grade the same factor on the open-to-close leg too.
        if col not in EVENT_PREOPEN_FACTORS and "intraday_ret" in m.columns:
            rows.append({"scope": scope, "factor": col,
                         "outcome": "open_to_close", "metric": "spearman_ic_o2c",
                         "ic": round(_rank_ic(m[col], m["intraday_ret"]), 4),
                         "n": int((m[col].notna() & m["intraday_ret"].notna()).sum())})
    out = pd.DataFrame(rows).dropna(subset=["ic"])
    return out.sort_values("ic", ascending=False) if len(out) else out


def cohort_lift_table(ev: pd.DataFrame, fac: pd.DataFrame,
                      classes: list | None = None,
                      eligible_symbols=None) -> pd.DataFrame:
    """P(class member | factor top-quartile) / P(... | bottom-quartile), per class x factor.

    Computed per class so a factor that predicts gap-ups but not breakouts stays visible
    instead of being washed out by aggregation.
    """
    if eligible_symbols is None:
        raise ValueError("eligible_symbols is required for an honest cohort denominator")
    eligible = set(eligible_symbols)
    fac = fac[fac["symbol"].isin(eligible)].drop_duplicates("symbol").copy()
    if not len(ev) or not len(fac):
        return pd.DataFrame()
    fcols = [c for c in fac.columns if c.startswith("f_")]
    ev_u = ev[["source", "symbol"]].drop_duplicates()
    base_classes = classes or sorted(ev_u["source"].unique())
    universe_n = len(fac)
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
                         "factor_timing": ("event_preopen" if col in EVENT_PREOPEN_FACTORS
                                           else "prior_close"),
                         "lift": round(p_top / p_bot, 3),
                         "p_top": round(p_top, 4), "p_bot": round(p_bot, 4),
                         "n_members": len(members), "universe_n": universe_n,
                         "factor_n": int(s.notna().sum())})
    out = pd.DataFrame(rows)
    return out.sort_values("lift", ascending=False) if len(out) else out


def summarize_factor_ic(ic: pd.DataFrame) -> pd.DataFrame:
    """Aggregate IC per date; never let the latest date masquerade as the whole study."""
    if ic is None or not len(ic):
        return pd.DataFrame()
    if "metric" in ic.columns:
        is_o2c = ic["metric"] == "spearman_ic_o2c"
        out = summarize_factor_ic(ic[~is_o2c].drop(columns=["metric"]))
        o2c = summarize_factor_ic(ic[is_o2c].drop(columns=["metric"]))
        if not len(out) or not len(o2c):
            return out
        keys = [c for c in ("scope", "factor") if c in out.columns]
        o2c = o2c[keys + ["mean_ic", "median_ic", "positive_dates", "t_stat", "dates", "total_n"]].rename(
            columns={"mean_ic": "mean_ic_o2c", "median_ic": "median_ic_o2c",
                     "positive_dates": "positive_dates_o2c", "t_stat": "t_stat_o2c",
                     "dates": "dates_o2c", "total_n": "total_n_o2c"})
        return out.merge(o2c, on=keys, how="left")
    rows = []
    group_cols = [c for c in ("scope", "outcome", "factor") if c in ic.columns]
    for keys, g in ic.groupby(group_cols):
        keys = keys if isinstance(keys, tuple) else (keys,)
        labels = dict(zip(group_cols, keys))
        scope, factor = labels.get("scope"), labels["factor"]
        values = pd.to_numeric(g["ic"], errors="coerce").dropna()
        if not len(values):
            continue
        sd = float(values.std(ddof=1)) if len(values) > 1 else float("nan")
        mean = float(values.mean())
        t_stat = (mean / (sd / np.sqrt(len(values)))
                  if len(values) > 1 and np.isfinite(sd) and sd > 0 else float("nan"))
        row = {
            "factor": factor,
            "mean_ic": round(mean, 4),
            "median_ic": round(float(values.median()), 4),
            "positive_dates": int((values > 0).sum()),
            "dates": int(len(values)),
            "t_stat": round(float(t_stat), 2) if np.isfinite(t_stat) else np.nan,
            "total_n": int(pd.to_numeric(g["n"], errors="coerce").fillna(0).sum()),
        }
        if scope is not None:
            row = {"scope": scope, **row}
        if "outcome" in labels:
            row = {"outcome": labels["outcome"], **row}
        rows.append(row)
    out = pd.DataFrame(rows)
    return out.sort_values("mean_ic", ascending=False) if len(out) else out


def summarize_cohort_lift(lift: pd.DataFrame) -> pd.DataFrame:
    """Per-class median lift and sign consistency across independent event dates."""
    if lift is None or not len(lift):
        return pd.DataFrame()
    rows = []
    for (cls, factor), g in lift.groupby(["class", "factor"]):
        values = pd.to_numeric(g["lift"], errors="coerce").dropna()
        if not len(values):
            continue
        rows.append({
            "class": cls, "factor": factor,
            "median_lift": round(float(values.median()), 3),
            "mean_lift": round(float(values.mean()), 3),
            "lift_gt_1_dates": int((values > 1).sum()),
            "dates": int(len(values)),
            "avg_members": round(float(pd.to_numeric(
                g["n_members"], errors="coerce").mean()), 1),
        })
    out = pd.DataFrame(rows)
    if not len(out):
        return out
    # Consistency first. A huge one-date ratio with a tiny bottom-quartile denominator must not
    # outrank a factor that repeats over the full study window.
    out["positive_share"] = out["lift_gt_1_dates"] / out["dates"]
    return out.sort_values(["positive_share", "dates", "median_lift"],
                           ascending=[False, False, False]).drop(columns=["positive_share"])


# ---------------------------------------------------------------------------
# Engine hit-rate: are we even SEEING tomorrow's winners today?
# ---------------------------------------------------------------------------

def engine_hit_rate(events: pd.DataFrame, top_n: int = 20) -> pd.DataFrame:
    """Of the movers on date D, what share did each ranking engine hold in its top-N on T-1?

    Engines audited: unified_signals.technical_score (per-day snapshot),
    confluence_signals.confluence_score (latest computed_at strictly before D), and
    intraday_recommendations.intraday_score (latest computed_ts strictly before D --
    added 2026-09-15, P1-6; the intraday engine refreshes many times a day, so its
    "T-1 snapshot" is the last full run of the prior session).
    """
    engine = get_engine()
    dmin = ((pd.Timestamp(str(events["trade_date"].min())) - pd.Timedelta(days=7))
            .strftime("%Y-%m-%d") if len(events) else "1900-01-01")
    try:
        sig = pd.read_sql("SELECT COALESCE(created_at, signal_date) AS ts, symbol, technical_score "
                          "FROM unified_signals WHERE technical_score IS NOT NULL "
                          f"AND COALESCE(created_at, signal_date) >= '{dmin}'", engine)
    except Exception:
        sig = pd.DataFrame()
    try:
        conf = pd.read_sql("SELECT computed_at AS ts, symbol, confluence_score "
                           "FROM confluence_signals "
                           f"WHERE computed_at >= '{dmin}'", engine)
    except Exception:
        conf = pd.DataFrame()
    # intraday_recommendations is by far the highest-frequency of the three (dozens of
    # runs/day over the full universe), so bound the read to the event window instead of
    # loading the table's whole history: earliest event date minus a 5-day cushion still
    # gives every event a T-1 snapshot. dmin comes from our own mover_snapshots ISO dates.
    intr = pd.DataFrame()
    if len(events):
        try:
            intr = pd.read_sql(f"SELECT computed_ts AS ts, symbol, intraday_score "
                               f"FROM intraday_recommendations "
                               f"WHERE intraday_score IS NOT NULL AND DATE(computed_ts) >= '{dmin}'",
                               engine)
        except Exception:
            intr = pd.DataFrame()
    truth = {td: set(g["symbol"]) for td, g in events.groupby("trade_date")}
    rows = []
    for label, df, col in (("technical_rank", sig, "technical_score"),
                           ("confluence_rank", conf, "confluence_score"),
                           ("intraday_rank", intr, "intraday_score")):
        if not len(df):
            continue
        df = df.copy()
        df["ts"] = pd.to_datetime(df["ts"], utc=True, errors="coerce")
        df = df.dropna(subset=["ts", col, "symbol"])
        for td, members in sorted(truth.items()):
            cutoff = pd.Timestamp(str(td), tz="UTC") + pd.Timedelta(hours=3, minutes=45)
            eligible = df[(df["ts"] < cutoff) & (df["ts"] >= cutoff - pd.Timedelta(days=7))]
            if not len(eligible):
                continue
            # One score per symbol, from its latest row known before the market opened.  The old
            # date-only nlargest() could select the same symbol many times from intraday runs.
            snap = (eligible.sort_values("ts").drop_duplicates("symbol", keep="last"))
            snap = snap[snap[col] > 0]
            if len(snap) < max(50, top_n * 2):
                continue
            tops = set(snap.nlargest(top_n, col)["symbol"])
            rows.append({"engine": label, "event_date": td,
                          "asof": eligible["ts"].max().isoformat(),
                          "top_n": top_n,
                          "hits_found": len(tops & members),
                          "hit_rate": round(len(tops & members) / max(1, len(members)), 4),
                          "n_movers": len(members)})
    return pd.DataFrame(rows)


def summarize_engine_hits(hits: pd.DataFrame) -> pd.DataFrame:
    if hits is None or not len(hits):
        return pd.DataFrame()
    h = hits.copy()
    if "hits_found" not in h:
        h["hits_found"] = (h["hit_rate"] * h["n_movers"]).round().astype(int)
    return (h.groupby("engine", as_index=False)
            .agg(dates=("event_date", "nunique"), top_n=("top_n", "max"),
                 hits_found=("hits_found", "sum"), movers=("n_movers", "sum"),
                 mean_hit_rate=("hit_rate", "mean"),
                 max_hit_rate=("hit_rate", "max"))
            .assign(mean_hit_rate_pct=lambda x: (100 * x["mean_hit_rate"]).round(2),
                    max_hit_rate_pct=lambda x: (100 * x["max_hit_rate"]).round(2))
            .drop(columns=["mean_hit_rate", "max_hit_rate"])
            .sort_values("mean_hit_rate_pct", ascending=False))


def summarize_accuracy(accuracy: pd.DataFrame) -> pd.DataFrame:
    """Expose both total coverage and precision conditional on making a directional call."""
    if accuracy is None or not len(accuracy):
        return pd.DataFrame()
    matched = int(accuracy["matched"].sum())
    opposite = int(accuracy["opposite"].sum())
    not_flagged = int(accuracy["not_flagged"].sum())
    total = matched + opposite + not_flagged
    directional = matched + opposite
    return pd.DataFrame([{
        "dates": int(accuracy["event_date"].nunique()), "movers": total,
        "matched": matched, "opposite": opposite, "not_flagged": not_flagged,
        "matched_all_pct": round(100 * matched / max(1, total), 2),
        "opposite_all_pct": round(100 * opposite / max(1, total), 2),
        "not_flagged_pct": round(100 * not_flagged / max(1, total), 2),
        "directional_precision_pct": round(100 * matched / max(1, directional), 2),
    }])


# One polarity map for every grader here (canonical_signal_accuracy, call_confusion), so the
# two cannot drift.  Symmetric on purpose: the sell side used to match only the exact string
# "sell", so every "strong sell" scored side == 0 and was graded as "no opinion".  Strong Sell is
# the largest directional bucket in the live ranking (204 of 2,354 on 2026-10-24).
_LONG_CALLS = frozenset({"buy", "strong buy"})
_SHORT_CALLS = frozenset({"sell", "strong sell"})


def _call_side(classification) -> int:
    """+1 long call, -1 short call, 0 no directional opinion (Hold, blank, unknown)."""
    call = str(classification or "").strip().lower()
    return 1 if call in _LONG_CALLS else (-1 if call in _SHORT_CALLS else 0)


def _mover_bucket(symbol, calls: dict, ret: float) -> str:
    """Grade one mover: matched / opposite, or one of the three causes of 'not flagged'.

    A rated Hold is a calibration miss (we looked and said nothing), an absent snapshot row is a
    coverage miss (we never looked), and a flat tape is not a miss at all.
    """
    realized = 1 if ret > 0 else (-1 if ret < 0 else 0)
    if realized == 0:
        return "flat_outcome"
    if symbol not in calls:
        return "no_coverage"
    side = _call_side(calls[symbol])
    if side == 0:
        return "rated_hold"
    return "matched" if side == realized else "opposite"


def _load_preopen_recommendations(trade_dates) -> pd.DataFrame | None:
    """Every unified_recommendations row that can be the pre-open call for one of these dates."""
    ts = pd.to_datetime(pd.Series([str(d) for d in trade_dates]))
    dmin = (ts.min() - pd.Timedelta(days=10)).strftime("%Y-%m-%d")
    dmax = (ts.max() + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        recs = pd.read_sql(
            "SELECT symbol, classification, generated_at FROM unified_recommendations "
            f"WHERE generated_at >= '{dmin}' AND generated_at < '{dmax}'",
            get_engine(),
        )
    except Exception as exc:
        print(f"[study] pre-open recommendations unavailable (...{str(exc)[-220:]})",
              file=sys.stderr)
        return None
    recs["generated_at"] = pd.to_datetime(recs["generated_at"], utc=True, errors="coerce")
    return recs.dropna(subset=["symbol", "classification", "generated_at"])


def _preopen_snapshot(recs: pd.DataFrame, trade_date) -> pd.DataFrame:
    """Latest row per symbol generated in [cutoff - 7d, cutoff), cutoff = trade_date 03:45 UTC.

    A same-session post-open overwrite must never grade the session it was written in.
    """
    cutoff = pd.Timestamp(str(trade_date), tz="UTC") + pd.Timedelta(hours=3, minutes=45)
    return (recs[(recs["generated_at"] < cutoff)
                 & (recs["generated_at"] >= cutoff - pd.Timedelta(days=7))]
            .sort_values("generated_at").drop_duplicates("symbol", keep="last"))


_MOVER_BUCKETS = ("matched", "opposite", "rated_hold", "no_coverage", "flat_outcome")


# Bump when a grader's polarity or bucket rules change, so trend queries can split rows by era.
# Rows written before 2026-10-25 (Strong Sell treated as non-short) carry no grader_version key.
GRADER_VERSION = "2026-10-25-strong-sell"


def canonical_signal_accuracy(events: pd.DataFrame) -> pd.DataFrame:
    """Grade the canonical pre-open call as matched, opposite, or not flagged per date."""
    if not len(events):
        return pd.DataFrame()
    recs = _load_preopen_recommendations(events["trade_date"].unique())
    if recs is None:
        return pd.DataFrame()

    truth = events[["trade_date", "symbol", "fwd_ret"]].drop_duplicates(
        ["trade_date", "symbol"])
    rows = []
    for td, actual in truth.groupby("trade_date"):
        snap = _preopen_snapshot(recs, td)
        # No snapshot means the historical system did not yet exist (or its audit data is
        # unavailable); it does NOT mean every mover was consciously classified Hold.  The old
        # report counted 24 pre-inception dates as 100% not_flagged and materially understated
        # live-era coverage.  Exclude them from accuracy and report the unassessable count.
        if not len(snap):
            continue
        calls = dict(zip(snap["symbol"], snap["classification"]))
        # not_flagged = rated_hold + no_coverage + flat_outcome (see _mover_bucket), kept as one
        # column beside its three causes so existing consumers are unchanged.
        counts = dict.fromkeys(_MOVER_BUCKETS, 0)
        examples = {"matched": [], "opposite": [], "not_flagged": []}
        for row in actual.itertuples(index=False):
            # Both strong tiers are directional on their side: _call_side is the one polarity map.
            bucket = _mover_bucket(row.symbol, calls, float(row.fwd_ret))
            counts[bucket] += 1
            ex_key = bucket if bucket in ("matched", "opposite") else "not_flagged"
            if len(examples[ex_key]) < 5:
                examples[ex_key].append({"symbol": row.symbol, "return_pct": round(float(row.fwd_ret), 2),
                                         "call": calls.get(row.symbol)})
        matched, opposite = counts["matched"], counts["opposite"]
        not_flagged = counts["rated_hold"] + counts["no_coverage"] + counts["flat_outcome"]
        n = len(actual)
        rows.append({
            "event_date": str(td), "matched": matched, "opposite": opposite,
            "not_flagged": not_flagged, "n_movers": n,
            "rated_hold": counts["rated_hold"], "no_coverage": counts["no_coverage"],
            "flat_outcome": counts["flat_outcome"],
            "snapshot_symbols": int(len(snap)),
            "snapshot_asof": snap["generated_at"].max().isoformat(),
            "matched_pct": round(100 * matched / n, 2),
            "opposite_pct": round(100 * opposite / n, 2),
            "not_flagged_pct": round(100 * not_flagged / n, 2),
            "examples": examples,
        })
    return pd.DataFrame(rows)


def call_confusion(events: pd.DataFrame, eligible: pd.DataFrame) -> pd.DataFrame:
    """Type I and Type II for the same pre-open snapshot, one row per date.

    canonical_signal_accuracy starts from the day's movers, so it can only see misses.  This
    grades EVERY directional call in the snapshot against the realised close-to-close return
    (`fwd_ret`, the column the movers carry) of the whole point-in-time eligible universe, and
    puts each precision beside its null: the share of that universe that moved the called way.
    The same calls are also graded on open-to-close (`intraday_ret`, the `*_o2c` fields), the leg
    a pre-open call can actually trade; their denominators are the rows with a non-NULL
    `intraday_ret` (`graded_symbols_o2c`, `universe_symbols_o2c`).  A snapshot symbol outside the graded universe is not graded (snapshot_symbols -
    graded_symbols shows how many).  Dates with no snapshot are excluded, as in
    canonical_signal_accuracy.
    """
    if eligible is None or not len(eligible):
        return pd.DataFrame()
    cols = ["trade_date", "symbol", "fwd_ret"] + (["intraday_ret"] if "intraday_ret" in eligible.columns else [])
    universe = eligible[cols].dropna(subset=["fwd_ret"]).copy()
    universe["trade_date"] = universe["trade_date"].astype(str)
    universe = universe.drop_duplicates(["trade_date", "symbol"])
    recs = _load_preopen_recommendations(universe["trade_date"].unique())
    if recs is None:
        return pd.DataFrame()
    mover_frame = (events[["trade_date", "symbol"]].astype(str) if len(events)
                   else pd.DataFrame(columns=["trade_date", "symbol"]))
    movers_by_date = mover_frame.groupby("trade_date")["symbol"].unique().to_dict()

    def rate(k, n):
        return round(k / n, 4) if n else float("nan")

    rows = []
    for td, uni in universe.groupby("trade_date"):
        snap = _preopen_snapshot(recs, td)
        if not len(snap):
            continue
        calls = dict(zip(snap["symbol"], snap["classification"]))
        ret = dict(zip(uni["symbol"], uni["fwd_ret"].astype(float)))
        # A pre-open call can only be entered at the open, so the overnight gap inside fwd_ret is
        # not harvestable: grade the same calls on open-to-close beside it (AF-20261007-05/-06).
        ret_o = ({s: r for s, r in zip(uni["symbol"], uni["intraday_ret"].astype(float)) if r == r}
                 if "intraday_ret" in uni.columns else {})
        graded = [(ret[s], _call_side(c)) for s, c in calls.items() if s in ret]
        graded_o = [(ret_o[s], _call_side(c)) for s, c in calls.items() if s in ret_o]
        long_o = [r for r, side in graded_o if side == 1]
        short_o = [r for r, side in graded_o if side == -1]
        long_hits_o = sum(r > 0 for r in long_o)
        short_hits_o = sum(r < 0 for r in short_o)
        n_o = len(ret_o)
        # A realised 0 is neither a hit nor a miss: it stays in the call count (the precision
        # denominator) and in universe_symbols (the base-rate denominator), so a precision and
        # its null are ratios over the same kind of population.
        long_r = [r for r, side in graded if side == 1]
        short_r = [r for r, side in graded if side == -1]
        long_hits = sum(r > 0 for r in long_r)
        short_hits = sum(r < 0 for r in short_r)
        movers = [s for s in movers_by_date.get(td, []) if s in ret]
        b = dict.fromkeys(_MOVER_BUCKETS, 0)
        for s in movers:
            b[_mover_bucket(s, calls, ret[s])] += 1
        n_uni = len(ret)
        rows.append({
            "event_date": str(td),
            "long_calls": len(long_r), "long_hits": int(long_hits),
            "long_hits_o2c": int(long_hits_o),
            "long_precision": rate(long_hits, len(long_r)),
            "long_precision_o2c": rate(long_hits_o, len(long_o)),
            "universe_up_rate": rate(sum(r > 0 for r in ret.values()), n_uni),
            "universe_up_rate_o2c": rate(sum(r > 0 for r in ret_o.values()), n_o),
            "short_calls": len(short_r), "short_hits": int(short_hits),
            "short_hits_o2c": int(short_hits_o),
            "short_precision": rate(short_hits, len(short_r)),
            "short_precision_o2c": rate(short_hits_o, len(short_o)),
            "universe_down_rate": rate(sum(r < 0 for r in ret.values()), n_uni),
            "universe_down_rate_o2c": rate(sum(r < 0 for r in ret_o.values()), n_o),
            "movers": len(movers),
            "movers_called_right": b["matched"], "movers_called_wrong": b["opposite"],
            "movers_rated_hold": b["rated_hold"], "movers_no_row": b["no_coverage"],
            "movers_flat": b["flat_outcome"],
            "snapshot_symbols": int(len(snap)), "graded_symbols": len(graded),
            "graded_symbols_o2c": len(graded_o), "universe_symbols": n_uni,
            "universe_symbols_o2c": n_o,
            "snapshot_asof": snap["generated_at"].max().isoformat(),
        })
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
                    hits: pd.DataFrame, accuracy: pd.DataFrame,
                    confusion: pd.DataFrame | None = None) -> int:
    cur = con.cursor()
    n = 0
    # NOTE: `df or pd.DataFrame()` is ambiguous for DataFrames (ValueError on bool());
    # these are always DataFrames, so guard on len() instead.
    for _, r in (ic if ic is not None and len(ic) else pd.DataFrame()).iterrows():
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, class_name, factor, metric, value, n_obs, detail_json) "
                              "VALUES (?,?,?,?,?,?,?,?)"),
                    (run_at, "factor_ic", r.get("scope", "mover_cohort"), r["factor"],
                     r.get("metric", "spearman_ic"), r["ic"], int(r["n"]),
                     json.dumps({"outcome": r.get("outcome", "prior_close_to_close")})))
        n += 1
    for _, r in (lift if lift is not None and len(lift) else pd.DataFrame()).iterrows():
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, class_name, factor, metric, value, n_obs, detail_json) "
                              "VALUES (?,?,?,?,?,?,?,?)"),
                    (run_at, "cohort_lift", r["class"], r["factor"], "lift_q3_over_q1",
                     r["lift"], int(r["n_members"]),
                     json.dumps({"factor_timing": r["factor_timing"],
                                 "universe_n": int(r["universe_n"]),
                                 "factor_n": int(r["factor_n"])})))
        n += 1
    for _, r in (hits if hits is not None and len(hits) else pd.DataFrame()).iterrows():
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, class_name, metric, value, n_obs, detail_json) "
                              "VALUES (?,?,?,?,?,?,?)"),
                    (run_at, "engine_hit_rate", f"{r['engine']}@top{int(r['top_n'])}",
                     "hit_rate", r["hit_rate"], int(r["n_movers"]),
                     json.dumps({"asof": str(r["asof"]), "event_date": str(r["event_date"])})))
        n += 1
    for _, r in (accuracy if accuracy is not None and len(accuracy) else pd.DataFrame()).iterrows():
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, class_name, metric, value, n_obs, detail_json) "
                              "VALUES (?,?,?,?,?,?,?)"),
                    (run_at, "canonical_signal_accuracy", str(r["event_date"]),
                     "matched_pct", float(r["matched_pct"]), int(r["n_movers"]),
                     json.dumps({
                         "matched": int(r["matched"]), "opposite": int(r["opposite"]),
                         "not_flagged": int(r["not_flagged"]),
                         "opposite_pct": float(r["opposite_pct"]),
                         "not_flagged_pct": float(r["not_flagged_pct"]),
                         # The three causes behind not_flagged. Without these every consumer
                         # reads one 77% bucket and cannot tell a calibration miss (rated Hold)
                         # from a coverage miss (no snapshot row) from a flat tape.
                         "rated_hold": int(r["rated_hold"]),
                         "no_coverage": int(r["no_coverage"]),
                         "flat_outcome": int(r["flat_outcome"]),
                         "grader_version": GRADER_VERSION,
                         "examples": r["examples"],
                     })))
        n += 1
    for _, r in (confusion if confusion is not None and len(confusion) else pd.DataFrame()).iterrows():
        # Every column goes to detail_json, so a new grader column cannot silently not persist.
        # NaN (no calls on a side) is stored as null: NaN is not valid JSON.
        detail = {k: (None if isinstance(v, float) and v != v else v)
                  for k, v in r.items() if k != "event_date"}
        detail["grader_version"] = GRADER_VERSION
        value = r["long_precision"]
        cur.execute(translate("INSERT INTO mover_study_results "
                              "(run_at, study_kind, class_name, metric, value, n_obs, detail_json) "
                              "VALUES (?,?,?,?,?,?,?)"),
                    (run_at, "call_confusion", str(r["event_date"]), "long_precision",
                     None if pd.isna(value) else float(value), int(r["graded_symbols"]),
                     json.dumps(detail, default=lambda o: o.item())))
        n += 1
    con.commit()
    return n


def _df_to_markdown(df: pd.DataFrame, index: bool = False) -> str:
    if df is None or not len(df):
        return "_none_"
    try:
        return df.to_markdown(index=index)
    except (ImportError, ModuleNotFoundError):
        cols = list(df.columns)
        if index:
            cols = [str(df.index.name or "")] + [str(c) for c in cols]
            rows = [[str(idx)] + [str(v) for v in row] for idx, row in zip(df.index, df.values)]
        else:
            cols = [str(c) for c in cols]
            rows = [[str(v) for v in row] for row in df.values]
        header_row = "| " + " | ".join(cols) + " |"
        sep_row = "| " + " | ".join(["---"] * len(cols)) + " |"
        body_rows = ["| " + " | ".join(r) + " |" for r in rows]
        return "\n".join([header_row, sep_row] + body_rows)


def _md_table(df: pd.DataFrame, max_rows: int = 15) -> str:
    if df is None or not len(df):
        return "_no data_\n"
    d = df.head(max_rows).copy()
    return _df_to_markdown(d, index=False)


def write_report(run_at: str, ev: pd.DataFrame, ic: pd.DataFrame, lift: pd.DataFrame,
                  hits: pd.DataFrame, accuracy: pd.DataFrame, out_path: str,
                  confusion: pd.DataFrame | None = None) -> None:
    event_counts = (
        _df_to_markdown(ev.groupby("source").size().rename("events").to_frame(), index=True)
        if len(ev) else "_none_"
    )
    ic_summary = summarize_factor_ic(ic)
    lift_summary = summarize_cohort_lift(lift)
    hit_summary = summarize_engine_hits(hits)
    accuracy_summary = summarize_accuracy(accuracy)
    event_dates = int(ev["trade_date"].nunique()) if len(ev) else 0
    assessed_dates = int(accuracy["event_date"].nunique()) if len(accuracy) else 0
    unassessable_dates = max(0, event_dates - assessed_dates)
    confusion = confusion if confusion is not None else pd.DataFrame()
    if len(confusion):
        long_d = confusion[confusion["long_calls"] > 0]
        short_d = confusion[confusion["short_calls"] > 0]
        confusion_note = (
            f"Long precision beat its null (`universe_up_rate`) on "
            f"**{int((long_d['long_precision'] > long_d['universe_up_rate']).sum())}** of "
            f"{len(long_d)} dates with a long call; short precision beat `universe_down_rate` on "
            f"**{int((short_d['short_precision'] > short_d['universe_down_rate']).sum())}** of "
            f"{len(short_d)} dates with a short call. Open-to-close (the leg a pre-open call can "
            f"trade; the `*_o2c` columns sit beside each close-to-close figure): long beat "
            f"`universe_up_rate_o2c` on "
            f"**{int((long_d['long_precision_o2c'] > long_d['universe_up_rate_o2c']).sum())}**, "
            f"short beat `universe_down_rate_o2c` on "
            f"**{int((short_d['short_precision_o2c'] > short_d['universe_down_rate_o2c']).sum())}**. "
            f"Snapshots were unavailable for "
            f"{max(0, event_dates - len(confusion))} of {event_dates} event dates (excluded).")
    else:
        confusion_note = "_no trustworthy pre-open recommendation snapshots_"
    lines = [
        "# Mover Reverse-Engineering Study", "",
        f"Run: `{run_at}`  |  events analyzed: **{len(ev):,}** across "
        f"{ev['source'].nunique() if len(ev) else 0} classes", "",
        "## Event counts by class", "",
        event_counts, "",
        "## Factor rank-IC vs realized event-day returns (per-date, by population)", "",
        _md_table(ic_summary, max_rows=100), "",
        "## Cohort lift consistency across dates", "",
        _md_table(lift_summary, max_rows=30), "",
        "## Engine top-N hit-rate summary", "",
        (_md_table(hit_summary, max_rows=100) if len(hit_summary) else
         "_engines had no T-1 snapshots for the event window_"), "",
        "## Canonical pre-open call accuracy — aggregate", "",
        _md_table(accuracy_summary, max_rows=10), "",
        f"Historical recommendation snapshots were unavailable for **{unassessable_dates}** of "
        f"{event_dates} event dates; those dates are excluded from accuracy rather than being "
        "misreported as all Hold/not-flagged.", "",
        "## Canonical pre-open call accuracy — by date", "",
        (_md_table(accuracy.drop(columns=["examples"], errors="ignore"), max_rows=100)
         if len(accuracy) else "_no trustworthy pre-open recommendation snapshots_"), "",
        "Percentages are reported per date and include all three buckets: matched, opposite, "
        "and not flagged. Hold/missing calls are not flagged; only an actionable call in the "
        "wrong realized direction is opposite. Directional precision excludes Hold/missing but "
        "is shown beside total coverage so it cannot be presented as whole-universe accuracy.", "",
        "## Pre-open call confusion — every call vs the whole universe, by date", "",
        confusion_note, "",
        _md_table(confusion, max_rows=100), "",
        "Type I (a call that did not move its way) and Type II (a mover we missed) from the same "
        "snapshot. Each precision sits beside the share of the graded universe that moved that "
        "way on that date; a precision at or below its null is no evidence of skill. Flat "
        "returns stay in both denominators. `graded_symbols` = snapshot names with a realised "
        "return in the eligible universe.", "",
        "### How to read this",
        "- `mover_cohort` IC describes direction within already-selected movers; "
        "`eligible_universe` IC tests the complete point-in-time liquid equity comparison set.",
        "- Event-session pre-open factors are measured against open-to-close returns; their "
        "auction gap is already known at 09:10 and cannot be credited as a forecast of the gap. "
        "All other factors use prior-close-to-close returns (`mean_ic`) and are also graded "
        "against open-to-close (`mean_ic_o2c`): the gap between the two is the overnight gap, "
        "which is not harvestable here. A factor whose `mean_ic` survives only in the "
        "close-to-close column is a gap predictor, not a tradeable signal.",
        "- Cohort lift uses that same eligible universe: NSE EQ membership on the event date, "
        "known ETFs excluded, a clean current/prior bar, and exactly 20 clean pre-event "
        f"sessions with ADT of at least Rs {MIN_ADT_CR:g} crore.",
        "- Event-preopen lift for an open-defined class (for example, gap-up) is descriptive "
        "of an already-observed auction state, not evidence that the pre-open factor predicted "
        "the gap before it occurred.",
        "- IC or lift is exploratory until it repeats across enough independent dates; never "
        "change a live weight from one date or a pooled row count.",
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
                    help="comma-separated mover classes (default: curated true-mover cohorts)")
    ap.add_argument("--top-n", type=int, default=20,
                    help="engine top-N list size for the hit-rate audit")
    ap.add_argument("--report", type=str, default="docs/mover_study_report.md")
    args = ap.parse_args()
    classes = [c.strip() for c in args.classes.split(",") if c.strip()] or None

    t0 = time.time()
    run_at = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    engine = get_engine()

    # Progress goes to stderr with elapsed time: pythonRunner's timeout message carries only
    # stderr, so a killed run says which stage it was in instead of "No stderr captured".
    def stage(msg):
        print(f"[study] +{time.time() - t0:.1f}s {msg}", file=sys.stderr, flush=True)

    ev, eligible = load_events_and_universe(args.days, classes, engine)
    stage(f"events: {len(ev):,} rows across "
          f"{ev['source'].nunique() if len(ev) else 0} classes "
          f"({ev['trade_date'].nunique() if len(ev) else 0} dates); "
          f"eligible comparison rows: {len(eligible):,}")

    # T-1 factor snapshot per event date (cached: many events share a date)
    fac_frames = {}
    date_pairs = (ev[["t1_date", "trade_date"]].drop_duplicates().itertuples(index=False)
                  if len(ev) else [])
    for pair in date_pairs:
        key = (str(pair.t1_date), str(pair.trade_date))
        fac_frames[key] = load_factors_for_date(engine, key[0], event_date=key[1])
        stage(f"factors loaded for T-1 {key[0]} / event {key[1]}: "
              f"{len(fac_frames[key])} symbols")

    ic_parts, lift_parts = [], []
    for (d, event_date), fac in fac_frames.items():
        ev_d = ev[(ev["t1_date"] == d) & (ev["trade_date"] == event_date)]
        eligible_d = eligible[eligible["trade_date"] == event_date]
        eligible_symbols = eligible_d["symbol"].tolist()
        ic_d = pd.concat([
            factor_ic_table(ev_d, fac, scope="mover_cohort"),
            factor_ic_table(eligible_d, fac, scope="eligible_universe"),
        ], ignore_index=True)
        if len(ic_d):
            ic_d.insert(0, "t1_date", d)
            ic_d.insert(1, "event_date", event_date)
        ic_parts.append(ic_d)
        lift_d = cohort_lift_table(
            ev_d, fac, classes=classes, eligible_symbols=eligible_symbols,
        )
        if len(lift_d):
            lift_d.insert(0, "t1_date", d)
            lift_d.insert(1, "event_date", event_date)
        lift_parts.append(lift_d)
    ic = pd.concat([p for p in ic_parts if len(p)], ignore_index=True) if ic_parts \
        else pd.DataFrame()
    lift = pd.concat([p for p in lift_parts if len(p)], ignore_index=True) if lift_parts \
        else pd.DataFrame()
    stage("factor IC / cohort lift computed")
    hits = engine_hit_rate(ev, top_n=args.top_n)
    stage("engine hit-rate computed")
    accuracy = canonical_signal_accuracy(ev)
    stage("canonical accuracy computed")
    confusion = call_confusion(ev, eligible)
    stage("call confusion computed")

    con = connect()
    ensure_results_schema(con)
    persisted = persist_results(con, run_at, ic, lift, hits, accuracy, confusion)
    con.close()
    write_report(run_at, ev, ic, lift, hits, accuracy, args.report, confusion)

    print(f"[study] persisted {persisted} result rows; report -> {args.report} "
          f"({time.time() - t0:.1f}s)")


if __name__ == "__main__":
    main()





