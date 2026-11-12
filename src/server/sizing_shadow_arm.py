"""Pre-registered forward shadow arm: does sizing the frozen paper book by a breakout-adjusted volatility forecast
lower its risk without lowering its risk-adjusted return? (AF-20261111-02)

Why: breakout_score predicts the SIZE of the next move, not its direction (measurement.md 2026-11-11: +0.089 beyond a
vol/liquidity baseline, t 8.5; out of sample at the 1-day horizon the forecast's rank correlation with |next move| rose
0.190 -> 0.203, t 3.9). Sizing is the one place a size forecast can pay without a direction edge.

Rules (PROTOCOL, frozen in app_settings on first --persist; a change is reported as drift and the run exits 2):
  * names: exactly the paper book's 'published' arm holdings each day (paper_book.simulate, its own frozen protocol);
  * three weightings of those names, same gross exposure (held/book_size):
      equal             1/book_size per name (reproduces the paper book's net exactly; a run aborts if it does not)
      inv_vol           w ~ 1 / vol20 ** vol_exp
      inv_vol_breakout  w ~ 1 / (vol20 ** bk_vol_exp * exp(bk_coef * breakout percentile))
    vol20 = 20-session stdev of log closes at the decision close; breakout percentile = rank of breakout_score among
    the Rs10cr names that session. Both forecasts were fitted on the same pre-start window (2026-08-10..11-04,
    |abnormal next open-to-open return|, Rs10cr), so breakout is the only difference between the last two arms;
  * cost_per_side charged on every weight change, sum |w_t - w_{t-1}| (entries, exits and daily resizing);
  * graded from start_date; verdict LOW-DATA below min_sessions; PASS only when inv_vol_breakout's daily squared
    return is lower than inv_vol's (paired one-sided t <= t_bar) AND its Sharpe is not lower; otherwise FAIL.
Read-only apart from one app_settings snapshot; never changes a score or the paper book.

    python sizing_shadow_arm.py              # print the forward block (+ an informational pre-start block)
    python sizing_shadow_arm.py --persist    # freeze the protocol and store app_settings['sizing_shadow_report']
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys

import numpy as np
import pandas as pd

import paper_book as PB
from db_compat import connect
from forward_test_report import load_sessions

PROTOCOL = {
    "version": 1,
    "start_date": "2026-11-12",
    "base": "paper_book published arm, paper_book protocol a0dcc6ca6fd1cef2",
    "vol_window": 20,
    "vol_exp": 0.494,
    "bk_vol_exp": 0.346,
    "bk_coef": 0.335,
    "min_sessions": 60,
    "t_bar": -1.65,
}
PROTOCOL_KEY = "sizing_shadow_protocol"
REPORT_KEY = "sizing_shadow_report"


def sigma_vol(vol20, p: dict = PROTOCOL):
    return vol20 ** p["vol_exp"]


def sigma_breakout(vol20, bk_pct, p: dict = PROTOCOL):
    return vol20 ** p["bk_vol_exp"] * np.exp(p["bk_coef"] * bk_pct)


def weights(held: list, sigma: pd.Series, K: int) -> pd.Series:
    """Inverse-sigma weights over the held names, scaled to the equal-weight book's gross (len(held)/K).
    A name with no usable forecast takes the median sigma of the others."""
    s = pd.to_numeric(sigma.reindex(held), errors="coerce")
    s = s.where(np.isfinite(s) & (s > 0))
    s = s.fillna(s.median() if s.notna().any() else 1.0)
    inv = 1.0 / s
    return inv / inv.sum() * len(held) / K


def arm_returns(D: pd.DataFrame, O: pd.DataFrame, sigma_by_session: dict | None, K: int, side: float) -> pd.Series:
    """Net book return per row of paper_book.simulate's output. Row labelled O.index[j] earns O[j] -> O[j+1] on
    D.attrs['positions'] decided at O.index[j-1]; sigma_by_session is keyed by that decision session (None = equal)."""
    sessions = O.index
    prev = pd.Series(dtype=float)
    out = []
    for label, held in zip(D.index, D.attrs["positions"]):
        j = sessions.get_loc(label)
        if sigma_by_session is None or not held:
            w = pd.Series(1.0 / K, index=held, dtype=float)
        else:
            w = weights(held, sigma_by_session.get(sessions[j - 1], pd.Series(dtype=float)), K)
        r = (O.iloc[j + 1].reindex(held) / O.iloc[j].reindex(held) - 1).clip(-0.4, 0.4)
        gross = float((w * r).where(np.isfinite(r), 0.0).sum())
        out.append(gross - side * float(w.subtract(prev, fill_value=0.0).abs().sum()))
        prev = w
    return pd.Series(out, index=D.index, dtype=float)


def _sharpe(s: pd.Series) -> float:
    sd = s.std(ddof=1)
    return float(s.mean() / sd * np.sqrt(252)) if len(s) > 1 and sd > 0 else float("nan")


def verdict(base: pd.Series, treat: pd.Series, min_sessions: int, t_bar: float = PROTOCOL["t_bar"]) -> dict:
    base, treat = pd.Series(base).reset_index(drop=True), pd.Series(treat).reset_index(drop=True)
    n = int(min(len(base), len(treat)))
    d = (treat.iloc[:n] ** 2 - base.iloc[:n] ** 2)
    sd = d.std(ddof=1) if n > 1 else float("nan")
    t = float(d.mean() / (sd / np.sqrt(n))) if n > 1 and sd > 0 else float("nan")
    sb, st = _sharpe(base.iloc[:n]), _sharpe(treat.iloc[:n])
    if n < min_sessions:
        status = "LOW-DATA"
    elif t <= t_bar and st >= sb - 1e-9:   # NaN fails both comparisons, so an undefined t can never PASS
        status = "PASS"
    else:
        status = "FAIL"
    return {"status": status, "sessions": n, "var_diff_t": t, "sharpe_inv_vol": sb, "sharpe_inv_vol_breakout": st}


def _summary(s: pd.Series) -> dict:
    eq = (1 + s).cumprod()
    return {"cum_net": float(eq.iloc[-1] - 1) if len(s) else 0.0, "ann_vol": float(s.std(ddof=1) * np.sqrt(252)) if len(s) > 1 else float("nan"),
            "sharpe": _sharpe(s), "max_dd": float((eq / eq.cummax() - 1).min()) if len(s) else 0.0}


def _sigmas(calls: pd.DataFrame, C: pd.DataFrame, ADT: pd.DataFrame, p: dict, min_adt: float):
    vol = np.log(C).diff().rolling(p["vol_window"], min_periods=15).std()
    sv, sb = {}, {}
    for s, g in calls.groupby("session"):
        if s not in vol.index:
            continue
        g = g.set_index("symbol")
        liquid = (ADT.loc[s].reindex(g.index) >= min_adt).fillna(False)
        bk = g.loc[liquid.values, "breakout_score"].rank(pct=True).reindex(g.index)
        v = vol.loc[s].reindex(g.index)
        sv[s], sb[s] = sigma_vol(v, p), sigma_breakout(v, bk, p)
    return sv, sb


def _closes(con, since: str, idx: pd.DatetimeIndex) -> pd.DataFrame:
    px = pd.DataFrame(con.execute(
        "SELECT symbol, date, close FROM stock_ohlcv WHERE date >= ? AND (is_suspect IS NULL OR is_suspect = 0) AND close > 0",
        ((pd.Timestamp(since) - pd.Timedelta(days=45)).strftime("%Y-%m-%d"),)).fetchall(), columns=["symbol", "date", "close"])
    px["date"] = pd.to_datetime(px["date"])
    px["close"] = pd.to_numeric(px["close"], errors="coerce")
    return px.pivot_table(index="date", columns="symbol", values="close", aggfunc="last").reindex(idx)


def run(con, sessions: pd.DatetimeIndex, p: dict = PROTOCOL) -> dict:
    pb = PB.PROTOCOL
    calls, O, ADT = PB._load(con, pb["start_date"], sessions)   # replay the paper book from ITS start: path-dependent
    if calls.empty:
        return {"forward": {"sessions": 0}, "pre_start": {"sessions": 0}}
    D = PB.simulate({s: g.set_index("symbol")["published"] for s, g in calls.groupby("session")}, O, ADT, pb)
    sv, sb = _sigmas(calls, _closes(con, pb["start_date"], O.index), ADT, p, pb["min_adt"])
    K, side = pb["book_size"], pb["cost_per_side"]
    arms = {"equal": arm_returns(D, O, None, K, side), "inv_vol": arm_returns(D, O, sv, K, side),
            "inv_vol_breakout": arm_returns(D, O, sb, K, side)}
    if not np.allclose(arms["equal"].values, D["net"].values):
        raise RuntimeError("equal-weight arm no longer reproduces the paper book's net; accounting has drifted")
    out = {}
    for name, mask in (("forward", D.index >= pd.Timestamp(p["start_date"])), ("pre_start", D.index < pd.Timestamp(p["start_date"]))):
        a = {k: v[mask] for k, v in arms.items()}
        out[name] = {"sessions": int(mask.sum()), "arms": {k: _summary(v) for k, v in a.items()},
                     "verdict": verdict(a["inv_vol"], a["inv_vol_breakout"], p["min_sessions"], p["t_bar"])}
    return out


def ensure_protocol(con) -> tuple[str, bool]:
    h = PB.protocol_hash(PROTOCOL)
    row = con.execute("SELECT value FROM app_settings WHERE key = ?", (PROTOCOL_KEY,)).fetchone()
    if row is None:
        con.execute("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
                    (PROTOCOL_KEY, json.dumps({"hash": h, "protocol": PROTOCOL}, sort_keys=True)))
        con.commit()
        return h, True
    return h, json.loads(row[0])["hash"] == h


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--persist", action="store_true")
    a = ap.parse_args()
    con = connect()
    h, same = ensure_protocol(con) if a.persist else (PB.protocol_hash(PROTOCOL), True)
    if not same:
        print(f"[sizing_shadow] PROTOCOL DRIFT: code hash {h} differs from the frozen protocol; start a new version.",
              file=sys.stderr)
        return 2
    blocks = run(con, load_sessions(con))
    for name, b in blocks.items():
        label = f"SIZING SHADOW - FORWARD from {PROTOCOL['start_date']} (frozen)" if name == "forward" else \
            "PRE-START (informational, NOT evidence: overlaps the forecast's fit window)"
        print(f"\n{label}  sessions={b['sessions']}")
        for arm, s in b.get("arms", {}).items():
            print(f"  {arm:17s} net {100 * s['cum_net']:+6.2f}%  ann vol {100 * s['ann_vol']:5.1f}%  "
                  f"Sharpe {s['sharpe']:+.2f}  max DD {100 * s['max_dd']:+.2f}%")
        if "verdict" in b:
            v = b["verdict"]
            print(f"  verdict {v['status']}: variance-difference t {v['var_diff_t']:+.2f} (bar {PROTOCOL['t_bar']}), "
                  f"Sharpe inv_vol {v['sharpe_inv_vol']:+.2f} vs inv_vol_breakout {v['sharpe_inv_vol_breakout']:+.2f}")
    if a.persist:
        out = {"protocol_hash": h, "generated_at": datetime.datetime.now().isoformat(timespec="seconds"), "blocks": blocks}
        con.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                    'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                    (REPORT_KEY, json.dumps(out, default=str)))
        con.commit()
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
