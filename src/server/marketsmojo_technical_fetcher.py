#!/usr/bin/env python3
"""
MarketsMojo technical_card historical fetcher.

getCardInfo returns a full dated series (not the single current value the already-integrated
marketsmojo_header_info/getCardInfo techScore card use) for weekly/monthly-period MACD, RSI,
Bollinger Bands, KST, moving averages, Dow-trend, OBV, and the composite IndiGraph score --
confirmed live 2026-08-11: 742 daily-dated rows, ~3 years back, unauthenticated. Nothing else
on the platform stores historical values for these indicators; technical_signals/unified_signals
only ever hold the latest computed signal, overwritten each run.

cardlist accepts a comma-separated list and returns every requested card's full series in one
response, so one HTTP call per stock covers all indicator/period combinations.

symbol resolution: stockid is read from scripts/stocklist.json (same file/pattern
et_stats_client.py uses for companyid) -- never hardcoded, per .claude/rules/data-sources.md.
"""

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect  # noqa: E402

BASE_URL = "https://www.marketsmojo.com/technical_card/getCardInfo"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Referer": "https://www.marketsmojo.com/",
}
RATE_LIMIT_SEC = 0.5

CARDS = [
    "sectIndigraph_graph",
    "sectMacd_macd_w", "sectMacd_macd_m",
    "sectRsi_rsi_w", "sectRsi_rsi_m",
    "sectBb_bb_w", "sectBb_bb_m",
    "sectKst_kst_w", "sectKst_kst_m",
    "sectMa_ma_w", "sectMa_ma_m",
    "sectDow_dow_w", "sectDow_dow_m",
    "sectObv_obv_w", "sectObv_obv_m",
]
_COMMON_KEYS = {"date", "price", "grade", "flag"}

_STOCKLIST_PATH = Path(__file__).resolve().parents[2] / "scripts" / "stocklist.json"
_symbol_to_sid: dict[str, str] | None = None


def load_sid_map() -> dict[str, str]:
    """symbol (uppercase) -> stockid, loaded once from scripts/stocklist.json."""
    global _symbol_to_sid
    if _symbol_to_sid is not None:
        return _symbol_to_sid
    with open(_STOCKLIST_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    _symbol_to_sid = {
        row["symbol"].upper(): str(row["stockid"])
        for row in rows
        if row.get("symbol") and row.get("stockid")
    }
    return _symbol_to_sid


def _indicator_period(card_key: str) -> tuple[str, str]:
    """'sectMacd_macd_w' -> ('macd', 'w'); 'sectIndigraph_graph' -> ('indigraph', 'd')."""
    if card_key == "sectIndigraph_graph":
        return "indigraph", "d"
    body = card_key[len("sect"):]
    name, period = body.rsplit("_", 1)
    return name.split("_", 1)[0].lower(), period


def fetch_technical_history(sid: str, session: requests.Session, exchange: str = "nse") -> dict | None:
    """One HTTP call -> {(indicator, period): [row, ...]}. Returns None on failure/empty."""
    try:
        r = session.get(
            BASE_URL,
            params={"sid": sid, "se": exchange, "cardlist": ",".join(CARDS)},
            timeout=20,
        )
        if r.status_code != 200:
            print(f"  [marketsmojo technical] sid={sid} HTTP {r.status_code}")
            return None
        payload = r.json()
        if payload.get("code") != 200:
            print(f"  [marketsmojo technical] sid={sid} code={payload.get('code')}")
            return None
        data = payload.get("data", {})
    except Exception as e:
        print(f"  [marketsmojo technical] sid={sid} error: {e}")
        return None
    finally:
        time.sleep(RATE_LIMIT_SEC)

    out: dict[tuple[str, str], list] = {}
    for card_key in CARDS:
        card = data.get(card_key)
        if card is None:
            continue
        rows = card.get("stock", card) if isinstance(card, dict) else card
        if not isinstance(rows, list) or not rows:
            continue
        out[_indicator_period(card_key)] = rows
    return out or None


def write_technical_history(conn, symbol: str, series: dict, fetched_at: str) -> int:
    """series: {(indicator, period): [row, ...]}. Upserts one row per
    (symbol, indicator, period, date). Returns rows written."""
    written = 0
    for (indicator, period), rows in series.items():
        for row in rows:
            row_date = row.get("date")
            if not row_date:
                continue
            details = {k: v for k, v in row.items() if k not in _COMMON_KEYS}
            conn.execute(
                """
                INSERT INTO marketsmojo_technical_history
                    (symbol, indicator, period, date, price, grade, flag, details, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, indicator, period, date) DO UPDATE SET
                    price      = excluded.price,
                    grade      = excluded.grade,
                    flag       = excluded.flag,
                    details    = excluded.details,
                    fetched_at = excluded.fetched_at
                """,
                (
                    symbol, indicator, period, row_date,
                    row.get("price"), row.get("grade"), row.get("flag"),
                    json.dumps(details), fetched_at,
                ),
            )
            written += 1
    conn.commit()
    return written


def run(symbols: list[str] | None = None) -> None:
    sid_map = load_sid_map()
    symbols = [s.upper() for s in symbols] if symbols else sorted(sid_map.keys())
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    fetched_at = date.today().isoformat()

    total_rows = 0
    ok = 0
    for symbol in symbols:
        sid = sid_map.get(symbol)
        if not sid:
            print(f"  [marketsmojo technical] {symbol}: no stockid mapping, skipped")
            continue
        series = fetch_technical_history(sid, session)
        if not series:
            print(f"  [marketsmojo technical] {symbol}: empty response")
            continue
        n = write_technical_history(conn, symbol, series, fetched_at)
        total_rows += n
        ok += 1
        print(f"  [marketsmojo technical] {symbol}: {n} rows across {len(series)} series")

    conn.close()
    print(f"[marketsmojo technical] done -- {total_rows} rows, {ok}/{len(symbols)} symbols succeeded")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", help="restrict to these NSE symbols (default: full universe)")
    args = parser.parse_args()
    run(args.symbols)
