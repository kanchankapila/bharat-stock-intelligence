"""Failure attribution for published Buy calls: not just WIN/LOSS, but WHY a call missed (AF-20261119).

Each published Buy / Strong Buy (the latest call per symbol before the entry open, as in forward_test_report.py)
is graded after its window closes: entry the next session's open, exit `horizon` sessions later at the open,
25 bps per side, against the equal-weight mean of the same session's liquid ranked universe. A call HITs when its
net return beats that mean. A MISS is given ONE primary cause, checked in this order, because each cause points
at a different part of the system:

  UNFILLABLE      the entry session traded at one price above the prior close (locked limit-up)  -> tradeability
  EVENT           a corporate-action ex-date fell inside the hold                                   -> event handling
  STOP_TOO_TIGHT  the published stop was touched, yet the hold still beat the universe gross,
                  or the published target was reached later in the window                          -> stop placement
  COST            beat the universe gross, lost only to the round-trip cost                         -> cost / liquidity
  TOO_SLOW        lost in the window but a 2x-horizon hold would have beaten the universe net       -> plan validity
  SECTOR_DRAG     beat its own sector but the sector lagged the universe                            -> sector exposure
  WRONG_PICK      lagged its own sector                                                             -> stock selection

The summary also carries the inputs for two follow-up rules, as descriptions only:
  * stop placement: the drawdown (MAE) winners survived vs the published stop distance;
  * abstention: hit rate and excess by regime / liquidity band / sector, on independent windows.
Neither changes a score; a rule built on them goes through ranker_challenger_gate.py first.

Usage (from src/server):
    python call_attribution.py [--since 2026-09-01] [--horizon 5] [--json] [--persist]
--persist upserts `call_attribution` rows and one app_settings row 'call_attribution_summary'. Without it the run
only SELECTs.
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import sys

import numpy as np
import pandas as pd

import forward_test_report as F
from factor_edge import MIN_DATES_RELIABLE, _effective_dates
from plan_rule_measure import load_ex_dates

KEY = "call_attribution_summary"
BUY = ("Buy", "Strong Buy")
CAUSES = ("UNFILLABLE", "EVENT", "STOP_TOO_TIGHT", "COST", "TOO_SLOW", "SECTOR_DRAG", "WRONG_PICK")
MIN_SECTOR_NAMES = 3
ADT_BANDS = ((1e7, "1-10cr"), (1e8, "10-50cr"), (5e8, "50cr+"))


# ── pure functions ────────────────────────────────────────────────────────────

def path_stats(bars: pd.DataFrame, entry: float, stop: float | None, target: float | None) -> dict:
    """bars: the holding sessions in order (open/high/low/close). MAE/MFE as fractions of entry; whether the
    stop / target were touched and whether the target came after the stop."""
    out = {"mae": float("nan"), "mfe": float("nan"), "stop_hit": False, "target_hit": False, "target_after_stop": False}
    if bars.empty or not entry or entry <= 0:
        return out
    lo, hi = bars["low"].to_numpy(float), bars["high"].to_numpy(float)
    out["mae"] = float(np.nanmin(lo) / entry - 1)
    out["mfe"] = float(np.nanmax(hi) / entry - 1)
    stop_k = next((k for k, v in enumerate(lo) if stop and stop > 0 and v <= stop), None)
    tgt_k = next((k for k, v in enumerate(hi) if target and target > entry and v >= target), None)
    out["stop_hit"] = stop_k is not None
    out["target_hit"] = tgt_k is not None
    out["target_after_stop"] = stop_k is not None and any(
        target and target > entry and v >= target for v in hi[stop_k + 1:])
    return out


def classify_cause(c: dict, cost: float) -> str:
    """c: excess (net of cost, vs universe), gross_excess, excess_2h (net, 2x horizon), sector_rel (sector minus
    universe), idio (stock minus sector), unfillable, has_exdate, stop_hit, target_after_stop."""
    if not (c["excess"] < 0):
        return "HIT"
    if c.get("unfillable"):
        return "UNFILLABLE"
    if c.get("has_exdate"):
        return "EVENT"
    if c.get("stop_hit") and (c.get("target_after_stop") or c["gross_excess"] >= 0):
        return "STOP_TOO_TIGHT"
    if c["gross_excess"] >= 0:
        return "COST"
    if c.get("excess_2h") is not None and c["excess_2h"] == c["excess_2h"] and c["excess_2h"] > 0:
        return "TOO_SLOW"
    if c.get("idio") is not None and c["idio"] == c["idio"] and c["idio"] >= 0 and c["sector_rel"] < 0:
        return "SECTOR_DRAG"
    return "WRONG_PICK"


def adt_band(adt: float) -> str:
    band = "below-floor"
    for lo, name in ADT_BANDS:
        if adt == adt and adt >= lo:
            band = name
    return band


def _bucket_stats(df: pd.DataFrame, horizon: int) -> dict:
    per_date = df.groupby("date")["excess"].mean()
    n = len(per_date)
    eff = _effective_dates(n, horizon)
    sd = per_date.std(ddof=1) if n > 1 else float("nan")
    t = float(per_date.mean() / (sd / math.sqrt(max(eff, 1.0)))) if sd == sd and sd > 1e-12 else float("nan")
    return {"calls": int(len(df)), "dates": int(n), "eff_dates": float(eff), "hit_rate": float((df["cause"] == "HIT").mean()),
            "mean_excess_pct": float(per_date.mean() * 100) if n else float("nan"), "t_eff": t,
            "low_data": bool(eff < MIN_DATES_RELIABLE)}


def summarise(att: pd.DataFrame, horizon: int) -> dict:
    """Cause mix, abstention buckets and the stop-placement inputs. Descriptive: the abstention buckets carry
    their own effective-window count and are not a rule."""
    if att.empty:
        return {"calls": 0}
    misses = att[att["cause"] != "HIT"]
    mix = {c: int((misses["cause"] == c).sum()) for c in CAUSES}
    out = {"calls": int(len(att)), "hits": int((att["cause"] == "HIT").sum()), "misses": int(len(misses)),
           "overall": _bucket_stats(att, horizon),
           "cause_counts": mix,
           "cause_share": {c: (v / len(misses) if len(misses) else float("nan")) for c, v in mix.items()},
           "buckets": {}}
    for col in ("regime", "adt_band", "sector"):
        groups = {str(k): _bucket_stats(g, horizon) for k, g in att.groupby(col) if len(g) >= 10}
        out["buckets"][col] = dict(sorted(groups.items(), key=lambda kv: kv[1]["mean_excess_pct"]))
    winners = att[(att["cause"] == "HIT") & att["mae"].notna() & att["stop_dist"].notna()]
    if len(winners):
        # MAE is negative: "80% of winners dipped no deeper than X" is the 20th percentile of MAE.
        q = winners["mae"].quantile([0.5, 0.2, 0.1])
        out["stops"] = {"winners": int(len(winners)),
                        "winner_mae_p50_pct": float(q[0.5] * 100), "winner_mae_p80_pct": float(q[0.2] * 100),
                        "winner_mae_p90_pct": float(q[0.1] * 100),
                        "median_stop_dist_pct": float(winners["stop_dist"].median() * 100),
                        "winners_whose_mae_crossed_stop": float((winners["mae"] <= winners["stop_dist"]).mean()),
                        "note": "a stop inside the drawdown most winners survived converts winners into STOP_TOO_TIGHT"}
    return out


def attribute(panel: pd.DataFrame, bars: dict, sessions: pd.DatetimeIndex, horizon: int, cost: float,
              ex_dates: dict) -> pd.DataFrame:
    """panel: one row per (date, symbol) of the liquid ranked universe with classification, sector, regime, adt,
    stop_loss, target_1, fwd_{h}, fwd_{2h}. bars: symbol -> DataFrame(date index; open, high, low, close)."""
    h, h2 = f"fwd_{horizon}", f"fwd_{2 * horizon}"
    p = panel.copy()
    p["u"] = p.groupby("date")[h].transform("mean")
    p["u2"] = p.groupby("date")[h2].transform("mean")
    n_sec = p.groupby(["date", "sector"])[h].transform("count")
    sec_mean = p.groupby(["date", "sector"])[h].transform("mean")
    p["sector_mean"] = sec_mean.where((n_sec >= MIN_SECTOR_NAMES) & p["sector"].notna(), p["u"])
    buys = p[p["classification"].isin(BUY) & p[h].notna()]
    rows = []
    for r in buys.itertuples(index=False):
        i = sessions.get_indexer([r.date])[0]
        if i < 0 or i + 1 + horizon >= len(sessions):
            continue
        b = bars.get(r.symbol)
        hold = b.loc[(b.index >= sessions[i + 1]) & (b.index <= sessions[i + horizon])] if b is not None else pd.DataFrame()
        entry = float(hold["open"].iloc[0]) if len(hold) else float("nan")
        prev = b.loc[b.index <= sessions[i], "close"] if b is not None else pd.Series(dtype=float)
        first = hold.iloc[0] if len(hold) else None
        unfillable = bool(first is not None and len(prev) and first["open"] == first["high"] == first["low"] == first["close"]
                          and first["open"] > float(prev.iloc[-1]))
        stop = float(r.stop_loss) if r.stop_loss == r.stop_loss and r.stop_loss else None
        target = float(r.target_1) if r.target_1 == r.target_1 and r.target_1 else None
        ps = path_stats(hold, entry, stop, target)
        lo, hi = sessions[i + 1].date(), sessions[i + horizon].date()
        fwd, fwd2 = float(getattr(r, h)), getattr(r, h2)
        c = {"excess": fwd - cost - r.u, "gross_excess": fwd - r.u,
             "excess_2h": (fwd2 - cost - r.u2) if fwd2 == fwd2 else float("nan"),
             "sector_rel": r.sector_mean - r.u, "idio": fwd - r.sector_mean, "unfillable": unfillable,
             "has_exdate": any(lo <= e <= hi for e in ex_dates.get(r.symbol, ())), **ps}
        rows.append({"symbol": r.symbol, "call_session": r.date.date(), "horizon": horizon,
                     "classification": r.classification, "unified_score": float(r.unified_score),
                     "sector": r.sector, "regime": r.regime, "adt": float(r.adt), "adt_band": adt_band(float(r.adt)),
                     "entry_open": entry, "stop_dist": (stop / entry - 1) if stop and entry == entry and entry > 0 else float("nan"),
                     "fwd": fwd, **c, "cause": classify_cause(c, cost)})
    out = pd.DataFrame(rows)
    if not out.empty:
        out["date"] = pd.to_datetime(out["call_session"])
    return out


# ── database reads / writes ───────────────────────────────────────────────────

CALL_COLS = ["symbol", "generated_at", "unified_score", "classification", "regime", "sector", "stop_loss", "target_1"]


def load_calls(con, since: str) -> pd.DataFrame:
    lo = (pd.Timestamp(since) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    df = pd.DataFrame(con.execute(f"SELECT {', '.join(CALL_COLS)} FROM unified_recommendations_history "
                                  "WHERE generated_at >= ? AND unified_score IS NOT NULL", (lo,)).fetchall(),
                      columns=CALL_COLS)
    df["generated_at"] = pd.to_datetime(df["generated_at"], utc=True).dt.tz_convert("Asia/Kolkata")
    for c in ("unified_score", "stop_loss", "target_1"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def load_bars(con, symbols, start: str) -> dict:
    if not symbols:
        return {}
    syms = sorted(symbols)
    ph = ",".join("?" for _ in syms)
    rows = con.execute(f"SELECT symbol, date, open, high, low, close FROM stock_ohlcv WHERE symbol IN ({ph}) "
                       "AND date >= ? AND (is_suspect IS NULL OR is_suspect = 0) ORDER BY symbol, date",
                       (*syms, start)).fetchall()
    df = pd.DataFrame(rows, columns=["symbol", "date", "open", "high", "low", "close"])
    df["date"] = pd.to_datetime(df["date"])
    for c in ("open", "high", "low", "close"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return {s: g.set_index("date")[["open", "high", "low", "close"]] for s, g in df.groupby("symbol")}


def run(con, since: str, horizon: int) -> tuple[pd.DataFrame, dict]:
    sessions = F.load_sessions(con)
    calls = F.apply_protocol_start(F.latest_call_per_session(load_calls(con, since), sessions), since)
    if calls.empty:
        return pd.DataFrame(), {"since": since, "horizon": horizon, "calls": 0}
    panel = F.build_panel(con, calls, sessions, [horizon, 2 * horizon], F.PROTOCOL["min_adt"])
    buys = panel[panel["classification"].isin(BUY)]
    start = (pd.Timestamp(since) - pd.Timedelta(days=10)).strftime("%Y-%m-%d")
    bars = load_bars(con, set(buys["symbol"]), start)
    cost = 2 * F.PROTOCOL["cost_per_side"]
    att = attribute(panel, bars, sessions, horizon, cost, load_ex_dates(con, since))
    summary = {"since": since, "horizon": horizon, "cost_round_trip": cost,
               "generated_at": datetime.datetime.now().isoformat(timespec="seconds"), **summarise(att, horizon)}
    return att, summary


DB_COLS = ["symbol", "call_session", "horizon", "classification", "unified_score", "sector", "regime", "adt",
           "entry_open", "fwd", "excess", "gross_excess", "excess_2h", "sector_rel", "idio", "mae", "mfe",
           "stop_dist", "stop_hit", "target_hit", "target_after_stop", "unfillable", "has_exdate", "cause"]


def _sql_value(v):
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.floating, float)):
        return None if not math.isfinite(float(v)) else float(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


def persist(con, att: pd.DataFrame, summary: dict) -> None:
    if not att.empty:
        cols = ", ".join(DB_COLS)
        upd = ", ".join(f"{c} = excluded.{c}" for c in DB_COLS if c not in ("symbol", "call_session", "horizon"))
        sql = (f"INSERT INTO call_attribution ({cols}, computed_at) VALUES ({', '.join('?' for _ in DB_COLS)}, now()) "
               f"ON CONFLICT (symbol, call_session, horizon) DO UPDATE SET {upd}, computed_at = now()")
        con.executemany(sql, [tuple(_sql_value(v) for v in rec) for rec in att[DB_COLS].itertuples(index=False)])
    con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                (KEY, json.dumps(summary, default=str)))
    con.commit()


def main() -> int:
    from db_compat import connect
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", default="2026-09-01")
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--persist", action="store_true")
    a = ap.parse_args()
    con = connect()
    try:
        att, summary = run(con, a.since, a.horizon)
        if a.persist:
            persist(con, att, summary)
    finally:
        con.close()
    if a.json:
        print(json.dumps(summary, indent=2, default=str))
    else:
        o = summary.get("overall", {})
        print(f"[call_attribution] {summary.get('calls', 0)} Buy calls since {a.since}, h={a.horizon}: "
              f"hit {o.get('hit_rate', float('nan')):.1%}, mean excess {o.get('mean_excess_pct', float('nan')):+.2f}% "
              f"({o.get('eff_dates', 0):.1f} independent windows)")
        for c, s in (summary.get("cause_share") or {}).items():
            print(f"  {c:<15} {s:6.1%}" if s == s else f"  {c:<15}    n/a")
    return 0


if __name__ == "__main__":
    sys.exit(main())
