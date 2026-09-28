"""Synthetic NSE market that emits byte-compatible exchange files.

Used by the test-suite and `bqa demo` to run the ENTIRE pipeline (parsers -> DB -> features ->
labels -> training -> gate -> predictions -> grading -> adaptation) with a known ground truth:

* `signal_strength > 0` plants a persistent latent alpha that drives future drift and is
  observable only through delivery % — a correct pipeline must find it and the gate must pass.
* `signal_strength = 0` is the negative control — a correct pipeline must find NOTHING and the
  gate must refuse to promote. A pipeline that "finds edge" here is leaking the future.

It also plants the data defects the legacy platform was bitten by: a split (adjusted
PREV_CLOSE on the ex-date), a delisting, a new listing, a symbol rename, a fat-finger print,
and illiquid names below the liquidity floor.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

BHAV_HEADER = ("SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, "
               "CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER")
INDEX_HEADER = ("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,"
                "Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield")


@dataclass
class SimMarket:
    dates: list[dt.date]
    bhavcopies: dict[dt.date, str]
    index_files: dict[dt.date, str]
    fii_dii: dict[dt.date, list[dict]]
    symbol_changes_csv: str
    alpha: pd.DataFrame                       # latent alpha, date x symbol (ground truth)
    events: dict = field(default_factory=dict)


def simulate(n_stocks: int = 120, n_days: int = 520, signal_strength: float = 1.0, seed: int = 7,
             start: dt.date = dt.date(2022, 1, 3), capitulations_per_day: int = 0,
             capitulation_effect: float = 0.0) -> SimMarket:
    """`capitulations_per_day` stocks a day get a capitulation bar (gap down >= 5%, open at the
    day's low, close-to-close among the worst); `capitulation_effect` is then added to their
    NEXT session's open->close return. Effect 0 with events on is the negative control."""
    rng = np.random.default_rng(seed)
    ev_rng = np.random.default_rng(seed + 1000)      # separate stream: other markets stay identical
    cap_today: set[int] = set()
    cap_log: list[tuple[dt.date, str]] = []
    dates = [d.date() for d in pd.bdate_range(start, periods=n_days)]
    syms = [f"SIM{i:03d}" for i in range(n_stocks)]
    sector = rng.integers(0, 8, n_stocks)
    idio_vol = rng.uniform(0.012, 0.028, n_stocks)
    beta = rng.uniform(0.6, 1.4, n_stocks)
    base_shares = np.exp(rng.normal(12.5, 1.0, n_stocks))
    n_illiquid = max(1, n_stocks // 12)
    base_shares[-n_illiquid:] = np.exp(rng.normal(8.0, 0.3, n_illiquid))   # below the ₹1cr ADT floor
    price = rng.uniform(40, 2500, n_stocks)

    kappa = 0.0009 * signal_strength
    a = rng.normal(0, 1, n_stocks)
    alpha_rows, rows_by_day, idx_files, flows = [], {}, {}, {}
    nifty = 10000.0
    at = lambda frac: dates[int(n_days * frac)]  # noqa: E731
    events = {"split": (syms[0], at(0.5)), "delist": (syms[1], at(0.73)),
              "listing": (syms[2], at(0.17)), "rename": (syms[4], "SIMNEW4", at(0.58)),
              "bad_print": (syms[3], at(0.38))}
    renamed = False
    for t, d in enumerate(dates):
        a = 0.97 * a + np.sqrt(1 - 0.97 ** 2) * rng.normal(0, 1, n_stocks)
        alpha_rows.append(a.copy())
        m = rng.normal(0.0004, 0.010)
        sec = rng.normal(0, 0.005, 8)
        # today's return is driven by YESTERDAY's alpha state: the signal is observable at t-1 close
        prev_a = alpha_rows[t - 1] if t else a
        r = beta * m + sec[sector] + kappa * prev_a + rng.normal(0, 1, n_stocks) * idio_vol
        r_on = r * 0.35 + rng.normal(0, 0.002, n_stocks)
        for i in cap_today:                          # yesterday's capitulations: next-session drift
            r[i] += capitulation_effect
        cap_next = set()
        if capitulations_per_day and t > 30:
            for i in ev_rng.choice(n_stocks - max(1, n_stocks // 12), capitulations_per_day, replace=False):
                i = int(i)
                if i in (0, 1, 2, 3, 4):              # keep the scripted corporate-event names clean
                    continue
                r_on[i] = -0.06 - ev_rng.uniform(0, 0.02)
                r[i] = r_on[i] + ev_rng.uniform(0.01, 0.02)
                cap_next.add(i)
        prev_close = price.copy()
        open_ = prev_close * np.exp(r_on)
        close = prev_close * np.exp(r)
        hi = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.006, n_stocks)))
        lo = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.006, n_stocks)))
        for i in cap_next:
            lo[i] = open_[i] * 0.9998                 # opened at the low and rallied
            cap_log.append((d, syms[i]))
        cap_today = cap_next
        vol = base_shares * np.exp(rng.normal(0, 0.35, n_stocks) + 3 * np.abs(r))
        deliv = np.clip(45 + 9 * a + rng.normal(0, 7, n_stocks), 3, 99)
        lines = [BHAV_HEADER]
        for i, s in enumerate(syms):
            if s == events["delist"][0] and d >= events["delist"][1]:
                continue
            if s == events["listing"][0] and d < events["listing"][1]:
                continue
            sym = s
            if s == events["rename"][0] and d >= events["rename"][2]:
                sym, renamed = events["rename"][1], True
            pc, o, h, l_, c = prev_close[i], open_[i], hi[i], lo[i], close[i]
            if s == events["split"][0] and d == events["split"][1]:
                pc, o, h, l_, c = pc / 2, o / 2, h / 2, l_ / 2, c / 2
                price[i] = c
                close[i] = c
            printed_close = c * 1000 if (s == events["bad_print"][0] and d == events["bad_print"][1]) else c
            v = vol[i]
            dq = v * deliv[i] / 100
            lines.append(
                f"{sym}, EQ, {d.strftime('%d-%b-%Y')}, {pc:.2f}, {o:.2f}, {h:.2f}, {l_:.2f}, {c:.2f}, "
                f"{printed_close:.2f}, {(o + c) / 2:.2f}, {v:.0f}, {v * c / 1e5:.2f}, {max(int(v / 50), 1)}, "
                f"{dq:.0f}, {deliv[i]:.2f}")
        rows_by_day[d] = "\n".join(lines) + "\n"
        price = close
        nifty_prev = nifty
        nifty *= np.exp(m)
        vix = 14 + 250 * abs(m) + rng.normal(0, 0.5)
        idx_files[d] = "\n".join([
            INDEX_HEADER,
            f"Nifty 500,{d.strftime('%d-%m-%Y')},{nifty_prev:.2f},{max(nifty, nifty_prev) * 1.002:.2f},"
            f"{min(nifty, nifty_prev) * 0.998:.2f},{nifty:.2f},{nifty - nifty_prev:.2f},{(nifty / nifty_prev - 1) * 100:.2f},0,0,22.1,3.4,1.2",
            f"India VIX,{d.strftime('%d-%m-%Y')},{vix:.2f},{vix:.2f},{vix:.2f},{vix:.2f},0,0,-,-,-,-,-",
        ]) + "\n"
        flows[d] = [
            {"category": "FII/FPI *", "date": d.strftime("%d-%b-%Y"), "buyValue": "12000.5", "sellValue": "11800.1",
             "netValue": f"{rng.normal(0, 800):.2f}"},
            {"category": "DII **", "date": d.strftime("%d-%b-%Y"), "buyValue": "9000.0", "sellValue": "8800.0",
             "netValue": f"{rng.normal(0, 600):.2f}"},
        ]
    old, new, eff = events["rename"]
    sc_csv = f"Sim Four Ltd,{old},{new},{eff.strftime('%d-%b-%Y')}\n" if renamed else ""
    alpha_df = pd.DataFrame(alpha_rows, index=pd.DatetimeIndex(pd.to_datetime(dates)), columns=syms)
    events["capitulations"] = cap_log
    return SimMarket(dates, rows_by_day, idx_files, flows, sc_csv, alpha_df, events)
