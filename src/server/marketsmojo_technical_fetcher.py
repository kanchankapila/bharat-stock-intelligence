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

import polars as pl
import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect  # noqa: E402
from pydantic import BaseModel, Field
from base_fetcher import BaseFetcher, DomainGovernor

class MarketsMojoPointSchema(BaseModel):
    date: str
    price: float | None = None
    grade: str | None = None
    flag: int | None = None

class MarketsMojoTechnicalFetcher(BaseFetcher[MarketsMojoPointSchema]):
    fetcher_name = "MarketsMojoTechnicalFetcher"
    domain = "marketsmojo.com"
    schema = MarketsMojoPointSchema
    min_interval_sec = 0.5


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
# getCardInfo has no since-parameter: every call returns the stock's whole ~9,900-row series
# regardless. Live-measured 2026-08-12: 2.02s/symbol serial = 61.7 min for 1,831 symbols, which
# is why the 40-min job budget SIGKILLed this fetcher every night after only 214 symbols (12%
# of the universe). 8 workers measured at 6.7s/24 symbols with zero throttling -> ~8.5 min.
MAX_WORKERS = 8
BATCH_GAP_SEC = 0.5

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
        print(f"  [marketsmojo technical] sid={sid} error: {e}", file=sys.stderr)
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


def load_known_max_dates(conn) -> dict[tuple[str, str, str], str]:
    """(symbol, indicator, period) -> max stored date, as ISO text.

    The API cannot be asked for a date range, so the whole series arrives every call; this is
    what lets us discard the ~99.9% of it we already hold instead of re-upserting it. Measured
    2026-08-12 before this existed: 2,010,101 rows written in one night to gain 2,787 genuinely
    new ones -- a 721:1 amplification against a 3.4 GB table, and the reason a single symbol
    cost ~11s of DB time.
    """
    rows = conn.execute(
        "SELECT symbol, indicator, period, MAX(date) "
        "FROM marketsmojo_technical_history GROUP BY symbol, indicator, period"
    ).fetchall()
    # No ::text cast: that is Postgres-only and dies on the SQLite fallback (see
    # .claude/rules/recurring-bugs.md, SQL dialect). Postgres hands back a datetime.date here
    # and SQLite a string, so normalise in Python -- both end up ISO, which is what the
    # lexicographic comparison in write_technical_history() needs.
    return {
        (r[0], r[1], r[2]): (r[3].isoformat() if hasattr(r[3], "isoformat") else str(r[3]))
        for r in rows if r[3] is not None
    }


def write_technical_history(conn, symbol: str, series: dict, fetched_at: str,
                            known: dict[tuple[str, str, str], str] | None = None) -> int:
    """series: {(indicator, period): [row, ...]}. Upserts one row per
    (symbol, indicator, period, date). Returns rows written.

    `known` skips dates already stored. Pass None (or --full) to force a complete re-upsert,
    which is what a backfill or a vendor restatement needs.
    """
    written = 0
    for (indicator, period), rows in series.items():
        since = (known or {}).get((symbol, indicator, period))
        for row in rows:
            row_date = row.get("date")
            if not row_date:
                continue
            # ISO dates, so lexicographic == chronological.
            if since and row_date <= since:
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


def run(symbols: list[str] | None = None, full: bool = False) -> None:
    sid_map = load_sid_map()
    symbols = [s.upper() for s in symbols] if symbols else sorted(sid_map.keys())
    conn = connect()
    fetched_at = date.today().isoformat()
    known = None if full else load_known_max_dates(conn)
    if known is not None:
        print(f"[marketsmojo technical] {len(known)} existing series known -- fetching new dates only")

    def _fetch(symbol: str):
        """Runs on a worker thread: HTTP only. The DB connection stays on the main
        thread -- db_compat connections are not thread-safe."""
        sid = sid_map.get(symbol)
        if not sid:
            return symbol, None
        session = requests.Session()
        session.headers.update(HEADERS)
        return symbol, fetch_technical_history(sid, session)

    total_rows = 0
    ok = 0
    unmapped = 0
    for start in range(0, len(symbols), MAX_WORKERS):
        batch = symbols[start:start + MAX_WORKERS]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            results = list(pool.map(_fetch, batch))
        for symbol, series in results:
            if symbol not in sid_map:
                unmapped += 1
                continue
            if not series:
                print(f"  [marketsmojo technical] {symbol}: empty response")
                continue
            n = write_technical_history(conn, symbol, series, fetched_at, known)
            total_rows += n
            ok += 1
            print(f"  [marketsmojo technical] {symbol}: {n} new rows across {len(series)} series")
        time.sleep(BATCH_GAP_SEC)

    conn.close()
    print(f"[marketsmojo technical] done -- {total_rows} rows written, "
          f"{ok}/{len(symbols)} symbols succeeded ({unmapped} unmapped)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", help="restrict to these NSE symbols (default: full universe)")
    parser.add_argument("--full", action="store_true",
                        help="re-upsert every date instead of only dates newer than what is stored")
    args = parser.parse_args()
    run(args.symbols, full=args.full)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
