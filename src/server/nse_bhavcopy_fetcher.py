#!/usr/bin/env python3
"""
NSE bhavcopy fetcher -- the point-in-time traded universe.

WHY THIS EXISTS
---------------
Every price-history path in this codebase iterates `SELECT symbol FROM nse_stocks` -- the
*current* master -- and pulls history for each. So anything delisted, merged or suspended
before today was never fetched: 2,436 of the 2,450 symbols in 5.5 years of stock_ohlcv are
still trading, and exactly ONE stopped more than 12 months ago. That is a universe
pre-selected on "survived to 2026", and it inflates every backtest run against it.

The NSE full security-wise bhavcopy is the fix. Each file is the exchange's own record of
what actually traded on that day, so a name that vanished in 2022 is present in 2022's file
and absent from 2023's -- exactly the point-in-time universe a survivorship-free backtest
needs. Verified live: this endpoint serves a consistent schema from 2021-01-04 to today.
(The newer UDiFF `BhavCopy_NSE_CM_*` files only go back to ~2024-04 and 404 before that, so
they are NOT used here.)

It also carries DELIV_QTY / DELIV_PER, so delivery data comes free from the official source
rather than being scraped.

Run:
  python nse_bhavcopy_fetcher.py --date 2026-07-29         # one day
  python nse_bhavcopy_fetcher.py --backfill --start 2021-01-01 --end 2026-07-31
  python nse_bhavcopy_fetcher.py --backfill --monthly      # month-end snapshots only (fast)
  python nse_bhavcopy_fetcher.py --survivorship-report
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class NseBhavcopyFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class NseBhavcopyFetcherBaseFetcher(BaseFetcher[NseBhavcopyFetcherSchema]):
    fetcher_name = 'NseBhavcopyFetcher'
    domain = 'nseindia.com'
    schema = NseBhavcopyFetcherSchema
    min_interval_sec = 0.5

import argparse
import csv
import datetime
import io
import sys

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get

BHAV_URL = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{ddmmyyyy}.csv"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://www.nseindia.com/",
    "Accept": "text/csv,*/*",
}
# Only real equity series. EQ = rolling settlement, BE = trade-to-trade, BZ = surveillance
# T2T, SM/ST = SME. Excludes GS (gilts), GB (sovereign gold bonds), debentures, ETFs' odd
# series -- none of which belong in an equity cross-section.
EQUITY_SERIES = {"EQ", "BE", "BZ", "SM", "ST"}


def _log(m):
    print(f"[Bhavcopy] {m}", flush=True)


def bhav_url(d: datetime.date) -> str:
    return BHAV_URL.format(ddmmyyyy=d.strftime("%d%m%Y"))


def parse_bhavcopy(text: str, equity_only: bool = True) -> list:
    """Parse a sec_bhavdata_full CSV into dicts. This is the ONLY parser -- tests must call
    it rather than reimplementing, or a test can pass while the real path is broken."""
    rows = []
    reader = csv.DictReader(io.StringIO(text))
    for raw in reader:
        # NSE pads its headers and values with spaces: ' SERIES', ' EQ'
        r = {(k or '').strip(): (v or '').strip() for k, v in raw.items()}
        sym = r.get('SYMBOL', '')
        series = r.get('SERIES', '')
        if not sym or not series:
            continue
        if equity_only and series not in EQUITY_SERIES:
            continue
        try:
            d = datetime.datetime.strptime(r['DATE1'], '%d-%b-%Y').date()
        except (KeyError, ValueError):
            continue

        def num(key):
            v = r.get(key, '')
            if v in ('', '-', 'NA'):
                return None
            try:
                return float(v)
            except ValueError:
                return None

        close = num('CLOSE_PRICE')
        if close is None or close <= 0:
            continue
        rows.append({
            'date': d.isoformat(),
            'symbol': sym,
            'series': series,
            'prev_close': num('PREV_CLOSE'),
            'open': num('OPEN_PRICE'),
            'high': num('HIGH_PRICE'),
            'low': num('LOW_PRICE'),
            'close': close,
            'avg_price': num('AVG_PRICE'),
            'volume': num('TTL_TRD_QNTY'),
            'turnover_lacs': num('TURNOVER_LACS'),
            'num_trades': num('NO_OF_TRADES'),
            'deliv_qty': num('DELIV_QTY'),
            'deliv_pct': num('DELIV_PER'),
        })
    return rows


def fetch_bhavcopy(d: datetime.date) -> list:
    """Fetch + parse one day. Returns [] on a non-trading day.

    retry_get calls raise_for_status(), so NSE's 404 for a weekend/holiday arrives as an
    exception rather than a response -- that is an expected outcome here, not a failure, and
    must not be retried into a stack trace.
    """
    try:
        resp = retry_get(requests, bhav_url(d), headers=HEADERS, timeout=30)
    except Exception as e:
        status = getattr(getattr(e, 'response', None), 'status_code', None)
        if status == 404:
            return []
        raise
    return parse_bhavcopy(resp.text)


# How many sessions back the scheduled (no --date) run may walk when today's file 404s.
# NSE publishes the full bhavcopy CSV in stages and some days very late — a same-evening
# request routinely 404s for hours (measured live 2026-08-26: sec_bhavdata_full_26082026.csv
# still absent at 18:50 IST while the previous day's file served fine). The old behaviour
# treated that as a hard step failure; but the file for date-1 is equally fresh data by
# tomorrow morning, so walking back beats failing. Bounded at 5 sessions (~one week) so a
# genuinely broken pipeline surfaces as a failure again rather than silently re-serving
# ancient rows forever.
BHAV_PUBLICATION_LAG_DAYS = 5


def fetch_latest_bhavcopy(max_lookback: int = BHAV_PUBLICATION_LAG_DAYS, today=None):
    """Fetch the newest available bhavcopy at or before `today`, tolerating NSE's late publishes.

    Returns (rows, requested_date) where rows is [] only if nothing published within
    `max_lookback` calendar days. Each candidate day is probed exactly once — a 404 means
    "this day's file isn't up yet", not "retry harder", so there is no backoff loop here.
    `today` is injectable for tests; defaults to the real clock.
    """
    d = today or datetime.date.today()
    for _ in range(max_lookback + 1):
        rows = fetch_bhavcopy(d)
        if rows:
            # Rows are keyed off each file's own DATE1 column (parse_bhavcopy), so what we
            # store is always the file's true session even if the archive re-served an older
            # one — see run_one's re-serve guard.
            return rows, d
        d -= datetime.timedelta(days=1)
    return [], d


# ── schema ───────────────────────────────────────────────────────────────────

def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nse_universe_history (
            date          TEXT NOT NULL,
            symbol        TEXT NOT NULL,
            series        TEXT,
            prev_close    REAL,
            open          REAL,
            high          REAL,
            low           REAL,
            close         REAL,
            avg_price     REAL,
            volume        REAL,
            turnover_lacs REAL,
            num_trades    REAL,
            deliv_qty     REAL,
            deliv_pct     REAL,
            PRIMARY KEY (date, symbol, series)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nuh_symbol ON nse_universe_history (symbol)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nuh_date ON nse_universe_history (date)")
    conn.commit()


COLS = ['date', 'symbol', 'series', 'prev_close', 'open', 'high', 'low', 'close',
        'avg_price', 'volume', 'turnover_lacs', 'num_trades', 'deliv_qty', 'deliv_pct']


def store_bhavcopy(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    placeholders = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[3:])
    sql = (f"INSERT INTO nse_universe_history ({', '.join(COLS)}) VALUES ({placeholders}) "
           f"ON CONFLICT (date, symbol, series) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


# ── runners ──────────────────────────────────────────────────────────────────

def run_one(conn: ConnWrapper, d: datetime.date) -> int:
    rows = fetch_bhavcopy(d)
    if not rows:
        return 0

    # The archive RE-SERVES the previous session's file for most weekend dates instead of
    # 404ing: requesting Sunday 2024-10-20 returns a byte-identical copy of Friday
    # 2024-10-18's file (verified by md5 across every weekend probed). Only three genuine
    # weekend sessions exist in this whole history -- Diwali Muhurat 2023-11-12 and the
    # Budget sessions of 2025-02-01 and 2026-02-01.
    #
    # This is not corrupting, because parse_bhavcopy keys every row off the file's own DATE1
    # rather than the requested date, so a re-serve just upserts rows that already exist. But
    # without this check the log would claim a session happened on a day the market was shut,
    # which is exactly the kind of quietly-wrong signal that makes a later audit distrust the
    # table. Report it instead.
    file_dates = {r['date'] for r in rows}
    if file_dates and d.isoformat() not in file_dates:
        _log(f"{d}: archive served {sorted(file_dates)[0]}'s file (no session on this date) "
             f"-- rows upserted under their own date, nothing invented")
        store_bhavcopy(conn, rows)
        return 0

    n = store_bhavcopy(conn, rows)
    _log(f"{d}: {n} equity securities stored")
    return n


def month_ends(start: datetime.date, end: datetime.date):
    d = start
    while d <= end:
        nxt = (d.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
        last = nxt - datetime.timedelta(days=1)
        # walk back to a weekday; a holiday just 404s and is skipped
        while last.weekday() >= 5:
            last -= datetime.timedelta(days=1)
        if last <= end:
            yield last
        d = nxt


def backfill(conn: ConnWrapper, start: str, end: str, monthly: bool) -> None:
    ensure_schema(conn)
    s = datetime.date.fromisoformat(start)
    e = datetime.date.fromisoformat(end)
    dates = list(month_ends(s, e)) if monthly else [
        s + datetime.timedelta(days=i) for i in range((e - s).days + 1)]
    # Do NOT filter out weekends. NSE runs live special sessions on weekends -- the Union
    # Budget session on Sunday 2026-02-01 is a real one, 2,955 securities, and the weekday
    # filter that used to live here meant it was never fetched: nse_universe_history was
    # simply missing an entire trading day. That is invisible in every row-count and
    # freshness check, and it silently corrupts anything comparing consecutive sessions
    # (it was found via ohlcv_adjust.py, where hundreds of symbols showed a bogus
    # prev_close/close discontinuity on the following Monday).
    # The archive is authoritative about whether a session happened: a non-trading day 404s
    # (verified: Saturday 2026-01-31 -> 404) and fetch_bhavcopy already treats that as "no
    # session", so probing every calendar day is correct and costs only the 404s.
    _log(f"backfilling {len(dates)} dates ({'month-end' if monthly else 'daily'}) "
         f"{start}..{end}")
    total = ok = 0
    for i, d in enumerate(dates, 1):
        try:
            n = run_one(conn, d)
        except Exception as ex:
            _log(f"{d}: FAILED {ex}")
            continue
        if n:
            ok += 1
            total += n
        if i % 25 == 0:
            _log(f"  progress {i}/{len(dates)} — {ok} trading days, {total} rows")
    _log(f"backfill done: {ok} trading days, {total} rows")


def survivorship_report(conn: ConnWrapper) -> None:
    """Quantify what the current nse_stocks-driven universe is missing."""
    ensure_schema(conn)
    row = conn.execute(
        "SELECT count(DISTINCT symbol), count(DISTINCT date), min(date), max(date) "
        "FROM nse_universe_history").fetchone()
    if not row or not row[0]:
        _log("nse_universe_history is empty -- run --backfill first")
        return
    _log(f"universe history: {row[0]} distinct symbols over {row[1]} days ({row[2]}..{row[3]})")

    missing = conn.execute("""
        SELECT count(DISTINCT u.symbol) FROM nse_universe_history u
        WHERE NOT EXISTS (SELECT 1 FROM nse_stocks n WHERE n.symbol = u.symbol)
    """).fetchone()[0]
    _log(f"symbols that traded but are ABSENT from the nse_stocks master: {missing}")

    no_price = conn.execute("""
        SELECT count(DISTINCT u.symbol) FROM nse_universe_history u
        WHERE NOT EXISTS (SELECT 1 FROM stock_ohlcv o WHERE o.symbol = u.symbol)
    """).fetchone()[0]
    _log(f"symbols that traded but have NO stock_ohlcv history at all: {no_price}")

    dead = conn.execute("""
        SELECT u.symbol, max(u.date) last_seen
        FROM nse_universe_history u
        GROUP BY u.symbol
        HAVING max(u.date) < ?
        ORDER BY 2 DESC LIMIT 15
    """, ((datetime.date.today() - datetime.timedelta(days=120)).isoformat(),)).fetchall()
    _log(f"sample of securities that stopped trading (survivorship casualties): "
         f"{[(s, str(d)[:10]) for s, d in dead[:10]]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date')
    ap.add_argument('--backfill', action='store_true')
    ap.add_argument('--monthly', action='store_true')
    ap.add_argument('--start', default='2021-01-01')
    ap.add_argument('--end', default=datetime.date.today().isoformat())
    ap.add_argument('--survivorship-report', action='store_true')
    a = ap.parse_args()

    conn = connect()
    try:
        if a.survivorship_report:
            survivorship_report(conn)
        elif a.backfill:
            backfill(conn, a.start, a.end, a.monthly)
        else:
            ensure_schema(conn)
            if a.date:
                d = datetime.date.fromisoformat(a.date)
                n = run_one(conn, d)
            else:
                # Scheduled path (BullMQ cron/catchup, no --date): tolerate NSE's staged/late
                # publication by walking back to the newest PUBLISHED file. The 2026-08-09
                # weekend incident below is the same class of problem — 'today' resolving to
                # something with no file must not fail the ml-daily-ops step when the data
                # itself is fine one session earlier. run_one still keys rows off each file's
                # own DATE1 and refuses to count a re-served file as the requested date's
                # session, so walking back cannot double-count or invent rows.
                rows, requested = fetch_latest_bhavcopy()
                if rows:
                    _log(f"latest published file: requested {requested}, "
                         f"{len(rows)} equity securities parsed")
                    n = store_bhavcopy(conn, rows)
                    file_dates = {r['date'] for r in rows}
                    if requested.isoformat() not in file_dates:
                        _log(f"{requested}: archive served {sorted(file_dates)[0]}'s file "
                             f"(no session on this date) -- upserted under their own date")
                else:
                    n = 0
                    d = datetime.date.today()
                    _log(f"no bhavcopy published in the last "
                         f"{BHAV_PUBLICATION_LAG_DAYS} days -- upstream outage likely")
            if not n:
                if d.weekday() >= 5:
                    # Sat/Sun structurally never has a bhavcopy -- this fires routinely from
                    # a BullMQ catchup replay (server restart) resolving 'today' to a weekend,
                    # since the script defaults --date to today with no trading-calendar
                    # awareness. Not an error: exit 0 so it doesn't fail the ml-daily-ops step
                    # and cascade into a false "late"/"failed" job-health alert.
                    _log(f"{d}: weekend, no bhavcopy expected")
                else:
                    _log(f"{d}: no data (holiday/weekend or not yet published)")
                    sys.exit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
