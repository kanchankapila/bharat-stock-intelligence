"""
TLS-fingerprint-impersonated HTTP client for trendlyne.com (fetcher ONLY — no scraping,
no parsing, no crawling lives here; this is purely the transport layer).

WHY THIS EXISTS
---------------
trendlyne.com sits behind AWS WAF on CloudFront, and fetch_utils.py's live measurements
(2026-08-17) proved its bot rule keys on more than request count: python-requests presents
a urllib/OpenSSL TLS ClientHello that browser fingerprinting flags even when headers are
copied verbatim. The WAF allowance measurements (~131-150 requests/session, concurrency-
shrunk) were taken WITH that handicap. Scrapling's `Fetcher` wraps curl_cffi and presents a
real Chrome TLS handshake + browser-consistent header set (`stealthy_headers=True`,
`impersonate="chrome"` resolves to the latest Chrome curl_cffi profile), which removes the
cheapest signal the WAF has — verified live 2026-08-26: the exact production URL returns
200 + valid JSON through Scrapling with zero code change beyond transport.

SCOPE (deliberate)
------------------
Fetcher-only, per the repo convention that provider ids/data parsing stay in each fetcher
script. This module exposes a requests.Session-shaped shim so existing call sites
(`retry_get(session, url, params=..., timeout=15)` -> `.json()`) work unchanged:

    session = tl_fetch.create_session()      # replaces requests.Session() + header updates
    r = retry_get(session, url, params=..., timeout=15)
    data = r.json()

KILL SWITCH
-----------
TRENDLYNE_USE_SCRAPLING=0 falls back to plain requests.Session + the legacy HEADERS, so a
bad Scrapling/curl_cffi upgrade can be reverted by env alone (no redeploy), matching how
PYTHON_API_URL-style toggles are handled elsewhere in this repo.
"""

from __future__ import annotations

import polars as pl
import json as _json
import os

# Resolved once at import: a broken/missing Scrapling install must degrade to requests at
# SESSION-CREATION time, not explode inside a fetch loop mid-run.
_SCRAPLING_IMPORT_ERROR: str | None = None
try:
    from scrapling.fetchers import Fetcher as _ScraplingFetcher
except Exception as _e:  # pragma: no cover - depends on venv state
    _ScraplingFetcher = None
    _SCRAPLING_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

# curl_cffi impersonation target. "chrome" resolves to the latest Chrome profile the
# installed curl_cffi ships; pin a specific version here only if a measurement ever demands it.
IMPERSONATE = os.environ.get("TRENDLYNE_IMPERSONATE", "chrome")

# Legacy header set, kept byte-identical to what the fetchers used before so the requests
# fallback path behaves exactly as production did pre-2026-08-26.
LEGACY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://www.nseindia.com/",
}


class TLResponse:
    """Minimal duck-type of requests.Response over a Scrapling Response.

    Only the surface the Trendlyne fetchers actually touch: .json(), .text, .status_code,
    .headers. Anything richer belongs in the caller, not here.
    """

    def __init__(self, resp) -> None:
        self._resp = resp
        self.status_code = int(getattr(resp, "status", 0))
        self.headers = dict(getattr(resp, "headers", {}) or {})
        body = getattr(resp, "body", b"")
        if isinstance(body, bytes):
            self.text = body.decode("utf-8", "replace")
        else:
            self.text = body or ""

    @property
    def waf_action(self) -> str | None:
        """AWS WAF stamps `x-amzn-waf-action: captcha` on challenge responses — the exact
        signal fetch_utils' WAF notes key on. Surfaced so error messages carry it."""
        return self.headers.get("x-amzn-waf-action")

    def json(self):
        return _json.loads(self.text)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            extra = f" (x-amzn-waf-action={self.waf_action})" if self.waf_action else ""
            exc = Exception(f"HTTP {self.status_code}{extra} for {getattr(self._resp, 'url', '?')}")
            # requests.Response.raise_for_status() attaches itself as exc.response so callers
            # (fetch_utils.retry_get's WAF-challenge check, in particular) can inspect the real
            # status/headers without parsing the message string. A bare Exception() here would
            # make that check silently never fire for exactly the fetchers routed through this
            # shim -- found 2026-08-27 fixing retry_get's WAF short-circuit, before it shipped.
            exc.response = self  # type: ignore[attr-defined]
            raise exc


class TLSession:
    """requests.Session-shaped wrapper around Scrapling's curl_cffi client.

    `headers` is kept as a writable attribute purely for signature compatibility with
    `session.headers.update(...)` at legacy call sites; Scrapling manages the actual
    browser-consistent header set itself (stealthy_headers=True) and merging our static
    UA over it would defeat the point.
    """

    def __init__(self) -> None:
        if _ScraplingFetcher is None:
            raise ImportError(f"scrapling unavailable: {_SCRAPLING_IMPORT_ERROR}")
        self.headers: dict = {}

    def get(self, url: str, params=None, timeout: float = 15, **kwargs):
        # NOTE: deliberate passthrough of only the args our fetchers use. retry_get injects
        # nothing else. If a future caller needs cookies/auth, extend here explicitly rather
        # than letting arbitrary kwargs reach curl_cffi untested.
        resp = _ScraplingFetcher.get(
            url,
            params=params,
            timeout=timeout,
            impersonate=IMPERSONATE,
            stealthy_headers=True,
        )
        return TLResponse(resp)


def create_session():
    """Best-available Trendlyne HTTP session.

    Returns TLSession (curl_cffi Chrome TLS impersonation) unless Scrapling is missing/
    broken or TRENDLYNE_USE_SCRAPLING=0 — then a plain requests.Session with the legacy
    headers, i.e. exactly the pre-existing behaviour, so the switch is strictly additive.
    """
    if os.environ.get("TRENDLYNE_USE_SCRAPLING", "1") == "0":
        print("[tl_fetch] TRENDLYNE_USE_SCRAPLING=0 -> plain requests (legacy behaviour)")
        import requests

        s = requests.Session()
        s.headers.update(LEGACY_HEADERS)
        return s
    try:
        return TLSession()
    except ImportError as e:
        print(f"[tl_fetch] WARNING: {e} -> falling back to plain requests (legacy behaviour)")
        import requests

        s = requests.Session()
        s.headers.update(LEGACY_HEADERS)
        return s

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
