#!/usr/bin/env python3
"""Q2-FY27 post-results drift shadow arm: grade the pre-registered arm on closed 21-session windows.

Definitions are fixed by measurement.md's 2026-10-11 pre-registration and its 2026-10-12 amendment
(AF-20261008-42); nothing here may change after the first Q2 return is observed:
- cohort: filings whose session is on/after the season start, where a broadcast after 15:30 IST (or on a
  non-session day) belongs to the next session; cohorts per ISO week of that session, a week with < 15 eligible filers merges into the next.
- value: headline PAT from nse_filing_financials (the filing's own XBRL), consolidated if filed else
  standalone, first-reported original (never a revision), vs the SAME company's first-reported filing for
  the same quarter a year earlier on the same basis. growth = (PAT_q - PAT_py) / |PAT_py|, winsorised +-300%.
- excluded and counted: half-year figures in the quarter slot (parse_error 'not_a_quarter'), a missing or
  zero year-ago base (or one flagged half-year), a probable lakh/crore slip (|PAT_q/PAT_py| outside
  0.001..1000 with a file declaring lakhs), symbols with no price bars, ADT below Rs10cr.
- arm: long the top growth quintile within the cohort, entry at the open of the session AFTER the event
  session, exit 21 sessions later at the open, 0.30% round trip per entry; benchmark = equal-weight mean of
  every eligible filer in the cohort over the same windows. Spread and rank IC are descriptive.
- a cohort is graded only when every member's exit open has happened (stock_ohlcv); otherwise it is pending.
- pooled: one-sided t of net long-only excess on cohort-weeks; LOW-DATA below 15 (Q2 alone yields ~5, so
  Q2 is LOW-DATA by construction). The verdict pools Q2-Q4 FY27 and is due 2027-06-30.

    python q2_drift_shadow_arm.py                      # read-only report
    python q2_drift_shadow_arm.py --json
    python q2_drift_shadow_arm.py --persist            # also upsert app_settings['q2_drift_shadow_arm']
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys

import numpy as np
import pandas as pd

SETTINGS_KEY = "q2_drift_shadow_arm"
SEASON_START = "2026-10-12"
HOLD = 21
COST_RT = 0.003
ADT_FLOOR = 1e8          # Rs10cr
ADT_FLOOR_2 = 5e8        # Rs50cr, descriptive
MIN_COHORT = 15
MIN_COHORT_WEEKS = 15
T_BAR = 1.65
WINSOR = 3.0
SCALE_BAND = (1e-3, 1e3)
VERDICT_DATE = "2027-06-30"
STALE_PERIOD_DAYS = 100  # a period_end older than this before the season start is a late filer of an earlier quarter
EXCLUSION_REASONS = ("stale_period", "half_year_in_quarter_slot", "missing_value", "no_year_ago",
                     "year_ago_half_year", "year_ago_zero_or_missing", "scale_error", "unmapped_symbol",
                     "no_adt", "below_adt_10cr", "no_price_in_window")
PROTOCOL = {
    "preregistration": "measurement.md 2026-10-11 + amendment 2026-10-12 (AF-20261008-42)",
    "hold_sessions": HOLD, "cost_round_trip": COST_RT, "adt_floor": ADT_FLOOR, "adt_floor_secondary": ADT_FLOOR_2,
    "min_cohort": MIN_COHORT, "winsor": WINSOR, "quintile": "top 1/5 by growth", "t_bar_one_sided": T_BAR,
    "min_cohort_weeks": MIN_COHORT_WEEKS, "verdict_date": VERDICT_DATE,
}


def event_session_idx(ts, cal: pd.DatetimeIndex) -> int:
    """Index in `cal` of the session a broadcast belongs to: same day if a session at or before 15:30 IST,
    else the next session (also for a weekend/holiday broadcast). May equal len(cal)."""
    t = pd.Timestamp(ts).tz_convert("Asia/Kolkata")
    d = pd.Timestamp(t.date())
    k = int(cal.searchsorted(d, side="left"))
    if k < len(cal) and cal[k] == d and (t.hour, t.minute) > (15, 30):
        k += 1
    return k


def _first_reported(fin: pd.DataFrame) -> pd.DataFrame:
    f = fin[fin["is_original"].astype(bool)].copy()
    f["broadcast_ts"] = pd.to_datetime(f["broadcast_ts"], utc=True)
    f["period_end"] = pd.to_datetime(f["period_end"])
    f["consolidated"] = f["consolidated"].astype(bool)
    f["pat"] = pd.to_numeric(f["pat"], errors="coerce")
    return f.sort_values("broadcast_ts")


def _err(x) -> str | None:
    return x if isinstance(x, str) and x else None


def build_filers(fin: pd.DataFrame, season_start: str, priced: set, cal: pd.DatetimeIndex) -> pd.DataFrame:
    """One row per (symbol, quarter) whose first filing's event session is on/after season_start, with its
    event-session index `ev` in `cal` and growth or an exclusion reason."""
    f = _first_reported(fin)
    cur = (f.sort_values(["symbol", "period_end", "consolidated", "broadcast_ts"], ascending=[True, True, False, True])
           .drop_duplicates(["symbol", "period_end"]))
    start = pd.Timestamp(season_start)
    cur = cur.assign(ev=[event_session_idx(t, cal) for t in cur["broadcast_ts"]])
    cur = cur[cur["ev"] >= int(cal.searchsorted(start, side="left"))]
    base = f.drop_duplicates(["symbol", "period_end", "consolidated"]).set_index(["symbol", "period_end", "consolidated"])
    out = []
    for r in cur.itertuples(index=False):
        reason, growth, py = None, None, None
        key = (r.symbol, r.period_end - pd.DateOffset(years=1), r.consolidated)
        b = base.loc[key] if key in base.index else None
        if r.period_end < start - pd.Timedelta(days=STALE_PERIOD_DAYS):
            reason = "stale_period"
        elif _err(r.parse_error) == "not_a_quarter":
            reason = "half_year_in_quarter_slot"
        elif _err(r.parse_error) or not math.isfinite(r.pat):
            reason = "missing_value"
        elif b is None:
            reason = "no_year_ago"
        elif _err(b["parse_error"]) == "not_a_quarter":
            reason = "year_ago_half_year"
        elif _err(b["parse_error"]) or not math.isfinite(b["pat"]) or b["pat"] == 0:
            reason = "year_ago_zero_or_missing"
        else:
            py = float(b["pat"])
            lakhs = any("lakh" in str(u or "").lower() for u in (r.unit_scale, b["unit_scale"]))
            if lakhs and not (SCALE_BAND[0] <= abs(r.pat / py) <= SCALE_BAND[1]):
                reason = "scale_error"
            elif r.symbol not in priced:
                reason = "unmapped_symbol"
            else:
                growth = float(np.clip((r.pat - py) / abs(py), -WINSOR, WINSOR))
        out.append({"symbol": r.symbol, "period_end": r.period_end, "consolidated": r.consolidated,
                    "broadcast_ts": r.broadcast_ts, "ev": int(r.ev), "pat": r.pat, "pat_py": py, "growth": growth,
                    "reason": reason})
    return pd.DataFrame(out, columns=["symbol", "period_end", "consolidated", "broadcast_ts", "ev", "pat", "pat_py",
                                      "growth", "reason"])


def _stats(m: pd.DataFrame) -> dict | None:
    """Arm statistics over members with growth and ret. None below one name per quintile."""
    n = len(m)
    if n < 5:
        return None
    q = np.ceil(m["growth"].rank(method="first") * 5 / n).astype(int)
    top, bot = m["ret"][q == 5], m["ret"][q == 1]
    long_gross, bench = float(top.mean()), float(m["ret"].mean())
    return {"n": n, "n_top": int(len(top)), "long_gross": long_gross, "long_net": long_gross - COST_RT,
            "bench": bench, "excess_net": long_gross - COST_RT - bench,
            "spread_gross": long_gross - float(bot.mean()), "spread_net": long_gross - float(bot.mean()) - 2 * COST_RT,
            "rank_ic": float(m["growth"].rank().corr(m["ret"].rank())), "quintile": q}


def _pooled(xs: list[float]) -> dict:
    n = len(xs)
    mean = float(np.mean(xs)) if n else None
    sd = float(np.std(xs, ddof=1)) if n >= 2 else None
    t = mean / (sd / math.sqrt(n)) if sd else None
    if n < MIN_COHORT_WEEKS:
        verdict = "LOW-DATA"
    else:
        verdict = "t >= 1.65" if t is not None and t >= T_BAR else "t < 1.65"
    return {"cohort_weeks": n, "mean_excess_net": mean, "sd": sd, "t_one_sided": t, "verdict": verdict,
            "note": f"LOW-DATA below {MIN_COHORT_WEEKS} cohort-weeks; Q2-FY27 alone cannot reach it. "
                    f"Official verdict pools Q2-Q4 FY27 on {VERDICT_DATE}; nothing is wired into the ranker."}


def evaluate(fin: pd.DataFrame, px: pd.DataFrame, sessions, season_start: str = SEASON_START) -> dict:
    real = pd.DatetimeIndex(sorted(pd.to_datetime(pd.Index(sessions)).unique()))
    n_real = len(real)
    # ponytail: future sessions are weekdays without holidays, so a pending expected_close is approximate
    cal = real.append(pd.bdate_range(real[-1] + pd.Timedelta(days=1), periods=260))
    px = px.copy()
    px["date"] = pd.to_datetime(px["date"])
    opens = px.pivot_table(index="date", columns="symbol", values="open").reindex(real)
    dv = (pd.to_numeric(px["close"], errors="coerce") * pd.to_numeric(px["volume"], errors="coerce"))
    adt = px.assign(dv=dv).pivot_table(index="date", columns="symbol", values="dv").reindex(real)
    adt = adt.rolling(20, min_periods=15).mean()
    filers = build_filers(fin, season_start, set(opens.columns[opens.notna().any()]), cal)
    adt_at = []
    for r in filers.itertuples():
        a = adt.iat[min(r.ev, n_real - 1), adt.columns.get_loc(r.symbol)] if r.symbol in adt.columns else np.nan
        adt_at.append(float(a))
    filers["adt"] = adt_at
    ok = filers["reason"].isna()
    filers.loc[ok & ~np.isfinite(filers["adt"]), "reason"] = "no_adt"
    filers.loc[filers["reason"].isna() & (filers["adt"] < ADT_FLOOR), "reason"] = "below_adt_10cr"

    elig = filers[filers["reason"].isna()].sort_values("ev").copy()
    elig["entry_i"] = elig["ev"] + 1
    elig["exit_i"] = elig["ev"] + 1 + HOLD
    elig["week"] = [f"{cal[i].isocalendar()[0]}-W{cal[i].isocalendar()[1]:02d}" for i in elig["ev"]]

    groups, acc, weeks = [], [], []
    for wk, g in elig.groupby("week", sort=True):
        acc.append(g)
        weeks.append(wk)
        if sum(len(x) for x in acc) >= MIN_COHORT:
            groups.append((weeks, pd.concat(acc)))
            acc, weeks = [], []
    tail = (weeks, pd.concat(acc)) if acc else None

    cohorts, pending, no_price = [], [], 0
    for wks, g in groups:
        label = wks[0] if len(wks) == 1 else f"{wks[0]}..{wks[-1]}"
        last_exit = int(g["exit_i"].max())
        if last_exit > n_real - 1:
            pending.append({"cohort": label, "weeks": wks, "n": int(len(g)), "status": "window_open",
                            "expected_close": str(cal[last_exit].date()),
                            "members": [{"symbol": r.symbol, "growth": r.growth, "entry": str(cal[r.entry_i].date())}
                                        for r in g.itertuples()]})
            continue
        col = [opens.columns.get_loc(s) for s in g["symbol"]]
        o = opens.to_numpy()
        g = g.assign(ret=o[g["exit_i"].to_numpy(), col] / o[g["entry_i"].to_numpy(), col] - 1)
        priced = np.isfinite(g["ret"])
        no_price += int((~priced).sum())
        g = g[priced]
        s = _stats(g)
        if s is None:
            continue
        q = s.pop("quintile")
        g2 = g[g["adt"] >= ADT_FLOOR_2]
        s2 = _stats(g2)
        if s2:
            s2.pop("quintile")
        cohorts.append({"cohort": label, "weeks": wks, **s,
                        "entry_first": str(real[int(g["entry_i"].min())].date()),
                        "exit_last": str(real[int(g["exit_i"].max())].date()),
                        "secondary_50cr": s2,
                        "members": [{"symbol": r.symbol, "growth": r.growth, "adt": r.adt, "ret": float(r.ret),
                                     "quintile": int(qq), "entry": str(real[r.entry_i].date()),
                                     "exit": str(real[r.exit_i].date())}
                                    for r, qq in zip(g.itertuples(), q)]})
    if tail:
        wks, g = tail
        pending.append({"cohort": wks[0] if len(wks) == 1 else f"{wks[0]}..{wks[-1]}", "weeks": wks,
                        "n": int(len(g)), "status": "undersized", "expected_close": None,
                        "note": f"< {MIN_COHORT} eligible filers; merges into the next week that has filers",
                        "members": [{"symbol": r.symbol, "growth": r.growth, "entry": str(cal[r.entry_i].date())}
                                    for r in g.itertuples()]})

    exclusions = {k: int((filers["reason"] == k).sum()) for k in EXCLUSION_REASONS}
    exclusions["no_price_in_window"] = no_price
    secondary = [c["secondary_50cr"]["excess_net"] for c in cohorts if c["secondary_50cr"]]
    return {
        "protocol": PROTOCOL, "season_start": season_start,
        "as_of_session": str(real[-1].date()), "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "filers": int(len(filers)), "eligible": int(len(elig)), "exclusions": exclusions,
        "cohorts": cohorts, "pending": pending,
        "pooled": _pooled([c["excess_net"] for c in cohorts]),
        "pooled_secondary_50cr": _pooled(secondary),
    }


def load(con, season_start: str):
    start = pd.Timestamp(season_start)
    fin = pd.DataFrame(con.execute(
        "SELECT symbol, period_end, consolidated, broadcast_ts, is_original, pat, parse_error, unit_scale "
        "FROM nse_filing_financials WHERE period_end >= ? AND filing_period IN ('Quarterly', 'Integrated')",
        ((start - pd.Timedelta(days=STALE_PERIOD_DAYS + 380)).date(),)).fetchall(),
        columns=["symbol", "period_end", "consolidated", "broadcast_ts", "is_original", "pat", "parse_error",
                 "unit_scale"])
    lo = (start - pd.Timedelta(days=45)).date()
    sessions = pd.to_datetime([r[0] for r in con.execute(
        "SELECT DISTINCT date FROM stock_ohlcv WHERE symbol = 'NIFTY50' AND date >= ? ORDER BY date", (lo,)).fetchall()])
    px = pd.DataFrame(con.execute(
        "SELECT symbol, date, open, close, volume FROM stock_ohlcv "
        "WHERE date >= ? AND (is_suspect IS NULL OR is_suspect = 0)", (lo,)).fetchall(),
        columns=["symbol", "date", "open", "close", "volume"])
    for c in ("open", "close", "volume"):
        px[c] = pd.to_numeric(px[c], errors="coerce")
    return fin, px, sessions


def run(con, season_start: str = SEASON_START, persist: bool = False) -> dict:
    fin, px, sessions = load(con, season_start)
    con.commit()
    if len(sessions) == 0:
        raise RuntimeError("no NIFTY50 sessions in stock_ohlcv since the season start - 45 days")
    out = evaluate(fin, px, sessions, season_start)
    if persist:
        con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                    'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                    (SETTINGS_KEY, json.dumps(out, default=str)))
        con.commit()
    return out


def _print(rep: dict) -> None:
    f = lambda x, fmt: "n/a" if x is None or x != x else format(x, fmt)
    print(f"[q2-drift] season {rep['season_start']} as of {rep['as_of_session']}: {rep['filers']} filers, "
          f"{rep['eligible']} eligible")
    print(f"[q2-drift] exclusions: {rep['exclusions']}")
    print(f"  {'cohort':>20} {'n':>4} {'top':>4} {'long_net%':>9} {'bench%':>7} {'excess%':>8} {'spread_net%':>11} "
          f"{'ic':>6}  window")
    for c in rep["cohorts"]:
        print(f"  {c['cohort']:>20} {c['n']:4d} {c['n_top']:4d} {100 * c['long_net']:+9.2f} {100 * c['bench']:+7.2f} "
              f"{100 * c['excess_net']:+8.2f} {100 * c['spread_net']:+11.2f} {c['rank_ic']:+6.3f}  "
              f"{c['entry_first']}..{c['exit_last']}")
    for p in rep["pending"]:
        print(f"  PENDING {p['cohort']:>12} n={p['n']} {p['status']} expected_close={p['expected_close']}")
    p = rep["pooled"]
    print(f"[q2-drift] pooled: cohort-weeks={p['cohort_weeks']} mean excess net={f(p['mean_excess_net'], '+.4f')} "
          f"t={f(p['t_one_sided'], '.2f')} verdict={p['verdict']}. {p['note']}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season-start", default=SEASON_START)
    ap.add_argument("--persist", action="store_true", help=f"upsert app_settings['{SETTINGS_KEY}']")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    from db_compat import connect
    con = connect()
    try:
        rep = run(con, a.season_start, a.persist)
    finally:
        con.close()
    if a.json:
        print(json.dumps(rep, indent=2, default=str))
    else:
        _print(rep)
    return 0


if __name__ == "__main__":
    sys.exit(main())
