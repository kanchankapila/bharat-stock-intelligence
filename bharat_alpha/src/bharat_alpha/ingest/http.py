"""HTTP client shared by every connector.

* Retries only transient failures (connection errors, 429, 5xx) with exponential backoff and
  honours Retry-After. A 404 is returned to the caller, because for archive files it means
  "not published" (holiday / not yet out) — a first-class status, not an error to retry.
* NSE's API sits behind Akamai and needs a cookie from the HTML site first; `warmup_url`
  handles that per host.
* Minimum-header discipline: connectors declare the headers they need. Legacy found that
  adding credentials or a wrong `sec-fetch-site` can LOWER access, so nothing is added
  implicitly beyond a browser User-Agent.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

import requests

from bharat_alpha.config import get_settings

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

WARMUP = {
    "www.nseindia.com": "https://www.nseindia.com/",
}


class FetchError(RuntimeError):
    pass


@dataclass
class HttpClient:
    min_interval_s: float = 0.35
    session: requests.Session = field(default_factory=requests.Session)
    _last: dict[str, float] = field(default_factory=dict)
    _warmed: set[str] = field(default_factory=set)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        self.session.headers.update({"User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"})

    def _throttle(self, host: str) -> None:
        with self._lock:
            wait = self._last.get(host, 0.0) + self.min_interval_s - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last[host] = time.monotonic()

    def _warm(self, host: str) -> None:
        if host in WARMUP and host not in self._warmed:
            try:
                self.session.get(WARMUP[host], timeout=get_settings().http_timeout_s)
            finally:
                self._warmed.add(host)

    def get(self, url: str, headers: dict | None = None, params: dict | None = None) -> requests.Response:
        return self.request("GET", url, headers=headers, params=params)

    def request(self, method: str, url: str, **kw) -> requests.Response:
        s = get_settings()
        host = urlparse(url).netloc
        self._warm(host)
        delay = 2.0
        last_exc: Exception | None = None
        for attempt in range(s.http_max_retries + 1):
            self._throttle(host)
            try:
                resp = self.session.request(method, url, timeout=s.http_timeout_s, **kw)
            except requests.RequestException as e:
                last_exc = e
            else:
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_exc = FetchError(f"{resp.status_code} from {url}")
                    ra = resp.headers.get("Retry-After")
                    if ra and ra.isdigit():
                        delay = max(delay, float(ra))
                elif resp.status_code in (401, 403) and host in WARMUP and attempt == 0:
                    self._warmed.discard(host)          # cookie expired; re-warm once
                    self._warm(host)
                    last_exc = FetchError(f"{resp.status_code} from {url}")
                else:
                    return resp
            if attempt < s.http_max_retries:
                time.sleep(delay)
                delay *= 2
        raise FetchError(f"giving up on {url}: {last_exc}")
