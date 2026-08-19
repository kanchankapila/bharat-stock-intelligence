#!/usr/bin/env python3
"""
MarketsMojo finTrendGraph historical fetcher.

stocks/finTrendGraph returns the HISTORY of the "financial trend" score (0-1, direction,
positive/negative label) -- confirmed live 2026-08-11 against sid=592009 (HDFCBANK): 20
quarterly-cadence points, 2021-10-16 through 2026-07-18 (~5 years), unauthenticated.
Everything else on the platform (marketsmojo_header_info's ext_mojo_financial_pts,
endpoint_registry.py) only ever captures this score's LATEST value, overwritten each run --
this fetcher backfills its history.

cid=34 is a fixed constant across every stock/request (confirmed by testing, not stock- or
sector-derived) -- MarketsMojo's own site-wide "content id" for this card family, not part of
this project's provider-ID scheme.

symbol resolution and headers are shared with marketsmojo_technical_fetcher.py.
"""

import argparse
import sys
import time
from datetime import date
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect  # noqa: E402
from marketsmojo_technical_fetcher import HEADERS, load_sid_map  # noqa: E402

BASE_URL = "https://frapi.marketsmojo.com/stocks/finTrendGraph"
CID = 34
RATE_LIMIT_SEC = 0.5


def fetch_fintrend_history(sid: str, session: requests.Session, exchange: int = 0) -> list[dict] | None:
    """Returns a list of {date, score, fin_trend_dir, fin_txt} dicts, or None on failure/empty."""
    try:
        r = session.post(
            BASE_URL,
            params={"cid": CID},
            json={"stock_id": int(sid), "exchange": exchange, "cid": CID},
            timeout=20,
        )
        if r.status_code != 200:
            print(f"  [marketsmojo fintrend] sid={sid} HTTP {r.status_code}")
            return None
        payload = r.json()
        if str(payload.get("code")) != "200":
            return None
        fin_graph = payload.get("data", {}).get("fin_graph", {})
    except Exception as e:
        print(f"  [marketsmojo fintrend] sid={sid} error: {e}", file=sys.stderr)
        return None
    finally:
        time.sleep(RATE_LIMIT_SEC)

    rows = [v for v in fin_graph.values() if isinstance(v, dict) and v.get("date")]
    return rows or None


def load_known_max_dates(conn) -> dict[str, str]:
    """symbol -> max stored date, as ISO text. Same rationale as marketsmojo_technical_fetcher.py's
    fetcher of the same name (recurring-bugs.md's write-amplification class): the API returns the
    whole series every call with no since-param, so this is what lets a rerun skip the dates it
    already has instead of re-upserting the whole history every time.
    """
    rows = conn.execute(
        "SELECT symbol, MAX(date) FROM marketsmojo_fintrend_history GROUP BY symbol"
    ).fetchall()
    return {
        r[0]: (r[1].isoformat() if hasattr(r[1], "isoformat") else str(r[1]))
        for r in rows if r[1] is not None
    }


def write_fintrend_history(conn, symbol: str, rows: list, fetched_at: str,
                            known: dict[str, str] | None = None) -> int:
    since = (known or {}).get(symbol)
    written = 0
    for row in rows:
        row_date = row.get("date")
        if since and row_date and row_date <= since:  # ISO dates, lexicographic == chronological
            continue
        conn.execute(
            """
            INSERT INTO marketsmojo_fintrend_history
                (symbol, date, score, fin_trend_dir, fin_txt, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                score          = excluded.score,
                fin_trend_dir  = excluded.fin_trend_dir,
                fin_txt        = excluded.fin_txt,
                fetched_at     = excluded.fetched_at
            """,
            (symbol, row_date, row.get("score"), row.get("fin_trend_dir"),
             row.get("fin_txt"), fetched_at),
        )
        written += 1
    conn.commit()
    return written


def run(symbols: list[str] | None = None, full: bool = False) -> None:
    sid_map = load_sid_map()
    symbols = [s.upper() for s in symbols] if symbols else sorted(sid_map.keys())
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    fetched_at = date.today().isoformat()
    known = None if full else load_known_max_dates(conn)
    if known is not None:
        print(f"[marketsmojo fintrend] {len(known)} symbols known -- fetching new dates only")

    total_rows = 0
    ok = 0
    for symbol in symbols:
        sid = sid_map.get(symbol)
        if not sid:
            print(f"  [marketsmojo fintrend] {symbol}: no stockid mapping, skipped")
            continue
        rows = fetch_fintrend_history(sid, session)
        if not rows:
            print(f"  [marketsmojo fintrend] {symbol}: empty response")
            continue
        n = write_fintrend_history(conn, symbol, rows, fetched_at, known)
        total_rows += n
        ok += 1
        print(f"  [marketsmojo fintrend] {symbol}: {n} rows")

    conn.close()
    print(f"[marketsmojo fintrend] done -- {total_rows} rows, {ok}/{len(symbols)} symbols succeeded")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", help="restrict to these NSE symbols (default: full universe)")
    parser.add_argument("--full", action="store_true", help="force a complete re-upsert (backfill/vendor restatement)")
    args = parser.parse_args()
    run(args.symbols, full=args.full)
