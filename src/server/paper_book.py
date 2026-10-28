"""Frozen, forward-graded paper book on the published ranking (AF-20261026-73).

Question answered: if you had actually traded the ranking -- a small, selective, low-turnover long book, after
costs -- would it have beaten the market, and by more than LUCK with the same mechanics would have?
Why this shape: every signal measured on 2026-10-26 is real but small, and daily trading loses to Indian costs
(carry: +3 bps/day gross vs ~20 bps per round trip); the only profile with positive net excess in the record is
the top of the ranking held for weeks (forward_test_report retrospective, LOW-DATA). This tests that profile
FORWARD, because no past window we hold is long enough to prove it (a 10-name random book ranged -4%..+7% over
the same 51 sessions the best arm made +9%).

Rules (PROTOCOL, frozen in app_settings on first run; a change is reported as drift and the run exits 2):
  * calls: unified_recommendations_history, latest call per symbol published before the entry open
    (forward_test_report.latest_call_per_session -- identical timing to the forward test);
  * universe: names with >= Rs10cr trailing-20d traded value known at the decision;
  * enter: the highest-ranked names strictly inside the top 2%, until book_size slots are full, at the NEXT open;
  * exit at the next open when a name leaves the top 25%, or has been held max_hold_sessions and no longer
    qualifies for entry (a name that stays top is kept, not churned);
  * equal weight per slot, empty slots earn nothing; marks open-to-open, clipped +/-40%;
  * cost_per_side charged on every entry and exit (indian_market_costs delivery round trip ~= 0.32%);
  * excess = position return minus the equal-weight liquid universe, same interval;
  * null: n sticky-random books (one random score per symbol per seed + 5% daily noise), identical mechanics;
  * verdict: LOW-DATA below MIN_SESSIONS forward sessions; PROVEN only when cumulative excess exceeds the
    null's 95th percentile AND both halves of the window are positive; otherwise NOT PROVEN.
Read-only apart from one app_settings snapshot; never changes a score.

    python paper_book.py                       # forward block since the protocol start
    python paper_book.py --retro 2026-08-10    # also an informational retrospective block
    python paper_book.py --persist             # store the report in app_settings['paper_book_report']
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import sys

import numpy as np
import pandas as pd

from accuracy_shadow_arms import reblend_no_ml
from db_compat import connect
from forward_test_report import apply_protocol_start, latest_call_per_session, load_sessions

PROTOCOL = {
    "version": 1,
    "start_date": "2026-10-27",
    "arms": ["published", "reblend_no_ml"],
    "book_size": 10,
    "enter_top_pct": 0.02,
    "keep_top_pct": 0.25,
    "max_hold_sessions": 21,
    "min_adt": 100_000_000,
    "cost_per_side": 0.0016,
    "null_books": 200,
    "null_seed": 20261027,
    "min_sessions": 60,
}
PROTOCOL_KEY = "paper_book_protocol"
REPORT_KEY = "paper_book_report"
MIN_SESSIONS = PROTOCOL["min_sessions"]


def simulate(calls: dict, O: pd.DataFrame, ADT: pd.DataFrame, p: dict) -> pd.DataFrame:
    """calls: {session -> Series(symbol -> score)}; O/ADT indexed by session. One row per marked interval,
    labelled by the open it starts from: excess and net are book fractions (slots of 1/book_size).
    D.attrs["holdings"] is the book for the next open, including the latest (not yet markable) decision."""
    K, side = p["book_size"], p["cost_per_side"]
    enter_cut, keep_cut = 1 - p["enter_top_pct"], 1 - p["keep_top_pct"]
    sessions = O.index
    first = min((sessions.get_loc(s) for s in calls if s in sessions), default=len(sessions))
    pos: dict[str, int] = {}
    rows = []
    for i in range(first, len(sessions)):
        trades = 0
        s = sessions[i]
        if s in calls:
            sc = calls[s].dropna()
            liquid = (ADT.iloc[i].reindex(sc.index) >= p["min_adt"]).fillna(False)
            pct = sc[liquid].rank(pct=True)
            for sym in list(pos):
                r = pct.get(sym, 0.0)
                held = i + 1 - pos[sym]
                if r <= keep_cut or (held >= p["max_hold_sessions"] and r <= enter_cut):
                    del pos[sym]
                    trades += 1
            for sym in pct[pct > enter_cut].sort_values(ascending=False).index:
                if len(pos) >= K:
                    break
                # tonight's decision (no next open on file yet) is taken on faith; a past one needs a real open
                if sym not in pos and (i + 1 >= len(sessions) or np.isfinite(O.iloc[i + 1].get(sym, np.nan))):
                    pos[sym] = i + 1
                    trades += 1
        if i + 2 >= len(sessions):
            continue
        o1, o2 = O.iloc[i + 1], O.iloc[i + 2]
        liq = (ADT.iloc[i] >= p["min_adt"]).reindex(O.columns).fillna(False)
        uni = (o2[liq] / o1[liq] - 1).clip(-0.4, 0.4)
        bench = float(uni.mean()) if uni.notna().any() else 0.0
        r = [(o2[s_] / o1[s_] - 1) for s_ in pos if np.isfinite(o1.get(s_, np.nan)) and np.isfinite(o2.get(s_, np.nan))]
        r = np.clip(np.array(r, dtype=float), -0.4, 0.4)
        cost = trades * side
        rows.append((sessions[i + 1], (r.sum() - len(r) * bench - cost) / K, (r.sum() - cost) / K, len(pos), trades))
    D = pd.DataFrame(rows, columns=["date", "excess", "net", "names", "trades"]).set_index("date")
    D.attrs["holdings"] = sorted(pos)
    return D


def null_books(calls: dict, O: pd.DataFrame, ADT: pd.DataFrame, p: dict, n: int, seed: int) -> np.ndarray:
    """Cumulative excess of n sticky-random books with the same mechanics (the luck baseline)."""
    syms = sorted({s for c in calls.values() for s in c.index})
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        base = pd.Series(rng.random(len(syms)), index=syms)
        rc = {s: base.reindex(c.index) + 0.05 * pd.Series(rng.random(len(c)), index=c.index) for s, c in calls.items()}
        out.append(simulate(rc, O, ADT, p)["excess"].sum())
    return np.array(out)


def verdict(sessions: int, cum_excess: float, null_p95: float, halves: tuple[float, float]) -> dict:
    if sessions < MIN_SESSIONS:
        status = "LOW-DATA"
    elif cum_excess > null_p95 and halves[0] > 0 and halves[1] > 0:
        status = "PROVEN"
    else:
        status = "NOT PROVEN"
    return {"status": status, "sessions": sessions, "cum_excess": cum_excess, "null_p95": null_p95,
            "halves": list(halves)}


def protocol_hash(protocol: dict) -> str:
    return hashlib.sha256(json.dumps(protocol, sort_keys=True).encode()).hexdigest()[:16]


def _load(con, since: str, sessions: pd.DatetimeIndex):
    lo = (pd.Timestamp(since) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    rows = con.execute(
        "SELECT symbol, generated_at, regime, unified_score, ml_score, confluence_score, technical_score, breakout_score "
        "FROM unified_recommendations_history WHERE generated_at >= ? AND unified_score IS NOT NULL", (lo,)).fetchall()
    calls = pd.DataFrame(rows, columns=["symbol", "generated_at", "regime", "unified_score", "ml_score",
                                        "confluence_score", "technical_score", "breakout_score"])
    calls["generated_at"] = pd.to_datetime(calls["generated_at"], utc=True).dt.tz_convert("Asia/Kolkata")
    for c in ("unified_score", "ml_score", "confluence_score", "technical_score", "breakout_score"):
        calls[c] = pd.to_numeric(calls[c], errors="coerce")
    calls = apply_protocol_start(latest_call_per_session(calls, sessions), since)
    calls["published"] = calls["unified_score"]
    calls["reblend_no_ml"] = reblend_no_ml(calls)
    px = pd.DataFrame(con.execute(
        "SELECT symbol, date, open, close, volume FROM stock_ohlcv WHERE date >= ? "
        "AND (is_suspect IS NULL OR is_suspect = 0) AND open > 0 AND close > 0",
        ((pd.Timestamp(since) - pd.Timedelta(days=45)).strftime("%Y-%m-%d"),)).fetchall(),
        columns=["symbol", "date", "open", "close", "volume"])
    px["date"] = pd.to_datetime(px["date"])
    for c in ("open", "close", "volume"):
        px[c] = pd.to_numeric(px[c], errors="coerce")
    idx = sessions[sessions >= px["date"].min()]
    O = px.pivot_table(index="date", columns="symbol", values="open", aggfunc="last").reindex(idx)
    dv = (px["close"] * px["volume"]).rename("dv")
    DV = px.assign(dv=dv).pivot_table(index="date", columns="symbol", values="dv", aggfunc="last").reindex(idx)
    ADT = DV.rolling(20, min_periods=15).mean()
    return calls, O, ADT


def run_block(con, since: str, sessions: pd.DatetimeIndex, p: dict = PROTOCOL) -> dict:
    calls, O, ADT = _load(con, since, sessions)
    if calls.empty:
        return {"since": since, "sessions": 0, "arms": {}}
    out = {"since": since, "arms": {}}
    null = None
    for arm in p["arms"]:
        cd = {s: g.set_index("symbol")[arm] for s, g in calls.groupby("session")}
        D = simulate(cd, O, ADT, p)
        if null is None:
            null = null_books(cd, O, ADT, p, p["null_books"], p["null_seed"])
        h = len(D) // 2
        v = verdict(len(D), float(D["excess"].sum()), float(np.percentile(null, 95)) if len(null) else float("nan"),
                    (float(D["excess"].iloc[:h].sum()), float(D["excess"].iloc[h:].sum())))
        v.update(cum_net=float(D["net"].sum()), trades=int(D["trades"].sum()), avg_names=float(D["names"].mean()),
                 null_pctile=float((null < v["cum_excess"]).mean()) if len(null) else float("nan"),
                 holdings=D.attrs["holdings"])
        out["arms"][arm] = v
    out["sessions"] = int(len(D))
    out["null_median"] = float(np.median(null)) if null is not None and len(null) else float("nan")
    return out


def ensure_protocol(con) -> tuple[str, bool]:
    h = protocol_hash(PROTOCOL)
    row = con.execute("SELECT value FROM app_settings WHERE key = ?", (PROTOCOL_KEY,)).fetchone()
    if row is None:
        con.execute("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
                    (PROTOCOL_KEY, json.dumps({"hash": h, "protocol": PROTOCOL}, sort_keys=True)))
        con.commit()
        return h, True
    return h, json.loads(row[0])["hash"] == h


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--retro", help="also an informational retrospective block from this date")
    ap.add_argument("--persist", action="store_true")
    a = ap.parse_args()
    con = connect()
    h, same = ensure_protocol(con) if a.persist else (protocol_hash(PROTOCOL), True)
    if not same:
        print(f"[paper_book] PROTOCOL DRIFT: code hash {h} differs from the frozen protocol; start a new version.",
              file=sys.stderr)
        return 2
    sessions = load_sessions(con)
    blocks = {"forward": run_block(con, PROTOCOL["start_date"], sessions)}
    if a.retro:
        blocks["retrospective"] = run_block(con, a.retro, sessions)
    out = {"protocol_hash": h, "generated_at": datetime.datetime.now().isoformat(timespec="seconds"), "blocks": blocks}
    for name, b in blocks.items():
        label = "PAPER BOOK - FORWARD (frozen)" if name == "forward" else "RETROSPECTIVE (informational, NOT evidence)"
        print(f"\n{label} since {b['since']}  sessions={b.get('sessions', 0)}  random-book median {100 * b.get('null_median', float('nan')):+.2f}%")
        for arm, v in b.get("arms", {}).items():
            print(f"  {arm:14s} {v['status']:10s} excess {100 * v['cum_excess']:+6.2f}% vs random p95 {100 * v['null_p95']:+6.2f}% "
                  f"(beats {100 * v['null_pctile']:.0f}% of random books)  halves {100 * v['halves'][0]:+.2f}%/{100 * v['halves'][1]:+.2f}%  "
                  f"net {100 * v['cum_net']:+.2f}%  trades {v['trades']}")
            print(f"                 next-open book: {', '.join(v['holdings']) or '(empty)'}")
    if a.persist:
        con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                    'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                    (REPORT_KEY, json.dumps(out, default=str)))
        con.commit()
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
