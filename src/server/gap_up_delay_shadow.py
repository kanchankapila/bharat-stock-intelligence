#!/usr/bin/env python3
"""Gap-up delay forward shadow arm (AF-20261126-15).

Rule under test: a Buy/Strong Buy name with a pre-open gap of +1% or more is bought at the 15:00 15m bar close instead
of at the session open. Definitions and the verdict rule are fixed by
docs/audits/2026-11-26-gap-up-delay-shadow-preregistration.md. Research only: it changes no score and no entry time.

A day is graded once and stored; later runs never recompute it.

    python gap_up_delay_shadow.py              # read-only report
    python gap_up_delay_shadow.py --persist    # freeze the protocol, append newly gradeable days to app_settings
    python gap_up_delay_shadow.py --json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from collections import Counter

import numpy as np
import pandas as pd

import forward_test_report as F

PROTOCOL = {
    "version": 1,
    "preregistration": "docs/audits/2026-11-26-gap-up-delay-shadow-preregistration.md",
    "start_date": "2026-11-27",
    "calls": "unified_recommendations_history, latest call per symbol per session; entry is the next NIFTY50 session",
    "classes": list(F.LONG_CLASSES),
    "gap_threshold_pct": 1.0,
    "preopen_window_ist": ["09:05:00", "09:14:59"],
    "min_adt_cr": 10.0,
    "adt_sessions": 20,
    "adt_min_sessions": 15,
    "max_bar_vs_close": 0.03,
    "save_clip_pct": 20.0,
    "min_up": 1,
    "min_others": 3,
    "min_symbols": 2000,
    "verdict_graded_days": 150,
    "t_bar_one_sided": 1.65,
    "pass": "first 150 graded days: mean D > 0 with t >= bar, D > 0 in both halves, mean gap-up saving > 0",
}
PROTOCOL_KEY = "gap_up_delay_shadow_protocol"
REPORT_KEY = "gap_up_delay_shadow"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


class ProtocolDrift(RuntimeError):
    pass


def _num(x) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _drop_reason(r: dict, p: dict) -> str | None:
    if _num(r["gap"]) is None:
        return "no_preopen_row"
    adt = _num(r["adt"])
    if adt is None or adt < p["min_adt_cr"]:
        return "below_adt"
    if r["surv"]:
        return "surveillance"
    if r["ca"]:
        return "corporate_action"
    open_, buy, dclose = _num(r["open"]), _num(r["close_1500"]), _num(r["dclose"])
    if open_ is None or open_ <= 0 or buy is None or buy <= 0 or dclose is None or dclose <= 0:
        return "no_price"
    if abs(buy / dclose - 1) > p["max_bar_vs_close"]:
        return "price_mismatch"
    return None


def grade_day(rows: list[dict], p: dict = PROTOCOL) -> dict:
    """One entry day. `rows` is one dict per Buy name; savings are in percent of the open."""
    drops, up, other, locked = Counter(), {}, [], 0
    for r in rows:
        reason = _drop_reason(r, p)
        if reason:
            drops[reason] += 1
            continue
        open_, buy = float(r["open"]), float(r["close_1500"])
        save = float(np.clip((open_ - buy) / open_ * 100, -p["save_clip_pct"], p["save_clip_pct"]))
        if float(r["gap"]) >= p["gap_threshold_pct"]:
            up[r["symbol"]] = save
            # a circuit-locked name is kept: dropping it would remove the cases where waiting cost the most
            locked += _num(r["high_1500"]) == _num(r["low_1500"])
        else:
            other.append(save)
    reason = "no_gap_up" if len(up) < p["min_up"] else "too_few_others" if len(other) < p["min_others"] else None
    up_save = float(np.mean(list(up.values()))) if up else None
    other_save = float(np.mean(other)) if other else None
    every = list(up.values()) + other
    return {"status": "no_d" if reason else "graded", "reason": reason,
            "D": None if reason else up_save - other_save, "up_save": up_save, "other_save": other_save,
            "all_save": float(np.mean(every)) if every else None, "n_up": len(up), "n_other": len(other),
            "locked_up": int(locked), "drops": dict(drops), "up": up}


def _t(xs: list[float]) -> float | None:
    if len(xs) < 3:
        return None
    sd = float(np.std(xs, ddof=1))
    return float(np.mean(xs)) / (sd / math.sqrt(len(xs))) if sd > 0 else None


def summarise(days: list[dict], p: dict = PROTOCOL) -> dict:
    """The verdict is one look at the first N graded days; below N the numbers are running figures only."""
    graded = sorted((x for x in days if x["status"] == "graded"), key=lambda x: x["d"])
    n_req = p["verdict_graded_days"]
    used = graded[:n_req]
    d = [x["D"] for x in used]
    up = [x["up_save"] for x in used]
    half = len(d) // 2
    halves = [float(np.mean(d[:half])), float(np.mean(d[half:]))] if half else []
    mean = float(np.mean(d)) if d else None
    t = _t(d)
    up_mean = float(np.mean(up)) if up else None
    if len(graded) < n_req:
        verdict = "LOW-DATA"
    else:
        passed = mean > 0 and t is not None and t >= p["t_bar_one_sided"] and min(halves) > 0 and up_mean > 0
        verdict = "PASS" if passed else "FAIL"
    all_save = [x["all_save"] for x in used if x.get("all_save") is not None]
    return {"verdict": verdict, "graded_days": len(graded), "graded_days_required": n_req, "mean_D": mean, "t": t,
            "halves": halves, "mean_gap_up_save": up_mean,
            "mean_always_delay_save": float(np.mean(all_save)) if all_save else None,
            "days_without_d": dict(Counter(x["reason"] for x in days if x["status"] != "graded"))}


def _at(d: dt.date, hh: int, mm: int) -> dt.datetime:
    return dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=IST)


def _complete(con, d: dt.date, p: dict) -> bool:
    for hh, mm in ((9, 15), (15, 0)):
        n = con.execute("SELECT count(DISTINCT symbol) FROM intraday_ohlcv WHERE interval = '15m' AND datetime = ?",
                        (_at(d, hh, mm),)).fetchone()[0]
        if n < p["min_symbols"]:
            return False
    return con.execute("SELECT count(*) FROM stock_ohlcv WHERE date = ?", (d,)).fetchone()[0] >= p["min_symbols"]


def _preopen(con, d: dt.date, p: dict) -> dict:
    """symbol -> gap for rows stamped inside the pre-open window on the day itself."""
    lo, hi = p["preopen_window_ist"]
    out = {}
    for symbol, gap, fetched in con.execute(
            "SELECT symbol, iep_gap_pct, fetched_at FROM preopen_stock_snapshot WHERE snapshot_date = ?", (d,)).fetchall():
        stamp = str(fetched).replace("T", " ")
        if stamp[:10] == d.isoformat() and lo <= stamp[11:19] <= hi:
            out[symbol] = gap
    return out


def _day_rows(con, symbols: list[str], sessions: list[dt.date], k: int, gaps: dict, p: dict) -> list[dict]:
    d = sessions[k]
    marks = ",".join("?" * len(symbols))
    history: dict[str, list] = {}
    today = {}
    for symbol, date, open_, close, volume in con.execute(
            f"SELECT symbol, date, open, close, volume FROM stock_ohlcv WHERE symbol IN ({marks}) "
            "AND date >= ? AND date <= ? ORDER BY symbol, date", (*symbols, d - dt.timedelta(days=45), d)).fetchall():
        if str(date)[:10] == d.isoformat():
            today[symbol] = (open_, close)
        else:
            c, v = _num(close), _num(volume)
            history.setdefault(symbol, []).append(None if c is None or v is None else c * v / 1e7)
    bars = {r[0]: (r[1], r[2], r[3]) for r in con.execute(
        f"SELECT symbol, high, low, close FROM intraday_ohlcv WHERE interval = '15m' AND datetime = ? "
        f"AND symbol IN ({marks})", (_at(d, 15, 0), *symbols)).fetchall()}
    surv = set()
    for symbol, asm, gsm in con.execute(
            f"SELECT symbol, is_asm, gsm_stage FROM nse_stocks WHERE symbol IN ({marks})", tuple(symbols)).fetchall():
        if str(asm).lower() in ("1", "true", "t") or str(gsm if gsm is not None else "") not in ("", "0"):
            surv.add(symbol)
    # within one session of the entry day: the first session on/after the action date is k-1, k or k+1
    lo, hi = sessions[max(k - 2, 0)], sessions[k + 1]
    acted = {symbol for symbol, kind in con.execute(
        "SELECT symbol, action_type FROM corporate_actions WHERE ex_date > ? AND ex_date <= ? "
        "UNION ALL SELECT symbol, action_type FROM stock_corporate_action_history "
        "WHERE record_date > ? AND record_date <= ?", (lo, hi, lo, hi)).fetchall()
        if any(w in str(kind).lower() for w in ("split", "bonus", "right"))}
    rows = []
    for s in symbols:
        prior = [x for x in history.get(s, [])[-p["adt_sessions"]:] if x is not None]
        open_, dclose = today.get(s, (None, None))
        high, low, close = bars.get(s, (None, None, None))
        rows.append({"symbol": s, "adt": float(np.mean(prior)) if len(prior) >= p["adt_min_sessions"] else None,
                     "surv": s in surv, "ca": s in acted, "gap": gaps.get(s), "open": open_, "dclose": dclose,
                     "close_1500": close, "high_1500": high, "low_1500": low})
    return rows


def grade(con, p: dict, done: set[str]) -> tuple[list[dict], list[dict]]:
    """(new day records, pending days). A day needs a later session, so the newest session is never graded."""
    stamps = F.load_sessions(con)
    sessions = [s.date() for s in stamps]
    start = dt.date.fromisoformat(p["start_date"])
    todo = [k for k in range(1, len(sessions) - 1) if sessions[k] >= start and sessions[k].isoformat() not in done]
    if not todo:
        return [], []
    since = (sessions[todo[0]] - dt.timedelta(days=14)).isoformat()
    calls = F.latest_call_per_session(F.load_calls(con, since), stamps)
    calls = calls[calls["classification"].isin(p["classes"])]
    days, pending = [], []
    for k in todo:
        d = sessions[k]
        if not _complete(con, d, p):
            pending.append({"d": d.isoformat(), "reason": "bars_incomplete"})
            continue
        symbols = sorted(calls.loc[calls["session"] == stamps[k - 1], "symbol"])
        gaps = _preopen(con, d, p)
        if not symbols or not gaps:
            rec = grade_day([], p) | {"status": "no_d", "reason": "no_preopen" if symbols else "no_buy_names"}
        else:
            rec = grade_day(_day_rows(con, symbols, sessions, k, gaps, p), p)
        days.append({"d": d.isoformat(), "call_session": sessions[k - 1].isoformat(), **rec})
    return days, pending


def run(con, persist: bool = False, protocol: dict = PROTOCOL) -> dict:
    h, same = F.ensure_protocol(con, PROTOCOL_KEY, protocol, freeze=persist)
    if not same:
        raise ProtocolDrift(f"code hash {h} differs from the frozen protocol in app_settings['{PROTOCOL_KEY}']; "
                            "a changed rule is a new arm, not a continuation")
    row = con.execute("SELECT value FROM app_settings WHERE key = ?", (REPORT_KEY,)).fetchone()
    stored = json.loads(row[0])["days"] if row else []
    new, pending = grade(con, protocol, {x["d"] for x in stored})
    days = sorted(stored + new, key=lambda x: x["d"])
    out = {"protocol_hash": h, "start_date": protocol["start_date"],
           "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
           "summary": summarise(days, protocol), "pending": pending, "days": days}
    if persist:
        con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                    'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                    (REPORT_KEY, json.dumps(out)))
    con.commit()
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--persist", action="store_true", help=f"upsert app_settings['{REPORT_KEY}']")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    from db_compat import connect
    con = connect()
    try:
        rep = run(con, a.persist)
    except ProtocolDrift as e:
        print(f"[gap-delay] PROTOCOL DRIFT: {e}", file=sys.stderr)
        return 2
    finally:
        con.close()
    if a.json:
        print(json.dumps(rep, indent=2))
        return 0
    s = rep["summary"]
    f = lambda x: "n/a" if x is None else f"{x:+.3f}"
    print(f"[gap-delay] forward from {rep['start_date']}: {s['graded_days']}/{s['graded_days_required']} graded days, "
          f"verdict {s['verdict']} | mean D {f(s['mean_D'])}% t {f(s['t'])} | gap-up saving {f(s['mean_gap_up_save'])}% "
          f"| days without D {s['days_without_d']} | pending {len(rep['pending'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
