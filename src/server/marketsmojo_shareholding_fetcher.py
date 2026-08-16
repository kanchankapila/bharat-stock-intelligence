#!/usr/bin/env python3
"""
MarketsMojo shareholding-pattern historical fetcher.

Stocks_Shareholding/get_results's shareholding_graphs.data holds real per-quarter ownership-
percentage history (Promoter/FII/MF/Insurance/Other-DII/NII holding %, plus Promoter pledged %)
-- confirmed live 2026-08-11 against sid=229993 (Neuland Laboratories): 5 quarters so far
(Jun'25 through Jun'26), unauthenticated, growing every quarter. Everything else this project
tried in this response family (Balance Sheet/Cash Flow/P&L snapshot endpoints) turned out to be
2-3 point comparisons, not a real series, and redundant with the already-scheduled ET_Stats
Balance/CashFlow (5y) besides -- shareholding is the one that's both new AND has real depth.
Fills the gap .claude/rules/measurement.md documents: ownership data is currently untestable
platform-wide (every existing table stuck at ~30 dates since 2026-06-30).

Response shape is inconsistent block-to-block: the Promoter block nests TWO series (holding %,
then pledged %) inside its "data" list; every other block (FII/MF/Insurance/Other-DII/NII) has
"data" as a single flat list of points, not a list of series. _flatten_blocks() below normalizes
both shapes rather than assuming one.

symbol resolution and headers are shared with marketsmojo_technical_fetcher.py.
"""

import argparse
import re
import sys
import time
from calendar import monthrange
from datetime import date

import requests

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from db_compat import connect  # noqa: E402
from marketsmojo_technical_fetcher import HEADERS, load_sid_map  # noqa: E402

BASE_URL = "https://frapi.marketsmojo.com/Stocks_Shareholding/get_results"
RATE_LIMIT_SEC = 0.5

_TITLE_RE = re.compile(r"[^a-z0-9]+")


def _slugify_title(title: str) -> str:
    """'Shareholding - FII Holdings' -> 'fii_holdings'."""
    t = title.replace("Shareholding", "").replace("-", " ").strip().lower()
    return _TITLE_RE.sub("_", t).strip("_")


def _yyyymm_to_date(yyyymm) -> date | None:
    """202506 -> 2025-06-30 (last day of the reporting quarter's month)."""
    try:
        n = int(yyyymm)
        year, month = divmod(n, 100)
        if not (1 <= month <= 12) or year < 1990:
            return None
        return date(year, month, monthrange(year, month)[1])
    except (TypeError, ValueError):
        return None


def _flatten_blocks(blocks: list) -> list[tuple[str, date, float]]:
    """Returns [(category, period_date, value), ...] across every block/series."""
    out = []
    for block in blocks:
        title = block.get("title", "")
        if not title:
            continue
        base_cat = _slugify_title(title)
        data = block.get("data", [])
        if not data:
            continue
        # normalize: a block's data is either a flat list of points (dicts) or a list of
        # series (lists of points) -- treat a flat list as a single one-series list.
        series_list = data if isinstance(data[0], list) else [data]
        for series_idx, series in enumerate(series_list):
            if base_cat == "promoter_holding" and series_idx == 1:
                cat = "promoter_pledged_pct"
            elif series_idx == 0:
                cat = f"{base_cat}_pct"
            else:
                cat = f"{base_cat}_{series_idx}_pct"
            for point in series:
                period_date = _yyyymm_to_date(point.get("name"))
                value = point.get("y")
                if period_date is None or value is None:
                    continue
                out.append((cat, period_date, value))
    return out


def fetch_shareholding_history(sid: str, session: requests.Session, exchange: str = "0") -> list | None:
    """Returns [(category, period_date, value), ...], or None on failure/empty."""
    try:
        r = session.get(BASE_URL, params={"sid": sid, "exchange": exchange}, timeout=20)
        if r.status_code != 200:
            print(f"  [marketsmojo shareholding] sid={sid} HTTP {r.status_code}")
            return None
        payload = r.json()
        if str(payload.get("code")) != "200":
            return None
        blocks = payload.get("data", {}).get("shareholding_graphs", {}).get("data", [])
    except Exception as e:
        print(f"  [marketsmojo shareholding] sid={sid} error: {e}")
        return None
    finally:
        time.sleep(RATE_LIMIT_SEC)

    rows = _flatten_blocks(blocks)
    return rows or None


def load_known_max_dates(conn) -> dict[tuple[str, str], str]:
    """(symbol, category) -> max stored period_date, as ISO text. Same rationale as
    marketsmojo_technical_fetcher.py's fetcher of the same name (recurring-bugs.md's
    write-amplification class): no since-param on this API, so this is what lets a rerun skip
    periods already held instead of re-upserting the whole history every call.
    """
    rows = conn.execute(
        "SELECT symbol, category, MAX(period_date) FROM marketsmojo_shareholding_history "
        "GROUP BY symbol, category"
    ).fetchall()
    return {
        (r[0], r[1]): (r[2].isoformat() if hasattr(r[2], "isoformat") else str(r[2]))
        for r in rows if r[2] is not None
    }


def write_shareholding_history(conn, symbol: str, rows: list, fetched_at: str,
                                known: dict[tuple[str, str], str] | None = None) -> int:
    written = 0
    for category, period_date, value in rows:
        since = (known or {}).get((symbol, category))
        # Both sides coerced to ISO text before comparing. They are NOT the same type:
        # _flatten_blocks yields datetime.date (via _yyyymm_to_date), while
        # load_known_max_dates deliberately returns ISO strings (MAX(period_date) comes back
        # as a date from Postgres and is stringified there). The original
        # `period_date <= since` therefore raised
        #   TypeError: '<=' not supported between instances of 'datetime.date' and 'str'
        # on every symbol that already had stored history -- i.e. the whole incremental path,
        # which is the only path this guard exists for. Caught live in the pm2 logs 2026-08-16.
        # Its own comment ("ISO dates, lexicographic == chronological") was right about the
        # ordering and wrong about the types.
        if since and period_date:
            pd_iso = period_date.isoformat() if hasattr(period_date, "isoformat") else str(period_date)
            if pd_iso <= since:
                continue
        conn.execute(
            """
            INSERT INTO marketsmojo_shareholding_history
                (symbol, category, period_date, value, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(symbol, category, period_date) DO UPDATE SET
                value      = excluded.value,
                fetched_at = excluded.fetched_at
            """,
            (symbol, category, period_date, value, fetched_at),
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
        print(f"[marketsmojo shareholding] {len(known)} (symbol,category) pairs known -- fetching new periods only")

    total_rows = 0
    ok = 0
    for symbol in symbols:
        sid = sid_map.get(symbol)
        if not sid:
            print(f"  [marketsmojo shareholding] {symbol}: no stockid mapping, skipped")
            continue
        rows = fetch_shareholding_history(sid, session)
        if not rows:
            print(f"  [marketsmojo shareholding] {symbol}: empty response")
            continue
        n = write_shareholding_history(conn, symbol, rows, fetched_at, known)
        total_rows += n
        ok += 1
        print(f"  [marketsmojo shareholding] {symbol}: {n} rows")

    conn.close()
    print(f"[marketsmojo shareholding] done -- {total_rows} rows, {ok}/{len(symbols)} symbols succeeded")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", help="restrict to these NSE symbols (default: full universe)")
    parser.add_argument("--full", action="store_true", help="force a complete re-upsert (backfill/vendor restatement)")
    args = parser.parse_args()
    run(args.symbols, full=args.full)
