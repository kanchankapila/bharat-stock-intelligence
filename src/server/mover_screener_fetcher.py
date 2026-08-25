"""
Ground-Truth Mover Screener Fetcher
===================================
The reverse-engineering backbone: every day the market itself tells us which stocks are
working (top gainers/losers, gap-ups/gap-downs, open=low bulls, open=high bears, volume
shockers, intraday breakouts). Those public screener lists were previously visible on the
sites we already scrape but NEVER persisted, so we could never answer "what did tomorrow's
winners look like yesterday?".

This module persists two kinds of ground truth into `mover_snapshots`:

  A. LIVE SCREENER CAPTURES (point-in-time, cannot be reconstructed later):
     - ET Markets gainers/losers, duration=1 day and 1 week   (etmarketsapis.indiatimes.com)
     - MarketsMojo market gainers/losers                      (frapi.marketsmojo.com)
     - NiftyTrader top gainers              (api.niftytrader.in)
     - ET Markets candlestick/pattern screens -- 7 verified filters via
        ET_TechnicalScreeners/getFilteredData (the classic /ET_Stats/gainers
        listing went down server-side 2026-08-25; fetch_et() stays wired and
        resumes automatically if ET repairs it)
     - NiftyTrader filtered EOD screens -- gap up/down (+unfill), close +/-5%,
        open=low/high, near-day-high/low close, high-delivery -- via
        Screener/advance-eod-screener-filter (see NT_EOD_SCREENS; routes
        reverse-engineered from NT's own Next.js bundles 2026-08-25,
        unauthenticated POST)
      - NiftyTrader live market screener, Prime-token-gated    (Screener/live-market-filter-data)
      - MoneyControl price shockers                            (api.moneycontrol.com)

  B. COMPUTED CLASSES from our own stock_ohlcv (backfillable over full history):
     - calc_gap_up / calc_gap_down        |gap| >= GAP_THRESHOLD_PCT vs prev close
     - calc_open_eq_low                   opened on the low, closed above open (bullish hold)
     - calc_open_eq_high                  opened on the high, closed below open (bearish hold)
     - calc_volume_shocker                volume >= VOLUME_SHOCKER_X x trailing 20d median
     - calc_intraday_breakout             high > prior 20d high AND close holds top 25% of range

Computed classes use exactly the definitions the study (reverse_engineering_study.py)
consumes, so live captures and backfill land in one comparable schema.

Run:
    python mover_screener_fetcher.py                      # live captures + today's classes
    python mover_screener_fetcher.py --backfill-days 250  # rebuild classes from history
    python mover_screener_fetcher.py --sources et_gainers_1d,calc_intraday_breakout
"""

import argparse
import datetime
import json
import os
import sys
from collections import Counter

import requests
from curl_cffi import requests as cffi_requests

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from db_compat import connect, translate  # noqa: E402

# ---------------------------------------------------------------------------

GAP_THRESHOLD_PCT = 2.0      # |open/prev_close - 1| >= 2% -> gap event
OPEN_EQ_TOL_PCT = 0.15       # open within 0.15% of prev_close of the day low/high
OPEN_EQ_MIN_RANGE_PCT = 1.0  # day must travel >= 1% (else open=high=low=close illiquid noise)
VOLUME_SHOCKER_X = 5.0       # volume >= 5x trailing 20-session median
BREAKOUT_LOOKBACK = 20       # prior-session high window for intraday breakout
BREAKOUT_CLOSE_POS = 0.75    # close must sit in the top 25% of the day's range

ET_GAINERS_URL = ("https://etmarketsapis.indiatimes.com/ET_Stats/gainers"
                  "?pagesize=50&marketcap=largecap%2Cmidcap%2Csmallcap&duration={dur}"
                  "&sort=intraday&sortby=percentchange&sortorder={order}&pageno=1")
MOJO_MOVERS_URL = "https://frapi.marketsmojo.com/market_Gainersloser/getData?exchange=0&type={t}&"
NT_GAINERS_URL = "https://webapi.niftytrader.in/webapi/symbol/top-gainers-data?fno_stock=false"
# Post-close EOD screener (reverse-engineered 2026-08-25 from www.niftytrader.in's own
# Next.js chunks -- routes moved under /webapi/Screener/ with a capital S; the old flat
# paths in ai_endpoint_memory.json all 404). Unauthenticated POST, empty body = full
# ~1,026-stock universe; boolean filter flags narrow server-side. Rows self-label with
# t0_date, so weekend/holiday runs land on the right session automatically.
NT_EOD_SCREENER_URL = "https://webapi.niftytrader.in/webapi/Screener/advance-eod-screener-filter"
# Intraday variant of the same screener. PRIME-GATED (401 without auth, probed live):
# needs the Bearer JWT that niftytraderAuthService.ts maintains in
# app_settings.niftytrader_auth_token. Best-effort only -- skipped silently when the
# token is absent/expired; the EOD screens above always run.
NT_LIVE_SCREENER_URL = "https://webapi.niftytrader.in/webapi/Screener/live-market-filter-data"

NT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Content-Type": "application/json",
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
    "Accept": "application/json",
}

# Screen catalog: mover_snapshots source -> NT filter body. Names deliberately mirror the
# calc_* taxonomy (calc_gap_up <-> nteod_gap_up ...) so reverse_engineering_study.py gets
# same-definition cross-provider cohorts: agreement between OUR computed class and THEIRS
# on independent universes is exactly the corroboration signal the study scores.
NT_EOD_SCREENS = [
    ("nteod_gap_up",          {"gap_up_opening": True}),
    ("nteod_gap_down",        {"gap_down_opening": True}),
    ("nteod_gap_up_unfill",   {"gap_up_opening_unfill": True}),
    ("nteod_gain5",           {"close_more_5_gain": True}),
    ("nteod_loss5",           {"close_more_5_down": True}),
    ("nteod_open_eq_low",     {"same_open_low": True}),
    ("nteod_open_eq_high",    {"same_open_high": True}),
    ("nteod_near_high_close", {"close_nearday_high": True}),
    ("nteod_near_low_close",  {"close_nearday_low": True}),
    ("nteod_high_delivery",   {"high_delivery_age_qty": True}),
]
MC_SHOCKERS_URL = "https://api.moneycontrol.com/mcapi/v1/earnings/price-shockers?limit=50&page=1"
# ET's long-standing /ET_Stats/gainers listing went hard-down server-side on 2026-08-25
# ("503 - DNS failure" from their edge for EVERY marketstats listing route while
# /ET_Stats/mobile, /sectorperformance and /ET_TechnicalScreeners still serve 200s --
# their upstream, not our client). Kept wired in fetch_et() so capture resumes
# automatically if ET repairs it; the healthy TechnicalScreeners service below is the
# replacement ground truth until then.
ET_TECH_SCREENER_URL = ("https://etmarketsapis.indiatimes.com"
                        "/ET_TechnicalScreeners/getFilteredData/{pattern}")

# Verified-live predefined filters (2026-08-25). Unknown names 503 identically to a
# dead upstream, so this list is pinned rather than discovered at runtime.
ET_SCREENS = [
    ("et_screen_long_white_candle", "LONG_WHITE_CANDLE"),
    ("et_screen_long_black_candle", "LONG_BLACK_CANDLE"),
    ("et_screen_doji",              "DOJI"),
    ("et_screen_hammer",            "HAMMER"),
    ("et_screen_inverted_hammer",   "INVERTED_HAMMER"),
    ("et_screen_morning_star",      "MORNING_STAR"),
    ("et_screen_evening_star",      "EVENING_STAR"),
]


def _et_company_map() -> dict | None:
    """{companyId -> NSE symbol} from scripts/stocklist.json (ET's own ids,
    same file et_stats_client.py resolves companyid from)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "..", "scripts", "stocklist.json")
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
        return {str(r["companyid"]): r["symbol"].upper() for r in rows
                if r.get("companyid") and r.get("symbol")}
    except Exception as e:
        print(f"[et_screen] companyid map unavailable ({e})")
        return None


def fetch_et_screens(session, wanted: set | None = None, trade_date: str = "") -> list:
    """ET TechnicalScreeners candlestick/pattern cohorts -> mover_snapshots tuples.

    Rows carry companyId + OHLC only (no pct field), identity resolved via
    stocklist.json; unmapped ids are skipped. filterDto.resultDate is the session the
    screen was computed for -- a batch whose date does not match today's capture target
    is skipped wholesale (a weekend/holiday run must not land Friday's screens on the
    wrong day). One bad pattern never blocks the rest; HTTP 503 = unknown/dead filter.
    """
    cmap = _et_company_map()
    screens = ET_SCREENS
    if wanted:
        specific = [w for w in wanted if w.startswith("et_screen_")]
        if specific:
            named = {s for s, _ in screens} & set(specific)
            screens = [(s, p) for s, p in screens if s in named] or screens
    want_dmy = ""
    if trade_date:
        try:
            want_dmy = datetime.datetime.strptime(trade_date, "%Y-%m-%d").strftime("%d %b")
        except ValueError:
            want_dmy = ""
    out = []
    for source, pattern in screens:
        try:
            r = session.get(ET_TECH_SCREENER_URL.format(pattern=pattern),
                            headers=ET_HEADERS, timeout=15)
            if r.status_code != 200:
                print(f"[{source}] http {r.status_code}, skipping")
                continue
            js = r.json()
            fdto = js.get("filterDto") or {}
            result_date = str(fdto.get("resultDate") or "")
            if want_dmy and want_dmy not in result_date:
                print(f"[{source}] stale batch ({result_date!r}); skipping")
                continue
            seen, rank = set(), 0
            for row in js.get("page") or []:
                sym = (cmap or {}).get(str(row.get("companyId")))
                if not sym or sym in seen:
                    continue          # unmapped ET id: never persist a bare id/name
                seen.add(sym)
                rank += 1
                payload = {"companyName": row.get("companyName"),
                           "screenerType": fdto.get("screenerType"),
                           "resultDate": result_date}
                payload.update({k: row[k] for k in
                                ("openPrice", "highPrice", "lowPrice", "closePrice")
                                if row.get(k) is not None})
                out.append((source, sym, rank, None, None,
                            json.dumps(payload, default=str)))
            print(f"[{source}] captured {rank} rows")
        except Exception as e:
            print(f"[{source}] fetch failed: {e}")
    return out

MC_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Accept": "application/json",
}
ET_HEADERS = {
    "User-Agent": MC_HEADERS["User-Agent"],
    "Referer": "https://economictimes.indiatimes.com/markets",
    "Accept": "application/json",
}

LIVE_SOURCES = ["et_gainers_1d", "et_losers_1d", "et_gainers_1w", "et_losers_1w",
                "mojo_gainers", "mojo_losers", "nt_top_gainers", "mc_price_shockers",
                "nteod_", "ntlive_", "et_screen_"]
CALC_SOURCES = ["calc_gap_up", "calc_gap_down", "calc_open_eq_low", "calc_open_eq_high",
                "calc_volume_shocker", "calc_intraday_breakout"]

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

DDL = """
CREATE TABLE IF NOT EXISTS mover_snapshots (
    source        TEXT NOT NULL,
    trade_date    TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    rank          INTEGER,
    pct_change    REAL,
    metric_value  REAL,
    captured_at   TEXT,
    payload_json  TEXT,
    PRIMARY KEY (source, trade_date, symbol)
)
"""


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute(translate(DDL))
    con.commit()


# ---------------------------------------------------------------------------
# Defensive JSON row extraction (source shapes drift; be forgiving)
# ---------------------------------------------------------------------------

def _ci_get(d, *names):
    """Case-insensitive key lookup returning the first present value."""
    lower = {str(k).lower(): v for k, v in d.items()} if isinstance(d, dict) else {}
    for n in names:
        if n.lower() in lower:
            return lower[n.lower()]
    return None


def _to_float(v):
    try:
        if v is None:
            return None
        return float(str(v).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None


SYMBOL_KEYS = ("nse_symbol", "nsesymbol", "symbol_name", "symbol", "symbolcode", "scrip",
               "security", "ticker", "shortname", "scripcode")


def _find_rows(obj, depth: int = 0, acc=None):
    """Depth-first walk collecting EVERY plausible list of stock dicts.

    Some sources (MarketsMojo) group rows into sector buckets ({index, stocks:[...]}),
    so stopping at the first hit would silently drop most of the payload.
    """
    if acc is None:
        acc = []
    if depth > 8:
        return acc
    if isinstance(obj, list):
        dicts = [x for x in obj if isinstance(x, dict)]
        if dicts and all(_ci_get(x, *SYMBOL_KEYS) is not None for x in dicts):
            if dicts not in acc:
                acc.append(dicts)
        else:
            for x in obj:
                _find_rows(x, depth + 1, acc)
    elif isinstance(obj, dict):
        for v in obj.values():
            _find_rows(v, depth + 1, acc)
    return acc


def _rows_from_response(resp, label: str):
    try:
        body = resp.json()
    except ValueError:
        print(f"[{label}] non-JSON response ({resp.status_code}), skipping")
        return []
    groups = _find_rows(body)
    rows = [r for g in groups for r in g]
    # de-dupe on symbol keeping first occurrence (list order = rank order)
    seen, out = set(), []
    for r in rows:
        sym = str(_ci_get(r, *SYMBOL_KEYS) or "").upper()
        if sym and sym not in seen:
            seen.add(sym)
            out.append(r)
    if not out:
        keys = list(body)[:12] if isinstance(body, dict) else type(body).__name__
        print(f"[{label}] no recognizable stock rows (top-level: {keys})")
    return out


# ---------------------------------------------------------------------------
# Live sources
# ---------------------------------------------------------------------------

def normalize_row(row: dict, rank: int) -> tuple | None:
    """(symbol, rank, pct_change, metric_value, payload_json) or None if unusable."""
    sym = _ci_get(row, *SYMBOL_KEYS)
    if isinstance(sym, str):
        sym = sym.strip().upper()
    if not sym or len(sym) > 20 or " " in sym:
        return None
    pct = _to_float(_ci_get(row, "percentchange", "pctchange", "percent_change",
                            "change_percent", "percentagechange", "pct_change"))
    metric = _to_float(_ci_get(row, "gap_percent", "gappercent", "volume_ratio",
                               "oi_percentchange", "lastprice", "value"))
    slim = {k: row[k] for k in list(row)[:40] if isinstance(k, str)}
    return (sym, rank, pct, metric, json.dumps(slim, default=str))


def fetch_et(session, dur_label: str, dur_param: str, order: str = "desc") -> list:
    label = f"et_{dur_label}"
    rows = []
    try:
        resp = session.get(ET_GAINERS_URL.format(dur=dur_param, order=order),
                           headers=ET_HEADERS, timeout=15)
        resp.raise_for_status()
        rows = _rows_from_response(resp, label)
    except Exception as e:
        print(f"[{label}] fetch failed: {e}")
    out = []
    for i, row in enumerate(rows, 1):
        norm = normalize_row(row, i)
        if norm:
            out.append((label,) + norm)
    return out


def _mojo_sid_map() -> dict | None:
    """{stockid -> NSE symbol} from scripts/stocklist.json (Mojo's own ids).

    The gainers/losers feed identifies stocks by Mojo's internal numeric id plus a
    display NAME -- no symbol field -- so without this crosswalk rows are unusable
    downstream. Same file marketsmojo_technical_fetcher.py uses for the same ids.
    Returns None when the file is missing/unreadable (callers then skip sid-only rows).
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "..", "..", "scripts", "stocklist.json")
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
        return {str(r["stockid"]): r["symbol"].upper() for r in rows
                if r.get("stockid") and r.get("symbol")}
    except Exception as e:
        print(f"[mojo] stocklist.json sid map unavailable ({e})")
        return None


def fetch_mojo(session) -> list:
    """MarketsMojo market gainers/losers -> mover_snapshots tuples.

    Live shape (verified 2026-08-25): data.gainers / data.losers hold index-bucketed
    groups ({index:'NIFTY500', stocks:[{name, cmp, chg, chgp, ..., sid}]}) whose rows
    carry NO symbol -- identity is Mojo's sid, resolved via stocklist.json. Buckets
    overlap (NIFTY500 contains the sub-index members), so rows are de-duped per label
    keeping first occurrence. Legacy flat/bucketed shapes WITH symbol keys still parse
    (older payloads needed no crosswalk).
    """
    out = []
    sid_map = _mojo_sid_map()
    for t, label in ((1, "mojo_gainers"), (0, "mojo_losers")):
        raw_rows = []
        try:
            resp = session.get(MOJO_MOVERS_URL.format(t=t),
                               headers={"User-Agent": MC_HEADERS["User-Agent"],
                                        "Referer": "https://www.marketsmojo.com/",
                                        "Accept": "application/json"}, timeout=15)
            resp.raise_for_status()
            body = resp.json()
            data = body.get("data") if isinstance(body, dict) else None
            if isinstance(data, dict):
                # current shape (verified 2026-08-25): keyed by side
                buckets = data.get("gainers" if t == 1 else "losers")
            elif isinstance(data, list):
                # legacy shape: data IS the bucket list already
                buckets = data
            else:
                buckets = None
            if isinstance(buckets, list):
                for b in buckets:
                    if isinstance(b, dict) and isinstance(b.get("stocks"), list):
                        raw_rows += b["stocks"]
            else:
                raw_rows = [r for g in _rows_from_response(resp, label) for r in g]
        except Exception as e:
            print(f"[{label}] fetch failed: {e}")
        seen, rank = set(), 0
        for row in raw_rows:
            sym = _ci_get(row, *SYMBOL_KEYS)
            if sym:
                sym = str(sym).strip().upper()
            else:
                sid = row.get("sid") if isinstance(row, dict) else None
                sym = (sid_map or {}).get(str(sid))
                if not sym:
                    continue          # unmapped Mojo id: never persist a bare name/id
            if sym in seen:
                continue              # duplicate across overlapping index buckets
            seen.add(sym)
            rank += 1
            pct = _to_float(_ci_get(row, "chgp", "pctchange", "percentChange"))
            payload = {k: v for k, v in row.items() if v not in (None, "")
                       and not str(k).startswith("is_blur")}
            out.append((label, sym, rank, pct,
                        _to_float(_ci_get(row, "cmp")),
                        json.dumps(payload, default=str)))
        print(f"[{label}] captured {rank} rows")
    return out


def fetch_niftytrader(session) -> list:
    rows = []
    try:
        resp = session.get(NT_GAINERS_URL,
                           headers={"User-Agent": MC_HEADERS["User-Agent"],
                                    "Accept": "application/json"}, timeout=15)
        resp.raise_for_status()
        rows = _rows_from_response(resp, "nt_top_gainers")
    except Exception as e:
        print(f"[nt_top_gainers] fetch failed: {e}")
    out = []
    for i, row in enumerate(rows, 1):
        norm = normalize_row(row, i)
        if norm:
            out.append(("nt_top_gainers",) + norm)
    print(f"[nt_top_gainers] captured {len(out)} rows")
    return out


def _mc_symbol_map() -> dict | None:
    """{mcsymbol -> NSE symbol} from nse_stocks for MC's scID-keyed payloads.

    The earnings-shockers endpoint identifies stocks by MoneyControl's internal
    codes ("SSM05"), not NSE symbols; without this crosswalk rows are unusable
    downstream. Returns None when the lookup fails so callers fall back to
    legacy behavior instead of dying.
    """
    try:
        from db_compat import query_all
        rows = query_all("SELECT mcsymbol, symbol FROM nse_stocks "
                         "WHERE mcsymbol IS NOT NULL AND mcsymbol <> ''")
        return {r["mcsymbol"].strip().upper(): r["symbol"] for r in rows}
    except Exception as e:
        print(f"[mc_price_shockers] symbol-map lookup failed ({e})")
        return None


def fetch_mc_shockers(session, symbol_map: dict | None = None) -> list:
    """MoneyControl earnings-date price shockers -> mover_snapshots tuples.

    Live shape (verified 2026-08-25): columnar -- data.header is a [{name,type}]
    table and data.list is row-major value arrays keyed by position. Identity is
    scID (MC internal code), mapped to the real NSE symbol via nse_stocks.mcsymbol;
    unmapped codes are skipped (a bare MC code in the symbol column would poison
    every T-1/T join in the study). metric_value = %Gain/Loss Since Result Date
    when present (this list is earnings-anchored), payload keeps the raw context
    (Result Date, LTP, Name). Older flat list-of-dicts shapes still parse.
    """
    try:
        resp = session.get(MC_SHOCKERS_URL, headers=MC_HEADERS, timeout=15)
        resp.raise_for_status()
        body = resp.json()
        rows: list[dict] = []
        data = body.get("data") if isinstance(body, dict) else None
        hdr = data.get("header") if isinstance(data, dict) else None
        lst = data.get("list") if isinstance(data, dict) else None
        if isinstance(hdr, list) and isinstance(lst, list):
            names = [h.get("name") for h in hdr if isinstance(h, dict)]
            for vals in lst:
                if isinstance(vals, list):
                    d = {n: v for n, v in zip(names, vals) if n}
                    # scID IS the identity here -- surface it under the canonical key
                    # so the SYMBOL_KEYS lookup and mcsymbol mapping see it.
                    if d.get("scID") is not None and not d.get("symbol"):
                        d["symbol"] = d.pop("scID")
                    rows.append(d)
        else:
            rows = _rows_from_response(resp, "mc_price_shockers")
    except Exception as e:
        print(f"[mc_price_shockers] fetch failed: {e}")
        rows = []
    out = []
    rank = 0
    for row in rows:
        sym = _ci_get(row, *SYMBOL_KEYS)
        if not sym:
            continue
        sym = str(sym).strip()
        if symbol_map:
            mapped = symbol_map.get(sym.upper())
            if not mapped:
                continue          # unknown MC code: never persist as-is
            sym = mapped
        rank += 1
        pct = _to_float(_ci_get(row, "percentChange", "Chg%", "change_percent"))
        metric = _to_float(_ci_get(row, "%Gain/Loss Since Result Date",
                                   "gainSinceResult", "sinceResult"))
        payload = {k: v for k, v in row.items()
                   if k.lower() not in ("stockurl",) and v not in (None, "")}
        out.append(("mc_price_shockers", sym.strip().upper(), rank,
                    pct, metric, json.dumps(payload, default=str)))
    print(f"[mc_price_shockers] captured {len(out)} rows")
    return out


def _nt_bearer_token():
    """Best-effort read of the JWT niftytraderAuthService.ts maintains in
    app_settings.niftytrader_auth_token. Returns None (never raises) when the
    token was never captured or the lookup fails -- the live screener is then
    skipped rather than erroring, since the EOD screens carry the pipeline."""
    try:
        from db_compat import query_scalar
        return query_scalar(
            "SELECT value FROM app_settings WHERE key = 'niftytrader_auth_token'")
    except Exception as e:
        print(f"[ntlive] token lookup failed ({e}); live screener will be skipped")
        return None


def _norm_live_row(row) -> tuple | None:
    """One live/EOD screener row -> (symbol, pct_change, metric_value, payload_dict),
    or None when unusable. Absorbs both key dialects (EOD: symbol/
    priceChangePercentage/t0_*; live: symbol_name/change_per/ohlc+fundamentals)."""
    sym = _ci_get(row, "symbol_name", "symbol", *SYMBOL_KEYS)
    if not sym:
        return None
    pct = _to_float(_ci_get(row, "priceChangePercentage", "change_percent", "change_per"))
    metric = _to_float(_ci_get(row, "t0_deliveryPercentage", "delivery_pct"))
    payload = {}
    for k in ("t0_close", "t0_open", "t0_high", "t0_low", "t0_volume",
              "t0_deliveryPercentage", "t0_20avgVolume", "priceChange",
              "t0_rsi", "t0_date", "last_trade_price",
              # live cross-section fields
              "open", "high", "low", "volume", "change_value", "change_per",
              "gap_up_down", "nr7", "market_cap", "stock_pe", "roe", "dividend_yield"):
        v = row.get(k)
        if v is not None:
            payload[k] = v
    return str(sym).strip().upper(), pct, metric, payload


def _rows_from_nt_screener_data(data, source: str) -> list:
    out = []
    if not isinstance(data, list):
        return out
    for i, row in enumerate(data, 1):
        if not isinstance(row, dict):
            continue
        n = _norm_live_row(row)
        if not n:
            continue
        sym, pct, metric, payload = n
        out.append((source, sym, i, pct, metric,
                    json.dumps(payload, default=str)))
    return out


def _rows_from_nt_screener(resp, source: str) -> list:
    """NT screener response -> mover_snapshots live-layout tuples
    (source, symbol, rank, pct_change, metric_value, payload_json)."""
    js = resp.json()
    data = js.get("resultData") if isinstance(js, dict) else None
    if isinstance(data, dict):
        data = data.get("data")
    return _rows_from_nt_screener_data(data, source)


# Live screens are evaluated LOCALLY over the cross-section: the endpoint ignores
# filter bodies entirely (verified 2026-08-25 -- any body returns the same
# ~1,005-row universe with every indicator inline), so ONE request per time slot
# feeds every screen. Sources carry the slot stamp so each capture time becomes
# its own cohort the study can score against EOD outcomes independently.
NT_LIVE_SCREENS = [
    ("gap_up",    lambda p: str(p.get("gap_up_down") or "").strip().lower() == "gap up"),
    ("gap_down",  lambda p: str(p.get("gap_up_down") or "").strip().lower() == "gap down"),
    ("gain5",     lambda p: (_to_float(p.get("change_per")) if _to_float(p.get("change_per")) is not None else -999.0) >= 5.0),
    ("loss5",     lambda p: (_to_float(p.get("change_per")) if _to_float(p.get("change_per")) is not None else 999.0) <= -5.0),
    ("near_high", lambda p: (_to_float(p.get("high")) or 0) > 0 and
                   (_to_float(p.get("last_trade_price")) or 0) >= 0.995 * _to_float(p.get("high"))),
    ("near_low",  lambda p: (_to_float(p.get("low")) or 0) > 0 and
                   (_to_float(p.get("last_trade_price")) if _to_float(p.get("last_trade_price")) is not None else 9e9) <= 1.005 * _to_float(p.get("low"))),
]


def _live_screen_tuples(data, hhmm: str) -> list:
    """Full-universe snapshot (ntlive_<hhmm>_market) + one cohort per NT_LIVE_SCREENS
    hit (ntlive_<hhmm>_<screen>), all from a single fetched cross-section."""
    out, norms = [], []
    for i, row in enumerate(data if isinstance(data, list) else [], 1):
        if not isinstance(row, dict):
            continue
        n = _norm_live_row(row)
        if not n:
            continue
        sym, pct, metric, payload = n
        out.append((f"ntlive_{hhmm}_market", sym, len(out) + 1, pct, metric,
                    json.dumps(payload, default=str)))
        norms.append((sym, pct, metric, payload))
    for suffix, pred in NT_LIVE_SCREENS:
        src = f"ntlive_{hhmm}_{suffix}"
        rank = 0
        for sym, pct, metric, payload in norms:
            try:
                hit = pred(payload)
            except Exception:
                hit = False
            if not hit:
                continue
            rank += 1
            out.append((src, sym, rank, pct, metric,
                        json.dumps(payload, default=str)))
    return out


def fetch_nt_screens(session, wanted: set | None = None) -> list:
    """Capture every cataloged NT EOD screen (one POST each; one bad screen
    never blocks the rest). A --sources run naming a specific nteod_* source
    narrows the catalog to just that screen."""
    screens = NT_EOD_SCREENS
    if wanted:
        specific = [w for w in wanted if w.startswith("nteod_")]
        if specific:
            screens = [(s, b) for s, b in screens if s in specific]
    out = []
    for source, body in screens:
        try:
            r = session.post(NT_EOD_SCREENER_URL, headers=NT_HEADERS,
                             data=json.dumps(body), timeout=30)
            r.raise_for_status()
            rows = _rows_from_nt_screener(r, source)
            out += rows
            print(f"[{source}] captured {len(rows)} rows")
        except Exception as e:
            print(f"[{source}] fetch failed: {e}")
    return out


def fetch_nt_live_screener(session, bearer: str | None = None, hhmm: str = "eod") -> list:
    """Prime-gated intraday cross-section -> slot-stamped market snapshot + local
    screens (see NT_LIVE_SCREENS). Best-effort: returns [] when no token /
    unauthorized / any failure -- the EOD screens always carry the capture."""
    if not bearer:
        print(f"[ntlive_{hhmm}] no stored NT token; skipping live screener")
        return []
    try:
        r = session.post(NT_LIVE_SCREENER_URL,
                         headers={**NT_HEADERS, "Authorization": f"Bearer {bearer}"},
                         data=json.dumps({}), timeout=30)
        if r.status_code == 401:
            print(f"[ntlive_{hhmm}] unauthorized (token absent/expired/no Prime); skipping")
            return []
        r.raise_for_status()
        js = r.json()
        data = js.get("resultData") if isinstance(js, dict) else None
        if isinstance(data, dict):
            data = data.get("data")
        rows = _live_screen_tuples(data, hhmm)
        print(f"[ntlive_{hhmm}_*] captured {len(rows)} rows (market + {len(NT_LIVE_SCREENS)} screens)")
        return rows
    except Exception as e:
        print(f"[ntlive_{hhmm}] fetch failed: {e}")
        return []


def fetch_live(trade_date: str, wanted: set | None = None, hhmm: str = "eod") -> list:
    """Capture every reachable live screener list; one bad host never blocks the rest.

    Returns tuples laid out as (source, symbol, rank, pct, metric, payload, trade_date).
    """
    session = cffi_requests.Session(impersonate="chrome")
    out = []
    et_wanted = {"et_gainers_1d", "et_losers_1d", "et_gainers_1w", "et_losers_1w"}
    if not wanted or wanted & et_wanted:
        try:
            out += fetch_et(session, "gainers_1d", "1%20day")
            out += fetch_et(session, "losers_1d", "1%20day", order="asc")
            out += fetch_et(session, "gainers_1w", "1%20week")
            out += fetch_et(session, "losers_1w", "1%20week", order="asc")
        except Exception as e:
            print(f"[et] block failed hard: {e}")
    for fn, tag in ((fetch_mojo, "mojo"), (fetch_niftytrader, "nt"),
                    (lambda s: fetch_mc_shockers(s, symbol_map=_mc_symbol_map()),
                     "mc_price_shockers"),
                    (lambda s: fetch_nt_screens(s, wanted), "nteod"),
                    (lambda s: fetch_et_screens(s, wanted, trade_date), "et_screen"),
                    (lambda s: fetch_nt_live_screener(
                        s, _nt_bearer_token() if not wanted or any(
                            w.startswith("ntlive") for w in wanted) else None, hhmm),
                     "ntlive")):
        if wanted and not any(s.startswith(tag) or tag.startswith(s) for s in wanted):
            continue
        try:
            out += fn(session)
        except Exception as e:
            print(f"[{tag}] failed hard: {e}")
    return [r + (trade_date,) for r in out]


# ---------------------------------------------------------------------------
# Computed classes from stock_ohlcv (vectorized, backfillable)
# ---------------------------------------------------------------------------

CLASS_SPEC = [
    # (source name, boolean flag column, metric column stored as metric_value)
    ("calc_gap_up", "gap_up", "gap_pct"),
    ("calc_gap_down", "gap_down", "gap_pct"),
    ("calc_open_eq_low", "open_eq_low", "day_chg_pct"),
    ("calc_open_eq_high", "open_eq_high", "day_chg_pct"),
    ("calc_volume_shocker", "volume_shocker", "vol_ratio"),
    ("calc_intraday_breakout", "intraday_breakout", "day_chg_pct"),
]


def compute_classes_frame(ohlcv):
    """Given a DataFrame (symbol, date, open, high, low, close, volume) sorted by
    (symbol, date), append per-day class flags + helper metric columns."""
    import numpy as np
    df = ohlcv.copy()
    g = df.groupby("symbol", sort=False)
    df["prev_close"] = g["close"].shift(1)
    df["prev_high_n"] = g["high"].transform(
        lambda s: s.shift(1).rolling(BREAKOUT_LOOKBACK, min_periods=10).max())
    df["vol_med20"] = g["volume"].transform(
        lambda s: s.shift(1).rolling(20, min_periods=10).median())

    pc = df["prev_close"]
    rng = df["high"] - df["low"]
    df["gap_pct"] = np.where(pc > 0, (df["open"] - pc) / pc * 100.0, np.nan)
    df["day_chg_pct"] = np.where(pc > 0, (df["close"] - pc) / pc * 100.0, np.nan)
    df["vol_ratio"] = np.where(df["vol_med20"] > 0, df["volume"] / df["vol_med20"], np.nan)

    tol = OPEN_EQ_TOL_PCT / 100.0 * pc
    min_rng = OPEN_EQ_MIN_RANGE_PCT / 100.0 * pc
    df["gap_up"] = df["gap_pct"] >= GAP_THRESHOLD_PCT
    df["gap_down"] = df["gap_pct"] <= -GAP_THRESHOLD_PCT
    df["open_eq_low"] = (((df["low"] - df["open"]).abs() <= tol)
                         & (rng >= min_rng) & (df["close"] > df["open"]))
    df["open_eq_high"] = (((df["high"] - df["open"]).abs() <= tol)
                          & (rng >= min_rng) & (df["close"] < df["open"]))
    df["volume_shocker"] = df["vol_ratio"] >= VOLUME_SHOCKER_X
    close_pos = np.where(rng > 0, (df["close"] - df["low"]) / rng, np.nan)
    df["intraday_breakout"] = (df["high"] > df["prev_high_n"]) & (close_pos >= BREAKOUT_CLOSE_POS)
    return df


def compute_rows_for_dates(ohlcv, dates: set) -> list:
    """Emit mover_snapshots tuples for the requested trade dates.

    Layout: (source, trade_date, symbol, rank, metric_value, pct_change, payload_json).
    """
    df = compute_classes_frame(ohlcv)
    df = df[df["date"].astype(str).isin({str(d) for d in dates})]
    out = []
    for src, flag, metric in CLASS_SPEC:
        sub = df[df[flag].fillna(False)]
        for rec in sub.itertuples(index=False):
            mv = getattr(rec, metric)
            dc = rec.day_chg_pct
            out.append((
                src, str(rec.date), rec.symbol, None,
                None if mv is None or mv != mv else round(float(mv), 4),
                None if dc != dc else round(float(dc), 4),
                json.dumps({"gap_pct": _safe(rec.gap_pct), "vol_ratio": _safe(rec.vol_ratio),
                            "close": _safe(rec.close)}),
            ))
    return out


def _safe(v):
    try:
        f = float(v)
        return None if f != f else round(f, 4)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

INSERT_SQL = """
INSERT INTO mover_snapshots
    (source, trade_date, symbol, rank, pct_change, metric_value, captured_at, payload_json)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(source, trade_date, symbol) DO UPDATE SET
    rank         = excluded.rank,
    pct_change   = excluded.pct_change,
    metric_value = excluded.metric_value,
    captured_at  = excluded.captured_at,
    payload_json = excluded.payload_json
"""


def persist(con, rows: list, captured_at):
    """Rows arrive in one of two layouts (live vs computed); route on the source prefix."""
    cur = con.cursor()
    n = 0
    for r in rows:
        if r[0].startswith("calc_"):
            src, td, sym, rk, mv, pct, pj = r
        else:
            src, sym, rk, pct, mv, pj, td = r
        cur.execute(translate(INSERT_SQL), (src, td, sym, rk, pct, mv, captured_at, pj))
        n += 1
    con.commit()
    return n


def load_ohlcv(con, lookback_days: int):
    """OHLCV frame for the trailing window (calendar-days * 1.6 -> ~N sessions).

    Uses db_compat.query_all rather than pd.read_sql so placeholder translation
    stays identical to every other engine on both dialects.
    """
    import pandas as pd
    from db_compat import query_all
    cutoff = (datetime.date.today() - datetime.timedelta(days=int(lookback_days * 1.6))).isoformat()
    rows = query_all("SELECT symbol, date, open, high, low, close, volume "
                     "FROM stock_ohlcv WHERE date >= ? ORDER BY symbol, date", (cutoff,))
    df = pd.DataFrame([dict(r) for r in rows])
    return df.sort_values(["symbol", "date"]).reset_index(drop=True) if len(df) else df


def resolve_trade_date(con) -> str:
    """Most recent session date present in stock_ohlcv, else today.

    Guards weekend/holiday captures from being mislabeled with the wall-clock date
    (a Saturday run must land on Friday's session or the study's T-1/T alignment breaks).
    """
    try:
        from db_compat import query_one
        row = query_one("SELECT MAX(date) AS d FROM stock_ohlcv WHERE symbol IN "
                        "('NIFTY50','RELIANCE')")
        if row and row["d"]:
            return str(row["d"])[:10]
    except Exception as e:
        print(f"[mover] session-date lookup failed ({e}); falling back to today")
    return datetime.date.today().strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Persist ground-truth mover screener lists")
    ap.add_argument("--backfill-days", type=int, default=0,
                    help="rebuild computed classes for the last N sessions from stock_ohlcv")
    ap.add_argument("--sources", type=str, default="",
                    help="comma-separated subset of sources to run")
    ap.add_argument("--intraday", action="store_true",
                    help="intraday slot capture: one NT live cross-section POST -> "
                         "ntlive_<HHMM>_market + local screens; skips calc and all "
                         "other providers so a cron can run it several times a day")
    args = ap.parse_args()
    wanted = {s.strip() for s in args.sources.split(",") if s.strip()} or None

    con = connect()
    ensure_schema(con)
    now_iso = datetime.datetime.now().isoformat(timespec="seconds")
    total = Counter()

    if args.backfill_days > 0:
        df = load_ohlcv(con, args.backfill_days)
        if len(df) == 0:
            print("[mover] stock_ohlcv empty; nothing to backfill")
            con.close()
            return
        dates = sorted(df["date"].astype(str).unique())[-int(args.backfill_days):]
        rows = [r for r in compute_rows_for_dates(df, set(dates))
                if not wanted or r[0] in wanted]
        total["calc(backfill)"] = persist(con, rows, None)
    else:
        trade_date = resolve_trade_date(con)
        if args.intraday:
            hhmm = datetime.datetime.now().strftime("%H%M")
            try:
                session = cffi_requests.Session(impersonate="chrome")
                rows = fetch_nt_live_screener(session, _nt_bearer_token(), hhmm)
                # direct call bypasses fetch_live's uniform date-append
                total[f"live@{hhmm}"] = persist(
                    con, [r + (trade_date,) for r in rows], now_iso)
            except Exception as e:
                print(f"[live] intraday slot capture failed: {e}")
            con.close()
            print(f"[mover] done: {dict(total)} rows persisted to mover_snapshots")
            return
        calc_wanted = bool(wanted and (wanted & set(CALC_SOURCES)))
        # Prefix-aware: LIVE_SOURCES holds both exact names ("mojo_gainers") and
        # family prefixes ("nteod_"), so --sources nteod_gap_up must match the latter.
        live_wanted = (not wanted) or any(
            w.startswith(src) or src.startswith(w)
            for w in wanted for src in LIVE_SOURCES)
        if not wanted or calc_wanted:
            try:
                df = load_ohlcv(con, 90)
                rows = [r for r in compute_rows_for_dates(df, {trade_date})
                        if not wanted or r[0] in wanted]
                total["calc(today)"] = persist(con, rows, now_iso)
            except Exception as e:
                print(f"[calc] today's classes failed: {e}")
        if live_wanted:
            try:
                total["live"] = persist(con, fetch_live(trade_date, wanted), now_iso)
            except Exception as e:
                print(f"[live] capture failed: {e}")

    con.close()
    print(f"[mover] done: {dict(total)} rows persisted to mover_snapshots")


if __name__ == "__main__":
    main()




