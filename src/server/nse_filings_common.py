"""Shared plumbing for the three NSE corporate-filing backfills (2026-10-09, audit G #2/#6/#7).

nse_results_filings_fetcher.py, nse_pit_fetcher.py and nse_shareholding_master_fetcher.py all hit
www.nseindia.com/api/* with the same session, the same politeness rules and the same
"NSE symbol is canonical, never guess" resolution, so those live here once:

- NseClient: the session from preopen_fetcher._nse_session (curl_cffi Chrome impersonation, homepage
  cookie), >= min_interval between requests, a hard request budget, exponential backoff on
  403/429/5xx, and a STOP after 3 consecutive 403/429 -- never hammer a refusing host.
- SymbolResolver: response row -> NSE symbol via nse_stocks (ISIN singleton first, then exact
  symbol); anything else is counted and logged as unmapped, never guessed.
- parse_* helpers: NSE's display formats -> typed values, None for every "not given" token
  ("-", "Nil", "NA", "") so nothing is fabricated as 0.
"""
from __future__ import annotations

import math
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone

from preopen_fetcher import _nse_session

IST = timezone(timedelta(hours=5, minutes=30))
NSE_API = "https://www.nseindia.com/api"
_MISSING = {"", "-", "--", "NA", "N.A.", "NIL", "NULL", "NONE", "::"}


class NseBlocked(RuntimeError):
    """NSE refused 3 requests in a row (403/429) -- the run must stop, not retry harder."""


class BudgetExhausted(RuntimeError):
    """The --max-requests budget is spent; the run stops cleanly and resumes next time."""


class NseFetchError(RuntimeError):
    """A request failed after retries (5xx/timeout/non-JSON). The caller stops: skipping a
    window would leave a hole that resume-from-MAX can never see again."""


def clean_text(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return None if s.upper() in _MISSING else s


def parse_num(v) -> float | None:
    s = clean_text(v)
    if s is None:
        return None
    try:
        f = float(s.replace(",", ""))
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def parse_date(v) -> date | None:
    """'01-Oct-2021' / '30-JUN-2026' (strptime's %b is case-insensitive)."""
    s = clean_text(v)
    if s is None:
        return None
    try:
        return datetime.strptime(s.split()[0], "%d-%b-%Y").date()
    except ValueError:
        return None


def parse_ts(v) -> datetime | None:
    """'05-Feb-2022 22:37:04' / '05-Feb-2022 22:37' / '21-JUL-2026 15:44:00' -> aware IST datetime.
    A bare date is NOT promoted to midnight: a point-in-time column must not claim a precision the
    source never gave, so a date-only value returns None here (callers keep the date separately)."""
    s = clean_text(v)
    if s is None:
        return None
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=IST)
        except ValueError:
            continue
    return None


def nse_date_param(d: date) -> str:
    return d.strftime("%d-%m-%Y")


def today_ist() -> date:
    return datetime.now(IST).date()


class NseClient:
    def __init__(self, max_requests: int, min_interval: float = 1.5, session_factory=_nse_session,
                 sleep=time.sleep, clock=time.monotonic, max_attempts: int = 4, log_prefix: str = "[NSE]"):
        self.max_requests = max_requests
        self.min_interval = max(1.0, min_interval)
        self._session_factory = session_factory
        self._sleep = sleep
        self._clock = clock
        self.max_attempts = max_attempts
        self.prefix = log_prefix
        self.requests_made = 0
        self.status_counts: Counter = Counter()
        self._consecutive_blocks = 0
        self._last = None
        self._session = None

    def _spend(self) -> None:
        if self.requests_made >= self.max_requests:
            raise BudgetExhausted(f"request budget {self.max_requests} spent")
        if self._last is not None:
            wait = self.min_interval - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)
        self.requests_made += 1
        self._last = self._clock()

    def _ensure_session(self):
        if self._session is None:
            self._spend()  # the homepage warm-up is a request to NSE too
            self._session = self._session_factory()
        return self._session

    def get_json(self, url: str):
        for attempt in range(1, self.max_attempts + 1):
            sess = self._ensure_session()
            self._spend()
            try:
                r = sess.get(url, timeout=25)
                status = r.status_code
            except Exception as exc:  # timeout / connection reset
                status, r = None, None
                print(f"{self.prefix} {url} attempt {attempt}: {exc}", file=sys.stderr)
                self._session = None  # NSE resets an HTTP/2 connection after ~600 requests; retry on a fresh one
            self.status_counts[status] += 1
            if status in (403, 429):
                self._consecutive_blocks += 1
                if self._consecutive_blocks >= 3:
                    raise NseBlocked(f"{self._consecutive_blocks} consecutive 403/429 (last {status} on {url})")
                self._session = None  # expired cookie is the usual 403; re-warm before retrying
            elif status == 200:
                self._consecutive_blocks = 0
                try:
                    return r.json()
                except ValueError:
                    print(f"{self.prefix} {url}: 200 but non-JSON body ({r.text[:120]!r})", file=sys.stderr)
            elif status is not None and status < 500:
                raise NseFetchError(f"HTTP {status} on {url}")
            if attempt < self.max_attempts:
                self._sleep(2.0 * 2 ** (attempt - 1))
        raise NseFetchError(f"no usable response after {self.max_attempts} attempts: {url}")


class SymbolResolver:
    """NSE row -> canonical NSE symbol, from nse_stocks. ISIN first (survives renames: TATAMOTORS ->
    TMPV kept its ISIN), restricted to ISINs held by exactly ONE symbol; then the exact symbol."""

    def __init__(self, rows):
        by_isin: dict[str, set] = {}
        self.symbols: set[str] = set()
        for sym, isin in rows:
            if not sym:
                continue
            self.symbols.add(sym)
            if isin:
                by_isin.setdefault(isin.strip().upper(), set()).add(sym)
        self.by_isin = {k: next(iter(v)) for k, v in by_isin.items() if len(v) == 1}
        self.unmapped: Counter = Counter()

    @classmethod
    def from_db(cls, conn) -> "SymbolResolver":
        return cls([(r[0], r[1]) for r in conn.execute("SELECT symbol, isin FROM nse_stocks").fetchall()])

    def resolve(self, raw_symbol, isin) -> str | None:
        isin = (clean_text(isin) or "").upper()
        if isin in self.by_isin:
            return self.by_isin[isin]
        sym = (clean_text(raw_symbol) or "").upper()
        if sym in self.symbols:
            return sym
        self.unmapped[(sym or "?", isin or "?")] += 1
        return None

    def report(self, prefix: str) -> None:
        if self.unmapped:
            top = ", ".join(f"{s}/{i} x{n}" for (s, i), n in self.unmapped.most_common(15))
            print(f"{prefix} unmapped rows: {sum(self.unmapped.values())} "
                  f"({len(self.unmapped)} distinct) -- {top}", file=sys.stderr)


def windows(start: date, end: date, days: int = 5):
    d = start
    while d <= end:
        w_end = min(d + timedelta(days=days - 1), end)
        yield d, w_end
        d = w_end + timedelta(days=1)


def resume_start(conn, table: str, ts_col: str, default: date, overlap_days: int = 5, where: str = "") -> date:
    """Next crawl start = MAX(ts_col)'s date minus one window of overlap (upserts are idempotent, and
    the overlap re-covers any period type a stopped run had not reached for its last window)."""
    row = conn.execute(f"SELECT MAX({ts_col}) FROM {table}" + (f" WHERE {where}" if where else "")).fetchone()
    last = row[0] if row else None
    if last is None:
        return default
    if isinstance(last, str):  # db_compat may hand back text; only the date part matters here
        last = datetime.fromisoformat(last)
    last_d = last.astimezone(IST).date() if isinstance(last, datetime) else last
    return max(default, last_d - timedelta(days=overlap_days))
