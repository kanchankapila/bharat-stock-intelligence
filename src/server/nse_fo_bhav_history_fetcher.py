#!/usr/bin/env python3
"""
NSE F&O bhavcopy history -> per-(symbol, trade_date) option features.

WHY: the repo's option tables (`so_option_chain`, `stock_option_features`, `stock_options_oi`)
start 2026-05/06, so IV level, IV-RV spread and put/call skew cannot be graded across a regime.
The exchange's own daily F&O file carries every contract's close, settle, OI and traded
contracts back to 2021 (old format, `fo<DD><MON><YYYY>bhav.csv.zip`, up to the UDiFF switch in
July 2024) and the UDiFF `BhavCopy_NSE_FO_*` file after it. Raw rows (~68k/day, 60M+ in all)
are NOT stored: each zip is parsed in memory, reduced to one row per (symbol, date, near
expiry) and discarded.

Definitions are the ones already used in this repo (bharat_alpha/options.py, which derives the
same features from UDiFF for the separate bharat_alpha DB; it is not importable from here):
  * forward F   = same-expiry future SETTLE_PR (fallback close); without a same-expiry future
                  (index weeklies) put-call parity on the traded pair with the smallest |C-P|:
                  F = K + e^{rT}(C-P). `forward_source` records which.
  * spot_proxy  = F * e^{-rT} (no dividend adjustment; dividends inside ~1 month are small).
  * IV          = Black-76 on F (== Black-Scholes on spot_proxy), r = RISK_FREE = 0.065 (same
                  constant as stock_option_chain_fetcher._implied_vol and bharat_alpha), T =
                  CALENDAR days to expiry / 365 (the convention of both existing writers, so
                  atm_iv here is on the same scale as stock_options_oi.atm_iv: a fraction, 0.23 = 23%).
  * only contracts that TRADED (CONTRACTS / TtlTradgVol > 0) are priced: an untraded option's
    CLOSE is the previous close (seen live: RELIANCE 1820 CE close 799.25 above the 1800 CE's 523).
  * atm_iv      = OTM-side IVs (puts <= F, calls >= F) linearly interpolated in strike to F.
  * skew_95_105 = IV(traded OTM put nearest 0.95F) - IV(traded OTM call nearest 1.05F), each
                  within 2.5% moneyness of its target. Positive = downside put bid.
  * straddle_pct = (ATM call close + ATM put close) / spot_proxy * 100, ATM = strike nearest F
                  with both legs; NULL unless BOTH legs traded. Same unit as
                  stock_option_features.expected_move_pct (percent).
  * call_oi/put_oi/total_oi/oi_change in SHARES (old-format OPEN_INT is shares: every RELIANCE
    OI on 2022-01-03 is a multiple of its 250 lot), summed over every strike of the near expiry.
    pcr_oi = put_oi/call_oi, pcr_vol = put contracts / call contracts (unit-free).
  * near expiry = the nearest option expiry strictly AFTER trade_date (on an expiry day the
    expiring series has T=0, so it rolls to the next one; `is_expiry_day` flags the day).
    Expiry dates come from the file, never from a weekday rule (Thursday before 2025-09,
    Tuesday after).
Symbols are the file's own: no rename/lot mapping by convention. Stock options (OPTSTK) for all
names plus index options (OPTIDX) for NIFTY and BANKNIFTY only. NULL whenever a value is not
computable, never 0. Realised volatility is NOT stored here; the research harness joins it.

Run (from src/server):
  python nse_fo_bhav_history_fetcher.py --since 2021-01-01 --until 2024-07-05 --max-requests 1200
  python nse_fo_bhav_history_fetcher.py --date 2022-01-03          # one day
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import math
import sys
import time
import zipfile
from collections import defaultdict

import requests
from scipy.optimize import brentq
from scipy.stats import norm

from db_compat import connect
from nse_bhavcopy_fetcher import HEADERS

OLD_URL = ("https://nsearchives.nseindia.com/content/historical/DERIVATIVES/"
           "{yyyy}/{mon}/fo{dd}{mon}{yyyy}bhav.csv.zip")
UDIFF_URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{yyyymmdd}_F_0000.csv.zip"
# Last session served in the old format; UDiFF from the next session (NSE switched 2024-07-08).
OLD_FORMAT_LAST = dt.date(2024, 7, 5)

TABLE = "stock_option_features_history"
INDEX_SYMBOLS = {"NIFTY", "BANKNIFTY"}
RISK_FREE = 0.065
SKEW_PUT, SKEW_CALL, MONEYNESS_TOL = 0.95, 1.05, 0.025
IV_LO, IV_HI = 1e-3, 5.0
# ponytail: fixed liquidity floor; tune once the backfill shows the n_traded distribution.
MIN_TRADED_OTM = 4
REQUEST_GAP_S = 1.0
MAX_CONSECUTIVE_BLOCKS = 3


def _log(m):
    print(f"[FoBhavHist] {m}", flush=True)


# ── Black-76 ────────────────────────────────────────────────────────────────

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
    """None when no sigma in [IV_LO, IV_HI] reproduces the price (below intrinsic, stale print)."""
    if not (price and price > 0 and F > 0 and K > 0 and T > 0):
        return None
    lo, hi = black76(F, K, T, IV_LO, call, r), black76(F, K, T, IV_HI, call, r)
    if not lo < price < hi:
        return None
    return brentq(lambda s: black76(F, K, T, s, call, r) - price, IV_LO, IV_HI, xtol=1e-7)


# ── parsing (both formats -> one record shape) ──────────────────────────────

def _f(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _old_date(s: str) -> dt.date:
    return dt.datetime.strptime(s.strip().title(), "%d-%b-%Y").date()


_OLD_KIND = {"OPTSTK": ("OPT", "STK"), "OPTIDX": ("OPT", "IDX"), "FUTSTK": ("FUT", "STK"), "FUTIDX": ("FUT", "IDX")}
_UDIFF_KIND = {"STO": ("OPT", "STK"), "IDO": ("OPT", "IDX"), "STF": ("FUT", "STK"), "IDF": ("FUT", "IDX")}


def _record(kind, symbol, td, xp, strike, opt, close, settle, vol, oi, chg):
    return {"type": kind[0], "cls": kind[1], "symbol": symbol.strip().upper(), "trade_date": td,
            "expiry": xp, "strike": strike, "call": opt == "CE", "close": close, "settle": settle,
            "vol": vol, "traded": (vol or 0) > 0, "oi": oi, "chg_oi": chg}


def parse_old(text: str) -> list[dict]:
    """Old-format fo<DD><MON><YYYY>bhav.csv. Rows keyed off the file's own TIMESTAMP."""
    out = []
    for raw in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        r = {(k or "").strip(): (v or "").strip() for k, v in raw.items() if k}
        kind = _OLD_KIND.get(r.get("INSTRUMENT"))
        if not kind:
            continue
        try:
            td, xp = _old_date(r["TIMESTAMP"]), _old_date(r["EXPIRY_DT"])
        except (KeyError, ValueError):
            continue
        out.append(_record(kind, r.get("SYMBOL", ""), td, xp, _f(r.get("STRIKE_PR")), r.get("OPTION_TYP"),
                           _f(r.get("CLOSE")), _f(r.get("SETTLE_PR")), _f(r.get("CONTRACTS")),
                           _f(r.get("OPEN_INT")), _f(r.get("CHG_IN_OI"))))
    return out


def parse_udiff(text: str) -> list[dict]:
    """UDiFF BhavCopy_NSE_FO_*.csv (same column names bharat_alpha/ingest/sources/nse_fo.py reads)."""
    out = []
    for raw in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        r = {k.strip(): (v or "").strip() for k, v in raw.items() if k}
        kind = _UDIFF_KIND.get(r.get("FinInstrmTp"))
        if not kind:
            continue
        try:
            td, xp = dt.date.fromisoformat(r["TradDt"]), dt.date.fromisoformat(r["XpryDt"])
        except (KeyError, ValueError):
            continue
        out.append(_record(kind, r.get("TckrSymb", ""), td, xp, _f(r.get("StrkPric")), r.get("OptnTp"),
                           _f(r.get("ClsPric")), _f(r.get("SttlmPric")), _f(r.get("TtlTradgVol")),
                           _f(r.get("OpnIntrst")), _f(r.get("ChngInOpnIntrst"))))
    return out


# ── features ────────────────────────────────────────────────────────────────

def _atm_iv(F, puts, calls):
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


def _nearest_iv(opts, target):
    best = min(opts, default=None, key=lambda x: abs(x[0] - target))
    return best[1] if best and abs(best[0] / target - 1) <= MONEYNESS_TOL else None


def _parity_forward(legs: dict, T: float):
    """F = K + e^{rT}(C - P) at the strike whose traded C and P are closest."""
    pairs = [(abs(c["close"] - p["close"]), K, c["close"], p["close"])
             for K, (c, p) in legs.items() if c and p and c["traded"] and p["traded"] and c["close"] and p["close"]]
    if not pairs:
        return None
    _, K, C, P = min(pairs)
    F = K + math.exp(RISK_FREE * T) * (C - P)
    return F if F > 0 else None


def _ratio(num, den):
    return num / den if den else None


def compute_features(records: list[dict], trade_date: dt.date) -> list[dict]:
    """One feature row per underlying for its nearest expiry after trade_date."""
    futs, opts = {}, defaultdict(list)
    for r in records:
        if r["trade_date"] != trade_date:
            continue
        if r["cls"] == "IDX" and r["symbol"] not in INDEX_SYMBOLS:
            continue
        if r["type"] == "FUT":
            px = r["settle"] or r["close"]
            if px:
                futs[(r["symbol"], r["expiry"])] = px
        elif r["strike"]:
            opts[r["symbol"]].append(r)

    out = []
    for sym, rows in opts.items():
        expiries = {r["expiry"] for r in rows}
        later = [x for x in expiries if x > trade_date]
        if not later:
            continue
        xp = min(later)
        near = [r for r in rows if r["expiry"] == xp]
        T = (xp - trade_date).days / 365.0
        legs: dict = defaultdict(lambda: [None, None])
        for r in near:
            legs[r["strike"]][0 if r["call"] else 1] = r

        F, src = futs.get((sym, xp)), "future"
        if not F:
            F, src = _parity_forward(legs, T), "parity"
        if not F:
            src = None

        puts, calls = [], []
        if F:
            for r in near:
                if not r["traded"] or ((r["strike"] < F) if r["call"] else (r["strike"] > F)):
                    continue
                iv = implied_vol(r["close"], F, r["strike"], T, r["call"])
                if iv is not None:
                    (calls if r["call"] else puts).append((r["strike"], iv))

        spot = F * math.exp(-RISK_FREE * T) if F else None
        atm_k = straddle = None
        both = [K for K, (c, p) in legs.items() if c and p]
        if F and both:
            atm_k = min(both, key=lambda K: abs(K - F))
            # straddle from the nearest strike where BOTH legs traded, within MONEYNESS_TOL of F
            live = [K for K in both if legs[K][0]["traded"] and legs[K][1]["traded"]
                    and legs[K][0]["close"] and legs[K][1]["close"] and abs(K / F - 1) <= MONEYNESS_TOL]
            if live:
                atm_k = min(live, key=lambda K: abs(K - F))
                straddle = legs[atm_k][0]["close"] + legs[atm_k][1]["close"]
        atm_iv = _atm_iv(F, puts, calls) if F else None
        p95 = _nearest_iv(puts, SKEW_PUT * F) if F else None
        c105 = _nearest_iv(calls, SKEW_CALL * F) if F else None

        def tot(key, want_call):
            vals = [r[key] for r in near if r["call"] == want_call and r[key] is not None]
            return sum(vals) if vals else None

        call_oi, put_oi = tot("oi", True), tot("oi", False)
        call_chg, put_chg = tot("chg_oi", True), tot("chg_oi", False)
        call_vol, put_vol = tot("vol", True), tot("vol", False)
        n_otm = len(puts) + len(calls)
        out.append({
            "symbol": sym, "trade_date": trade_date, "expiry": xp,
            "instrument": "OPTIDX" if near[0]["cls"] == "IDX" else "OPTSTK",
            "days_to_expiry": (xp - trade_date).days,
            "forward": F, "forward_source": src, "spot_proxy": spot,
            "atm_strike": atm_k, "atm_iv": atm_iv,
            "atm_straddle": straddle, "straddle_pct": straddle / spot * 100 if straddle and spot else None,
            "iv_put_95": p95, "iv_call_105": c105,
            "skew_95_105": (p95 - c105) if p95 is not None and c105 is not None else None,
            "call_oi": call_oi, "put_oi": put_oi,
            "total_oi": (call_oi or 0) + (put_oi or 0) if call_oi is not None or put_oi is not None else None,
            "oi_change": (call_chg or 0) + (put_chg or 0) if call_chg is not None or put_chg is not None else None,
            "pcr_oi": _ratio(put_oi, call_oi),
            "pcr_vol": _ratio(put_vol, call_vol),
            "n_traded_otm": n_otm,
            "atm_legs_traded": straddle is not None,
            "is_expiry_day": trade_date in expiries,
            "illiquid": n_otm < MIN_TRADED_OTM or atm_iv is None,
        })
    return out


# ── HTTP ────────────────────────────────────────────────────────────────────

def day_url(d: dt.date) -> str:
    if d <= OLD_FORMAT_LAST:
        mon = d.strftime("%b").upper()
        return OLD_URL.format(yyyy=d.year, mon=mon, dd=f"{d.day:02d}")
    return UDIFF_URL.format(yyyymmdd=d.strftime("%Y%m%d"))


class Blocked(Exception):
    """Too many consecutive 403/429 -- stop the crawl, do not push through a block."""


class Fetcher:
    """Polite sequential GETs: >= REQUEST_GAP_S between requests, backoff on 403/429/5xx, abort
    after MAX_CONSECUTIVE_BLOCKS consecutive 403/429. Counts every GET against max_requests."""

    def __init__(self, session=None, max_requests: int | None = None, gap: float = REQUEST_GAP_S, sleep=time.sleep):
        self.session = session or requests.Session()
        self.max_requests, self.gap, self.sleep = max_requests, gap, sleep
        self.requests = 0
        self.blocks = 0
        self._last = 0.0

    def budget_left(self) -> bool:
        return self.max_requests is None or self.requests < self.max_requests

    def _get(self, url):
        wait = self.gap - (time.monotonic() - self._last)
        if wait > 0:
            self.sleep(wait)
        self.requests += 1
        self._last = time.monotonic()
        return self.session.get(url, headers=HEADERS, timeout=60)

    def fetch_day(self, d: dt.date) -> list[dict] | None:
        """Parsed records, or None for 404 (no session / not published). Raises Blocked."""
        url = day_url(d)
        for attempt in range(3):
            if not self.budget_left():
                raise Blocked(f"max-requests {self.max_requests} reached")
            resp = self._get(url)
            if resp.status_code == 404:
                self.blocks = 0
                return None
            if resp.status_code in (403, 429):
                self.blocks += 1
                if self.blocks >= MAX_CONSECUTIVE_BLOCKS:
                    raise Blocked(f"{self.blocks} consecutive {resp.status_code} at {url}")
                self.sleep(5 * 2 ** attempt)
                continue
            if resp.status_code >= 500:
                self.sleep(5 * 2 ** attempt)
                continue
            resp.raise_for_status()
            self.blocks = 0
            with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
                text = z.read(z.namelist()[0]).decode("utf-8", "replace")
            return parse_old(text) if d <= OLD_FORMAT_LAST else parse_udiff(text)
        raise RuntimeError(f"{url}: still failing after 3 attempts (last {resp.status_code})")


# ── DB ──────────────────────────────────────────────────────────────────────

DDL = f"""
CREATE TABLE IF NOT EXISTS {TABLE} (
    symbol           TEXT NOT NULL,
    trade_date       DATE NOT NULL,
    expiry           DATE NOT NULL,
    instrument       TEXT NOT NULL,
    days_to_expiry   INTEGER,
    forward          DOUBLE PRECISION,
    forward_source   TEXT,
    spot_proxy       DOUBLE PRECISION,
    atm_strike       DOUBLE PRECISION,
    atm_iv           DOUBLE PRECISION,
    atm_straddle     DOUBLE PRECISION,
    straddle_pct     DOUBLE PRECISION,
    iv_put_95        DOUBLE PRECISION,
    iv_call_105      DOUBLE PRECISION,
    skew_95_105      DOUBLE PRECISION,
    call_oi          DOUBLE PRECISION,
    put_oi           DOUBLE PRECISION,
    total_oi         DOUBLE PRECISION,
    oi_change        DOUBLE PRECISION,
    pcr_oi           DOUBLE PRECISION,
    pcr_vol          DOUBLE PRECISION,
    n_traded_otm     INTEGER,
    atm_legs_traded  BOOLEAN,
    is_expiry_day    BOOLEAN,
    illiquid         BOOLEAN,
    source           TEXT NOT NULL,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, trade_date, expiry)
)"""

COLS = ["symbol", "trade_date", "expiry", "instrument", "days_to_expiry", "forward", "forward_source",
        "spot_proxy", "atm_strike", "atm_iv", "atm_straddle", "straddle_pct", "iv_put_95", "iv_call_105",
        "skew_95_105", "call_oi", "put_oi", "total_oi", "oi_change", "pcr_oi", "pcr_vol", "n_traded_otm",
        "atm_legs_traded", "is_expiry_day", "illiquid", "source"]


def ensure_schema(conn) -> None:
    conn.execute(DDL)
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_sofh_trade_date ON {TABLE} (trade_date)")
    conn.commit()


def _db_value(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def store_day(conn, rows: list[dict], source: str) -> int:
    """Upsert one day's rows in ONE transaction (all or nothing)."""
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    upd = ", ".join(f"{c}=excluded.{c}" for c in COLS[3:]) + ", fetched_at=now()"
    sql = (f"INSERT INTO {TABLE} ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (symbol, trade_date, expiry) DO UPDATE SET {upd}")
    try:
        for r in rows:
            r = {**r, "source": source, "trade_date": r["trade_date"].isoformat(), "expiry": r["expiry"].isoformat()}
            conn.execute(sql, tuple(_db_value(r[c]) for c in COLS))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return len(rows)


def present_dates(conn, since: dt.date, until: dt.date) -> set[dt.date]:
    rows = conn.execute(f"SELECT DISTINCT trade_date FROM {TABLE} WHERE trade_date BETWEEN ? AND ?",
                        (since.isoformat(), until.isoformat())).fetchall()
    return {dt.date.fromisoformat(str(r[0])[:10]) for r in rows}


def sessions(conn, since: dt.date, until: dt.date) -> list[dt.date]:
    """Trading sessions from the exchange's own equity bhavcopy record (nse_universe_history,
    2021-01-01+; the same source as_of.trading_days_back trusts). F&O trades on the same
    sessions. Falls back to weekdays (holidays then 404 and are counted) if it is empty."""
    try:
        rows = conn.execute("SELECT DISTINCT date FROM nse_universe_history WHERE date BETWEEN ? AND ? ORDER BY 1",
                            (since.isoformat(), until.isoformat())).fetchall()
        days = [dt.date.fromisoformat(str(r[0])[:10]) for r in rows]
    except Exception as e:
        _log(f"nse_universe_history unreadable ({type(e).__name__}: {e}); using weekdays")
        conn.rollback()
        days = []
    if days:
        return days
    n = (until - since).days + 1
    return [d for d in (since + dt.timedelta(i) for i in range(n)) if d.weekday() < 5]


def run_range(conn, since: dt.date, until: dt.date, fetcher: Fetcher) -> dict:
    ensure_schema(conn)
    have = present_dates(conn, since, until)
    todo = sessions(conn, since, until)
    s = {"sessions": len(todo), "fetched": 0, "skipped": 0, "holidays": 0, "failed": 0, "rows": 0, "aborted": None}
    for d in todo:
        if d in have:
            s["skipped"] += 1
            continue
        try:
            recs = fetcher.fetch_day(d)
        except Blocked as e:
            s["aborted"] = str(e)
            _log(f"{d}: STOP -- {e}")
            break
        except Exception as e:
            s["failed"] += 1
            _log(f"{d}: FAILED {type(e).__name__}: {e}")
            continue
        if recs is None:
            s["holidays"] += 1
            _log(f"{d}: 404 (no session / not published)")
            continue
        feats = compute_features(recs, d)
        if not feats:
            file_dates = sorted({r["trade_date"] for r in recs})
            s["failed"] += 1
            _log(f"{d}: file holds no rows for this date (file dates {file_dates[:2]}) -- nothing stored")
            continue
        try:
            n = store_day(conn, feats, "nse_fo_bhav_old" if d <= OLD_FORMAT_LAST else "nse_fo_udiff")
        except Exception as e:
            s["failed"] += 1
            _log(f"{d}: STORE FAILED {type(e).__name__}: {e}")
            continue
        s["fetched"] += 1
        s["rows"] += n
        if s["fetched"] % 25 == 0:
            _log(f"progress: {s} requests={fetcher.requests}")
    s["requests"] = fetcher.requests
    _log(f"summary: {s}")
    return s


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--since", default="2021-01-01")
    ap.add_argument("--until", default=OLD_FORMAT_LAST.isoformat())
    ap.add_argument("--date", help="one session (overrides --since/--until)")
    ap.add_argument("--max-requests", type=int, default=None)
    a = ap.parse_args(argv)
    since = until = dt.date.fromisoformat(a.date) if a.date else None
    if not a.date:
        since, until = dt.date.fromisoformat(a.since), dt.date.fromisoformat(a.until)
    conn = connect()
    try:
        s = run_range(conn, since, until, Fetcher(max_requests=a.max_requests))
    finally:
        conn.close()
    return 1 if (s["failed"] or s["aborted"]) else 0


if __name__ == "__main__":
    sys.exit(main())
