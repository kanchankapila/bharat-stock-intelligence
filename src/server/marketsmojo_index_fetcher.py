#!/usr/bin/env python3
"""
MarketsMojo index historical-price fetcher.

apiv1/markets/indices/{id}/details?period=10Y -- confirmed live 2026-08-11: 2,474 days
(~10 years, back to 2016-08-16) for index_id=1 (SENSEX), unauthenticated. Strictly better than
market_marketoverview/getGraphData (this project's first attempt at this table): that endpoint
topped out at 3 years and returned empty for every global benchmark; this one reaches 10 years
for domestic indices AND has real data for a dozen global benchmarks getGraphData couldn't touch
at all (S&P 500, NASDAQ 100, Nikkei 225, Hang Seng, FTSE 100, DAX, CAC 40, Shanghai Composite,
S&P/TSX 60, Abu Dhabi Securities Exchange -- all confirmed with real chart_data, not just a
resolved name). macro_asset_prices (81 assets, already in this project) covers NIFTY50 and its
options-market derivatives but none of the above.

INDEX_NAMES is the full validated catalog: the user's confirmed "all index ids for marketmojo"
domestic list (67 ids) plus every id from a second, broader list that this project live-tested
one by one and found to actually return non-empty chart_data. Most of that second list's ~65
ids are dead: discontinued/delisted indices (e.g. "ALLIANCE & LEICS", "ALPHA PYRENEES") or ids
this API has never populated, both confirmed via HTTP 200 + `data_points: 0` (not an error, no
data) -- excluded rather than guessed.

ALL_GOV_BOND (507) and ALL_INDEXD_BOND (508) are a special case: real 7-year history (2016 to
2023-09-22) but the series stops there -- discontinued upstream, confirmed by testing period=10Y
directly rather than assuming from a short recent window. Included as one-time historical
archive; their freshness check will always read as stale by design, which is correct, not a bug.

symbol resolution note: index_id is MarketsMojo's own id space, used only by this dedicated
table (no other writer touches it), so it's fine as a bare PK component here -- unlike a
screener/scanner id shared across providers (see .claude/rules/data-sources.md).
"""

import argparse
import sys
import time
from datetime import date, datetime
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect  # noqa: E402
from marketsmojo_technical_fetcher import HEADERS  # noqa: E402

BASE_URL = "https://frapi.marketsmojo.com/apiv1/markets/indices"
RATE_LIMIT_SEC = 0.5
PERIOD = "10Y"

INDEX_NAMES = {
    # Domestic (BSE/NSE) -- the user-confirmed complete 67-id catalog
    1: "SENSEX", 2: "BSE100", 3: "BSE200", 4: "BSE500", 5: "BSE IT", 6: "BSEFMC",
    7: "BSE CG", 8: "BSE CD", 9: "BSE HC", 10: "DOL200", 11: "TECK", 12: "BSEPSU",
    14: "BANKEX", 15: "AUTO", 16: "METAL", 17: "OILGAS", 21: "REALTY", 22: "POWER",
    23: "BSEIPO", 27: "SMEIPO", 35: "BASMTR", 36: "CDGS", 37: "FIN", 40: "INDSTR",
    41: "ENERGY", 42: "TELCOM", 43: "UTILS", 45: "LRGCAP", 61: "SMLSEL", 62: "MIDSEL",
    123: "NIFTY", 124: "NIFTYIT", 125: "NIFTYJR", 127: "BANKNIFTY", 128: "NIFTYMIDCAP",
    129: "NIFTY500", 130: "MIDCAP50", 131: "NIFTY100", 134: "NIFTYFMCG", 136: "NIFTYMNC",
    137: "NIFTYSERVICE", 138: "NIFTYENERGY", 139: "NIFTYPHARMA", 141: "NIFTYINFRAST",
    142: "NIFTYREALTY", 143: "NIFTYPSUBANK", 145: "NIFTYSMALL", 146: "NIFTYPSE",
    147: "NIFTYCONSUMP", 148: "NIFTYAUTO", 149: "NIFTYMETAL", 150: "NIFTY200",
    151: "NIFTYMEDIA", 152: "NIFTYCDTY", 153: "NIFTYFINANCE", 154: "NIFTYDIVOPPT",
    159: "LIQ15", 162: "NIFTYCPSE", 164: "NI15", 166: "NV20", 202: "BHRT22",
    203: "BSEDSI", 204: "BSEEVI", 205: "BSELVI", 206: "BSEMOI", 208: "BSEQUI",
    210: "ESG100", 213: "MID150", 215: "SML250",
    # Global benchmarks -- individually live-validated (non-empty chart_data), not guessed
    501: "S&P 500", 502: "China Shanghai Composite", 503: "Japan Nikkei 225",
    505: "S&P/TSX 60", 506: "Hang Seng Hong Kong", 510: "FTSE 100",
    516: "Germany DAX (TR)", 517: "France CAC 40", 544: "Abu Dhabi Securities Exchange",
    23853: "NASDAQ 100",
    # Discontinued upstream (real history through 2023-09-22, then nothing) -- see docstring
    507: "ALL GOV BOND", 508: "ALL INDEXD BONDS",
}


def fetch_index_history(index_id: int, session: requests.Session, period: str = PERIOD) -> list[dict] | None:
    """Returns a list of {date (datetime.date), price} dicts, or None on failure/empty."""
    try:
        r = session.get(f"{BASE_URL}/{index_id}/details", params={"period": period}, timeout=20)
        if r.status_code != 200:
            print(f"  [marketsmojo index] id={index_id} HTTP {r.status_code}")
            return None
        payload = r.json()
        if str(payload.get("code")) != "200":
            return None
        chart_data = payload.get("data", {}).get("chart_data", [])
    except Exception as e:
        print(f"  [marketsmojo index] id={index_id} error: {e}", file=sys.stderr)
        return None
    finally:
        time.sleep(RATE_LIMIT_SEC)

    out = []
    for point in chart_data:
        raw_date = point.get("dt")
        price = point.get("price")
        if not raw_date or price is None:
            continue
        try:
            d = datetime.strptime(raw_date, "%Y-%m-%d").date()
        except ValueError:
            continue
        out.append({"date": d, "price": price})
    return out or None


def load_known_max_dates(conn) -> dict[int, str]:
    """index_id -> max stored date, as ISO text. Same rationale as marketsmojo_technical_
    fetcher.py's fetcher of the same name (recurring-bugs.md's write-amplification class) --
    applied here too for consistency even though the index universe is small enough that the
    blast radius was never as severe as the per-symbol fetchers.
    """
    rows = conn.execute(
        "SELECT index_id, MAX(date) FROM marketsmojo_index_history GROUP BY index_id"
    ).fetchall()
    return {
        r[0]: (r[1].isoformat() if hasattr(r[1], "isoformat") else str(r[1]))
        for r in rows if r[1] is not None
    }


def write_index_history(conn, index_id: int, name: str, rows: list, fetched_at: str,
                         known: dict[int, str] | None = None) -> int:
    since = (known or {}).get(index_id)
    written = 0
    for row in rows:
        row_date = row["date"].isoformat() if hasattr(row["date"], "isoformat") else str(row["date"])
        if since and row_date <= since:  # ISO dates, lexicographic == chronological
            continue
        conn.execute(
            """
            INSERT INTO marketsmojo_index_history (index_id, name, date, price, fetched_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(index_id, date) DO UPDATE SET
                name       = excluded.name,
                price      = excluded.price,
                fetched_at = excluded.fetched_at
            """,
            (index_id, name, row["date"], row["price"], fetched_at),
        )
        written += 1
    conn.commit()
    return written


def run(index_ids: list[int] | None = None, full: bool = False) -> None:
    ids = index_ids or sorted(INDEX_NAMES.keys())
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    fetched_at = date.today().isoformat()
    known = None if full else load_known_max_dates(conn)
    if known is not None:
        print(f"[marketsmojo index] {len(known)} indices known -- fetching new dates only")

    total_rows = 0
    ok = 0
    for index_id in ids:
        name = INDEX_NAMES.get(index_id)
        if not name:
            print(f"  [marketsmojo index] id={index_id}: no name mapping, skipped")
            continue
        rows = fetch_index_history(index_id, session)
        if not rows:
            print(f"  [marketsmojo index] {name} ({index_id}): empty response")
            continue
        n = write_index_history(conn, index_id, name, rows, fetched_at, known)
        total_rows += n
        ok += 1
        print(f"  [marketsmojo index] {name} ({index_id}): {n} rows")

    conn.close()
    print(f"[marketsmojo index] done -- {total_rows} rows, {ok}/{len(ids)} indices succeeded")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ids", nargs="*", type=int, help="restrict to these index ids (default: full known catalog)")
    parser.add_argument("--full", action="store_true", help="force a complete re-upsert (backfill/vendor restatement)")
    args = parser.parse_args()
    run(args.ids, full=args.full)
