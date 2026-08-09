"""Politely fetch concrete URLs for each endpoint. Network is injectable for tests."""
from __future__ import annotations

import random
import time
from dataclasses import dataclass

from .normalizer import EndpointTemplate


@dataclass
class FetchResult:
    endpoint: EndpointTemplate
    url: str
    status: int
    latency_ms: int
    ok: bool
    body: str | None
    content_type: str
    error: str | None


def _default_fetch_fn(url: str):
    from curl_cffi import requests as cffi
    r = cffi.get(url, impersonate="chrome120", timeout=15)
    return r.status_code, r.text, r.headers.get("content-type", "")


def fetch_all(endpoints, fetch_fn=None, max_per_endpoint=None,
              delay: float = 0.3, max_consec_fail: int = 5):
    fetch_fn = fetch_fn or _default_fetch_fn
    results: list[FetchResult] = []
    for ep in endpoints:
        urls = ep.urls if max_per_endpoint is None else ep.urls[:max_per_endpoint]
        consec = 0
        for url in urls:
            t0 = time.time()
            try:
                status, body, ctype = fetch_fn(url)
                ok = 200 <= status < 300 and body is not None
                err = None if ok else f"http {status}"
            except Exception as e:  # noqa: BLE001
                status, body, ctype, ok, err = 0, None, "", False, str(e)
            results.append(FetchResult(ep, url, status, int((time.time() - t0) * 1000),
                                       ok, body, ctype, err))
            consec = 0 if ok else consec + 1
            if consec >= max_consec_fail:
                break  # circuit breaker: stop hammering a throttling host
            if delay:
                time.sleep(delay * (0.7 + 0.6 * random.random()))
    return results
