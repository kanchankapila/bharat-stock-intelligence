"""MoneyControl pre-market global board (`mcapi/v1/premarket/get-global-marketdata`): GIFT Nifty
and the overnight Asian/US futures quotes, forward-collected.

GIFT Nifty is the one thing here FRED cannot give. It trades ~21 hours, so before the NSE open
it IS the market's own estimate of where NIFTY will start — the overnight information FRED's
dated closes only imply. Everything on this board that FRED already carries (US indices, VIX,
10y yields, the dollar, Brent) is deliberately NOT stored: FRED is the vintage-dated source and
two writers for one fact is how provenance gets confused.

**This endpoint is a SNAPSHOT — it has no history and no observation date of its own.** `ltp` is
whatever the quote is at the moment of the call, so `knowable_at` is the fetch time and nothing
else; `updatedDate` is the vendor's display string and is never used as the observation date.
A run therefore records the quote as of when it ran, and the series only starts when collection
starts. Rows are keyed by the run's IST date, so re-running within a day refreshes that day's
quote rather than inventing a second observation.

Payload shape from the 2026-07-31 probe (`bharat_alpha/tests/fixtures/payload_probe.json`):
`{"success": 1, "data": [{"name": "GIFT Nifty", "ltp": "24,458.50", "chg": "10.50",
"chgper": "0.04", "market_state": "open", ...}, ...]}` — `ltp` carries thousands separators.
"""
from __future__ import annotations

import datetime as dt

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.timeutil import IST, ist_now

URL = "https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata"
SOURCE = "mc_global"
SERIES = "GIFT_NIFTY"
WANTED = "gift nifty"
HEADERS = {"Referer": "https://www.moneycontrol.com/", "Accept": "application/json, text/plain, */*"}


def _num(v) -> float | None:
    """'24,458.50' -> 24458.5. The board sends thousands separators and '-' for no quote."""
    if isinstance(v, (int, float)):
        f = float(v)
        return f if f == f else None
    if not isinstance(v, str):
        return None
    s = v.replace(",", "").strip()
    if not s or s == "-":
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f == f and f > 0 else None


def parse_gift_nifty(payload) -> float | None:
    """The GIFT Nifty level, or None. Any other row on the board is ignored: FRED owns those."""
    if not isinstance(payload, dict) or payload.get("success") != 1:
        return None
    for row in payload.get("data") or []:
        if isinstance(row, dict) and (row.get("name") or "").strip().lower() == WANTED:
            return _num(row.get("ltp"))
    return None


class McGlobal(Connector):
    name = SOURCE
    description = "MoneyControl pre-market board: the GIFT Nifty level, the market's own estimate of the NSE open"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.macro_series", date_column="obs_date", scope_sql=f"series = '{SERIES}'",
                    warn_after_sessions=2, fail_after_sessions=5, fill_rates={"value": 1.0})

    def fetch(self, client: HttpClient, on: dt.date) -> dict:
        resp = client.get(URL, params={"section": "mi"}, headers=HEADERS)
        resp.raise_for_status()
        return resp.json()

    def parse(self, raw: dict, on: dt.date) -> list[dict]:
        level = parse_gift_nifty(raw)
        if level is None:
            return []
        now = ist_now()
        # a snapshot is knowable when it was READ; the run's own IST date keys it
        return [{"series": SERIES, "obs_date": now.astimezone(IST).date(), "value": level,
                 "source": SOURCE, "knowable_at": now}]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        return upsert(conn, "alpha.macro_series", rows, key=("series", "obs_date"),
                      update=("value", "knowable_at", "source"))
