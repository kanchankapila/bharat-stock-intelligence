"""Per-stock option analytics from the NSE F&O bhavcopy's stock-option (STO) rows.

The vendor route to implied volatility (NiftyTrader, Trendlyne, Sensibull) only has forward
history. The exchange's own daily file carries every stock option's close, OI and volume back
to the UDiFF start, so IV is computed here, per (stock, date, expiry):

  * Black-76 on the same-expiry FUTURE settle (the market's forward; no dividend or borrow
    assumption needed). Without a future, underlying * e^(rT).
  * Only options that TRADED that day (volume > 0): an untraded strike's close is stale.
  * ATM IV from the out-of-the-money side (puts below the forward, calls above), linearly
    interpolated in strike to the forward. ITM closes carry the intrinsic value and are the
    least informative about volatility.
  * Skew = IV of the traded OTM put nearest 0.95F minus the traded OTM call nearest 1.05F,
    only when each strike is within MONEYNESS_TOL of its target.
  * Put/call OI and volume summed over all strikes, traded or not (OI is a position, not a print).
"""
from __future__ import annotations

import datetime as dt
import math
from collections import defaultdict

from scipy.optimize import brentq
from scipy.stats import norm

RISK_FREE = 0.065          # discounting only: with a forward, IV barely depends on it
SKEW_PUT, SKEW_CALL, MONEYNESS_TOL = 0.95, 1.05, 0.025
IV_LO, IV_HI = 1e-3, 5.0


def black76(F: float, K: float, T: float, sigma: float, call: bool, r: float = RISK_FREE) -> float:
    df = math.exp(-r * T)
    if sigma <= 0 or T <= 0:
        return df * max((F - K) if call else (K - F), 0.0)
    v = sigma * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * v * v) / v
    d2 = d1 - v
    if call:
        return df * (F * norm.cdf(d1) - K * norm.cdf(d2))
    return df * (K * norm.cdf(-d2) - F * norm.cdf(-d1))


def implied_vol(price: float, F: float, K: float, T: float, call: bool, r: float = RISK_FREE) -> float | None:
    """None when no volatility in [IV_LO, IV_HI] reproduces the price (below intrinsic, stale print)."""
    if not (price > 0 and F > 0 and K > 0 and T > 0):
        return None
    lo, hi = black76(F, K, T, IV_LO, call, r), black76(F, K, T, IV_HI, call, r)
    if not lo < price < hi:
        return None
    return brentq(lambda s: black76(F, K, T, s, call, r) - price, IV_LO, IV_HI, xtol=1e-7)


def year_fraction(trade_date: dt.date, expiry: dt.date) -> float:
    return (expiry - trade_date).days / 365.0


def _atm_iv(F: float, puts: list[tuple[float, float]], calls: list[tuple[float, float]]) -> float | None:
    """puts/calls: (strike, iv) of traded OTM options. Interpolate the nearest pair around F."""
    below = max((p for p in puts if p[0] <= F), default=None, key=lambda x: x[0])
    above = min((c for c in calls if c[0] >= F), default=None, key=lambda x: x[0])
    if below and above:
        if above[0] == below[0]:
            return 0.5 * (below[1] + above[1])
        w = (F - below[0]) / (above[0] - below[0])
        return below[1] + w * (above[1] - below[1])
    one = below or above
    if one and abs(one[0] / F - 1) <= MONEYNESS_TOL:
        return one[1]
    return None


def _nearest(opts: list[tuple[float, float]], target: float) -> float | None:
    best = min(opts, default=None, key=lambda x: abs(x[0] - target))
    return best[1] if best and abs(best[0] / target - 1) <= MONEYNESS_TOL else None


def summarise(options: list[dict], forwards: dict[tuple[str, dt.date], float]) -> list[dict]:
    """options: {symbol, trade_date, expiry, strike, call, close, underlying, open_interest, volume}.
    forwards: (symbol, expiry) -> same-expiry future settle. One summary row per (symbol, date, expiry)."""
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for o in options:
        groups[(o["symbol"], o["trade_date"], o["expiry"])].append(o)
    out = []
    for (sym, td, xp), rows in groups.items():
        T = year_fraction(td, xp)
        if T <= 0:
            continue
        F = forwards.get((sym, xp))
        spot = next((r["underlying"] for r in rows if r.get("underlying")), None)
        if F is None and spot:
            F = spot * math.exp(RISK_FREE * T)
        if not F:
            continue
        puts, calls = [], []
        for r in rows:
            K, px = r["strike"], r["close"]
            if not (r.get("volume") or 0) > 0 or not px or not K:
                continue
            otm = (K >= F) if r["call"] else (K <= F)
            if not otm:
                continue
            iv = implied_vol(px, F, K, T, r["call"])
            if iv is not None:
                (calls if r["call"] else puts).append((K, iv))
        p95, c105 = _nearest(puts, SKEW_PUT * F), _nearest(calls, SKEW_CALL * F)
        s = lambda key, want: sum((r.get(key) or 0.0) for r in rows if r["call"] == want)  # noqa: E731
        out.append({
            "symbol": sym, "trade_date": td, "expiry": xp, "forward": F,
            "atm_iv": _atm_iv(F, puts, calls),
            "skew": (p95 - c105) if p95 is not None and c105 is not None else None,
            "call_oi": s("open_interest", True), "put_oi": s("open_interest", False),
            "call_vol": s("volume", True), "put_vol": s("volume", False),
            "n_traded": len(puts) + len(calls),
        })
    return out
