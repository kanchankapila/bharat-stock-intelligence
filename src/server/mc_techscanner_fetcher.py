#!/usr/bin/env python3
"""
MoneyControl Technical Scanners + Rating — forward-capture alt-data features
============================================================================
The breakout model tops out at ~0.61 AUC on OHLCV alone. The features that could push
past that (delivery/OI/rating/pattern flags) can't be backfilled — point-in-time scrapes
would leak the future. So we CAPTURE them daily going forward, accumulate, and retrain
later on the recent window.

This captures two FREE, open MoneyControl signals onto today's technical_signals rows:
  1. Breakout-pattern memberships (techscanner scanner-detail, full universe, ~12 calls):
     mc_bullish_scan_count (# bullish breakout scans matched), mc_scan_52w_high,
     mc_scan_squeeze_bo — ready-made "about to break out" flags.
  2. MC daily technical rating (technical-trends lists): mc_tech_rating ordinal
     (+2 turning-bullish, +1 bullish, -1 bearish, -2 turning-bearish, 0 neutral).

Maps MoneyControl scId -> NSE symbol via nse_stocks.mcsymbol. Writes only onto rows that
already exist for the latest date (the grid-ensurer guarantees full-universe coverage).

Run:  python mc_techscanner_fetcher.py
"""

import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from db_compat import connect
from as_of import logical_write_floor

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/124.0"}
SCAN_URL = "https://api.moneycontrol.com/mcapi/v1/techscanner/scanner-detail"
TREND_URL = "https://api.moneycontrol.com/mcapi/v1/technical-trends"

# Bullish breakout / momentum scans that count toward mc_bullish_scan_count.
BULLISH_SCANS = [
    (25, "OHLC_D_I_SQZBULLBO"),   # squeeze bullish breakout  (also its own flag)
    (25, "OHLC_D_I_RSIPOWBO"),    # RSI power breakout
    (20, "OHLC_20D_P_CLABVPWH"),  # close above prev-week high
    (25, "OHLC_D_I_BOLDBULL"),    # bold bullish candle
    (25, "OHLC_D_I_MOMRAVBU"),    # momentum reversal up
    (25, "OHLC_D_I_ST5133BULL"),  # supertrend bull
    (25, "OHLC_D_I_10DSTOCHBULL"),
    (25, "OHLC_D_I_RISE3BULL"),   # rising three methods
    (25, "OHLC_D_I_ADBBPBUY"),    # ADX+BB breakout buy
]
HIGH_SCANS = [
    (17, "OHLC_W_P_52HIGH"), (17, "OHLC_D_P_2YRHIGH"),
    (17, "OHLC_D_P_3YRHIGH"), (17, "OHLC_D_P_ALLTIMEH"),
]
SQUEEZE_SCAN = "OHLC_D_I_SQZBULLBO"

# scId sets per trend bucket → ordinal rating.
TRENDS = [
    ("uptrend/turning-bullish", 2), ("uptrend/bullish", 1),
    ("downtrend/bearish", -1), ("downtrend/turning-bearish", -2),
]


def _fetch_scan(session, cat_id: int, scan_id: str) -> set[str]:
    try:
        r = session.get(SCAN_URL, params={"catId": cat_id, "scanId": scan_id}, timeout=20)
        if r.status_code != 200:
            print(f"[MC_TECHSCANNER] scan catId={cat_id} scanId={scan_id} HTTP {r.status_code} — treating as 0 matches")
            return set()
        rows = (r.json().get("data") or {}).get("list", {}).get("scannerDetails") or []
        return {row["stkId"] for row in rows if row.get("stkId")}
    except Exception as e:
        print(f"[MC_TECHSCANNER] scan catId={cat_id} scanId={scan_id} failed: {e} — treating as 0 matches")
        return set()


def _fetch_trend(session, path: str) -> set[str]:
    """Page through a technical-trends list, collecting scIds."""
    out: set[str] = set()
    for page in range(1, 8):  # a few pages covers the liquid universe
        try:
            r = session.get(f"{TREND_URL}/{path}", params={
                "ex": "N", "index": "7", "page": page, "order": "desc",
                "deviceType": "W", "sort": "changeDate"}, timeout=20)
            rows = (r.json().get("data") or {}).get("list") or []
            if not rows:
                break
            out.update(row["scId"] for row in rows if row.get("scId"))
        except Exception as e:
            print(f"[MC_TECHSCANNER] trend path={path} page={page} failed: {e} — stopping pagination, {len(out)} collected so far")
            break
    return out


def run() -> int:
    conn = connect()
    # Align to the last completed trading session (same date the grid-ensurer builds), NOT
    # max(technical_signals.date) — a stray forward-dated row (e.g. an early next-day AI
    # signal) would otherwise misroute the writes onto a near-empty date.
    latest = logical_write_floor(conn)
    if not latest:
        print("[MCScan] no OHLCV rows.")
        return 0
    sc2sym = {r["mcsymbol"]: r["symbol"] for r in conn.execute(
        "SELECT symbol, mcsymbol FROM nse_stocks WHERE mcsymbol IS NOT NULL AND mcsymbol != ''"
    ).fetchall()}

    session = requests.Session()
    session.headers.update(HEADERS)
    t0 = time.time()

    bullish_sets: list[set[str]] = []
    high_set: set[str] = set()
    squeeze_set: set[str] = set()
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(_fetch_scan, session, c, s): (kind, s)
                for kind, lst in (("bull", BULLISH_SCANS), ("high", HIGH_SCANS))
                for (c, s) in lst}
        for f in as_completed(futs):
            kind, scan_id = futs[f]
            res = f.result()
            if kind == "high":
                high_set |= res
            else:
                bullish_sets.append(res)
                if scan_id == SQUEEZE_SCAN:
                    squeeze_set = res

    rating: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        tfuts = {ex.submit(_fetch_trend, session, path): ordv for path, ordv in TRENDS}
        for f in as_completed(tfuts):
            ordv = tfuts[f]
            for sc in f.result():
                # keep the strongest-magnitude signal if a stock appears in two buckets
                if sc not in rating or abs(ordv) > abs(rating[sc]):
                    rating[sc] = ordv

    # per-symbol bullish scan count
    from collections import Counter
    bull_count: Counter = Counter()
    for s in bullish_sets:
        bull_count.update(s)

    scids = set(bull_count) | high_set | squeeze_set | set(rating)
    updated = 0
    for sc in scids:
        sym = sc2sym.get(sc)
        if not sym:
            continue
        conn.execute(
            "UPDATE technical_signals SET mc_bullish_scan_count=?, mc_scan_52w_high=?, "
            "mc_scan_squeeze_bo=?, mc_tech_rating=? WHERE symbol=? AND date=?",
            (int(bull_count.get(sc, 0)), 1 if sc in high_set else 0,
             1 if sc in squeeze_set else 0, rating.get(sc), sym, latest))
        updated += 1
    conn.commit()
    conn.close()
    print(f"[MCScan] {latest}: {len(bull_count)} bullish-scan / {len(high_set)} 52w-high / "
          f"{len(rating)} rated scIds; updated {updated} technical_signals rows "
          f"in {time.time()-t0:.0f}s.")
    return updated


if __name__ == "__main__":
    run()
