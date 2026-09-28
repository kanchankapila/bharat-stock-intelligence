"""Global overnight cues from FRED: US equities, US volatility, the 10-year yield, the dollar,
Brent and USD/INR — the largest known drivers of the NSE opening gap.

`fredgraph.csv?id=<SERIES>` needs no API key and returns two columns (the date header has been
both `DATE` and `observation_date`), with `.` for a day without a value. Each series is fetched
whole from `START`; unchanged rows are upserted in place.

Point in time. An observation dated D is the US close of D (16:00 New York), i.e. 01:30-02:30
IST on D+1, so an NSE session uses the PREVIOUS US session — never the same calendar date's,
which had not happened yet when the NSE session traded. These series are market prints, not
revised statistics, so no vintage handling is needed.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
from zoneinfo import ZoneInfo

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import FetchError, HttpClient

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
START = "2015-01-01"
SERIES = {
    "SP500": "S&P 500", "NASDAQCOM": "Nasdaq Composite", "VIXCLS": "CBOE VIX", "DGS10": "US 10y yield",
    "DTWEXBGS": "broad USD index", "DCOILBRENTEU": "Brent", "DEXINUS": "USD/INR (NY noon)",
}
NEW_YORK = ZoneInfo("America/New_York")
US_CLOSE = dt.time(16, 0)


def parse_fred_csv(text: str, series: str) -> list[dict]:
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = [h.strip() for h in next(reader, [])]
    if len(header) < 2 or header[0].lower() not in ("date", "observation_date") or header[1] != series:
        raise ValueError(f"unexpected FRED header for {series}: {header[:3]}")
    out = []
    for row in reader:
        if len(row) < 2 or row[1].strip() in ("", "."):
            continue
        try:
            out.append({"series": series, "obs_date": dt.date.fromisoformat(row[0].strip()), "value": float(row[1])})
        except ValueError:
            continue
    return out


def knowable_at(obs_date: dt.date) -> dt.datetime:
    return dt.datetime.combine(obs_date, US_CLOSE, tzinfo=NEW_YORK)


class FredSeries(Connector):
    name = "fred_macro"
    description = "FRED global daily series: S&P 500, Nasdaq, VIX, US 10y, broad dollar, Brent, USD/INR"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.macro_series", date_column="obs_date", warn_after_sessions=3,
                    fail_after_sessions=7, fill_rates={"value": 1.0})

    def __init__(self, series: tuple[str, ...] = tuple(SERIES), start: str = START):
        self.series, self.start = series, start

    def fetch(self, client: HttpClient, on: dt.date) -> dict[str, str]:
        out = {}
        for s in self.series:
            try:
                r = client.get(URL, params={"id": s, "cosd": self.start})
                if r.ok:
                    out[s] = r.text
            except FetchError:
                continue
        return out

    def parse(self, raw: dict[str, str], on: dt.date) -> list[dict]:
        return [row for s, text in raw.items() for row in parse_fred_csv(text, s)]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        return upsert(conn, "alpha.macro_series",
                      [{**r, "source": self.name, "knowable_at": knowable_at(r["obs_date"])} for r in rows],
                      key=("series", "obs_date"), update=("value",))
