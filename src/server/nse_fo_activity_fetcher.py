#!/usr/bin/env python3
"""NSE F&O activity: most-active contracts and OI spurts, the exchange's own screens (AF-20261120-01).

Replaces trendlyne_fno_activity_fetcher.py (smartoptions.trendlyne.com, refused with HTTP 405 every night
since 2026-11-18). Sources, probed 2026-11-20 through the shared NSE session (browser UA + homepage cookie):
  * /api/snapshot-derivatives-equity?index=contracts&limit=20 -> {volume:{data,timestamp}, value:{...}}:
    the 20 most active contracts by contracts traded and by turnover.
  * /api/live-analysis-oi-spurts-contracts -> data: four groups of 25 contracts by OI and price direction:
    Rise-in-OI-Rise (long build-up), Rise-in-OI-Slide (short build-up), Slide-in-OI-Rise (short
    covering), Slide-in-OI-Slide (long unwinding).
  * /api/live-analysis-oi-spurts-underlyings -> data: every F&O underlying (224 on 2026-11-19) with
    latest/previous OI, OI change, volume and futures/options value.

These are live screens: the payload's own timestamp names the session ('19-Nov-2026 15:40:18'). Rows are
dated by that timestamp, never the clock, and a snapshot taken before 15:30 IST (a run during the session)
is refused rather than stored as the day's close. ml-daily-ops runs this after the close.

    python nse_fo_activity_fetcher.py
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from collections import Counter

from db_compat import connect, executemany_batched
from nse_filings_common import BudgetExhausted, NseBlocked, NseClient, NseFetchError

PREFIX = "[NSE-FO-ACTIVITY]"
API = "https://www.nseindia.com/api/"
SNAPSHOT_URL = API + "snapshot-derivatives-equity?index=contracts&limit=20"
SPURTS_CONTRACTS_URL = API + "live-analysis-oi-spurts-contracts"
SPURTS_UNDERLYINGS_URL = API + "live-analysis-oi-spurts-underlyings"
CONTRACTS_TABLE = "nse_fo_activity_contracts"
UNDERLYINGS_TABLE = "nse_fo_oi_spurts_underlyings"
CLOSE = dt.time(15, 30)
SPURT_SCREENS = {
    "Rise-in-OI-Rise": "long_buildup",
    "Rise-in-OI-Slide": "short_buildup",
    "Slide-in-OI-Rise": "short_covering",
    "Slide-in-OI-Slide": "long_unwinding",
}
CONTRACT_COLS = ("trade_date", "screen", "rank", "identifier", "symbol", "instrument_type", "expiry", "option_type",
                 "strike", "ltp", "pchange", "contracts", "turnover", "premium_turnover", "open_interest",
                 "prev_oi", "change_in_oi", "pchange_in_oi", "underlying_value")
UNDERLYING_COLS = ("trade_date", "symbol", "latest_oi", "prev_oi", "change_in_oi", "avg_in_oi", "volume",
                   "fut_value", "opt_value", "total_value", "prem_value", "underlying_value")


def ensure_schema(conn) -> None:
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {CONTRACTS_TABLE} (
            trade_date DATE NOT NULL, screen TEXT NOT NULL, rank INTEGER NOT NULL, identifier TEXT NOT NULL,
            symbol TEXT NOT NULL, instrument_type TEXT, expiry DATE, option_type TEXT, strike DOUBLE PRECISION,
            ltp DOUBLE PRECISION, pchange DOUBLE PRECISION, contracts DOUBLE PRECISION, turnover DOUBLE PRECISION,
            premium_turnover DOUBLE PRECISION, open_interest DOUBLE PRECISION, prev_oi DOUBLE PRECISION,
            change_in_oi DOUBLE PRECISION, pchange_in_oi DOUBLE PRECISION, underlying_value DOUBLE PRECISION,
            snapshot_at TIMESTAMPTZ NOT NULL, source TEXT NOT NULL DEFAULT 'nse_api',
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (trade_date, screen, identifier)
        )""")
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {UNDERLYINGS_TABLE} (
            trade_date DATE NOT NULL, symbol TEXT NOT NULL, latest_oi DOUBLE PRECISION, prev_oi DOUBLE PRECISION,
            change_in_oi DOUBLE PRECISION, avg_in_oi DOUBLE PRECISION, volume DOUBLE PRECISION,
            fut_value DOUBLE PRECISION, opt_value DOUBLE PRECISION, total_value DOUBLE PRECISION,
            prem_value DOUBLE PRECISION, underlying_value DOUBLE PRECISION,
            snapshot_at TIMESTAMPTZ NOT NULL, source TEXT NOT NULL DEFAULT 'nse_api',
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (trade_date, symbol)
        )""")
    conn.commit()


def _num(v):
    try:
        f = float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def session_stamp(ts: str | None, what: str) -> dt.datetime:
    """'19-Nov-2026 15:40:18' -> the closing snapshot's time; raises for a missing or in-session stamp."""
    if not ts:
        raise NseFetchError(f"{what}: payload has no timestamp")
    stamp = dt.datetime.strptime(ts.strip(), "%d-%b-%Y %H:%M:%S" if ts.count(":") == 2 else "%d-%b-%Y %H:%M")
    if stamp.time() < CLOSE:
        raise NseFetchError(f"{what}: snapshot {ts} is from inside the session, not its close")
    return stamp


def _expiry(v):
    try:
        return dt.datetime.strptime(str(v).strip(), "%d-%b-%Y").date()
    except ValueError:
        return None


def _contract(screen: str, rank: int, r: dict, stamp: dt.datetime) -> dict:
    opt = (r.get("optionType") or "").strip()
    return {
        "trade_date": stamp.date(), "screen": screen, "rank": rank, "identifier": r["identifier"],
        "symbol": (r.get("underlying") or r.get("symbol") or "").strip().upper(),
        "instrument_type": r.get("instrumentType"), "expiry": _expiry(r.get("expiryDate")),
        "option_type": opt if opt and opt != "-" else None, "strike": _num(r.get("strikePrice")) or None,
        "ltp": _num(r.get("lastPrice", r.get("ltp"))), "pchange": _num(r.get("pChange")),
        "contracts": _num(r.get("numberOfContractsTraded", r.get("volume"))),
        "turnover": _num(r.get("totalTurnover", r.get("turnover"))),
        "premium_turnover": _num(r.get("premiumTurnover", r.get("premTurnover"))),
        "open_interest": _num(r.get("openInterest", r.get("latestOI"))), "prev_oi": _num(r.get("prevOI")),
        "change_in_oi": _num(r.get("changeInOI")), "pchange_in_oi": _num(r.get("pChangeInOI")),
        "underlying_value": _num(r.get("underlyingValue")), "snapshot_at": stamp,
    }


def parse_snapshot(payload: dict) -> list[dict]:
    rows = []
    for section, screen in (("volume", "most_active_volume"), ("value", "most_active_value")):
        part = payload.get(section) or {}
        stamp = session_stamp(part.get("timestamp"), f"snapshot {section}")
        data = part.get("data") or []
        if not data:
            raise NseFetchError(f"snapshot {section}: no rows")
        rows += [_contract(screen, i + 1, r, stamp) for i, r in enumerate(data)]
    return rows


def parse_spurts_contracts(payload: dict) -> list[dict]:
    stamp = session_stamp(payload.get("timestamp"), "oi spurts contracts")
    rows = []
    for group in payload.get("data") or []:
        for name, items in group.items():
            screen = SPURT_SCREENS.get(name)
            if screen is None:
                raise NseFetchError(f"oi spurts contracts: unknown group {name!r}")
            rows += [_contract(screen, i + 1, r, stamp) for i, r in enumerate(items)]
    if {r["screen"] for r in rows} != set(SPURT_SCREENS.values()):
        raise NseFetchError(f"oi spurts contracts: groups {sorted({r['screen'] for r in rows})}")
    return rows


def parse_spurts_underlyings(payload: dict) -> list[dict]:
    stamp = session_stamp(payload.get("timestamp"), "oi spurts underlyings")
    data = payload.get("data") or []
    if not data:
        raise NseFetchError("oi spurts underlyings: no rows")
    return [{
        "trade_date": stamp.date(), "symbol": r["symbol"].strip().upper(), "latest_oi": _num(r.get("latestOI")),
        "prev_oi": _num(r.get("prevOI")), "change_in_oi": _num(r.get("changeInOI")), "avg_in_oi": _num(r.get("avgInOI")),
        "volume": _num(r.get("volume")), "fut_value": _num(r.get("futValue")), "opt_value": _num(r.get("optValue")),
        "total_value": _num(r.get("total")), "prem_value": _num(r.get("premValue")),
        "underlying_value": _num(r.get("underlyingValue")), "snapshot_at": stamp,
    } for r in data]


def replace_day(conn, table: str, cols: tuple, key_screens: set | None, rows: list[dict]) -> int:
    """Replace one session's rows (per screen for contracts) so a contract that left a screen is not kept."""
    day = rows[0]["trade_date"].isoformat()
    if key_screens is None:
        conn.execute(f"DELETE FROM {table} WHERE trade_date = ?", (day,))
    else:
        for s in key_screens:
            conn.execute(f"DELETE FROM {table} WHERE trade_date = ? AND screen = ?", (day, s))
    all_cols = cols + ("snapshot_at",)
    executemany_batched(conn, f"INSERT INTO {table} ({', '.join(all_cols)}) VALUES ({', '.join('?' for _ in all_cols)})",
                        [tuple(r[c] for c in all_cols) for r in rows])
    conn.commit()
    return len(rows)


def run(conn, client: NseClient) -> dict:
    snap = parse_snapshot(client.get_json(SNAPSHOT_URL))
    spurts = parse_spurts_contracts(client.get_json(SPURTS_CONTRACTS_URL))
    under = parse_spurts_underlyings(client.get_json(SPURTS_UNDERLYINGS_URL))
    contracts = snap + spurts
    days = {r["trade_date"] for r in contracts} | {r["trade_date"] for r in under}
    if len(days) != 1:
        raise NseFetchError(f"screens name different sessions: {sorted(days)}")
    return {
        "trade_date": contracts[0]["trade_date"].isoformat(),
        "contracts": replace_day(conn, CONTRACTS_TABLE, CONTRACT_COLS, {r["screen"] for r in contracts}, contracts),
        "underlyings": replace_day(conn, UNDERLYINGS_TABLE, UNDERLYING_COLS, None, under),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--min-interval", type=float, default=1.5)
    args = ap.parse_args(argv)
    conn = connect()
    ensure_schema(conn)
    client = NseClient(6, args.min_interval, log_prefix=PREFIX)
    try:
        stats = run(conn, client)
    except (BudgetExhausted, NseBlocked, NseFetchError) as exc:
        print(f"{PREFIX} stopped: {exc}", file=sys.stderr)
        return 2
    finally:
        conn.close()
    print(f"{PREFIX} done: {stats} statuses={dict(Counter(client.status_counts))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
