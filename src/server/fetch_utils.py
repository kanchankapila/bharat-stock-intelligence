"""
Shared HTTP-retry and partial-failure telemetry helpers for the Python fetchers.

Audit finding this closes: none of the ~47 fetcher scripts used a retry/backoff library
(single-attempt try/except that logs and skips on failure), and partial failures (some
symbols OK, some not) were logged per-row but never aggregated — a fetcher silently losing
30% of its universe looked identical to a healthy run in the job monitor.

Usage:
    from fetch_utils import retry_get, FetchTracker

    resp = retry_get(session, url, timeout=15)          # raises after 3 attempts

    tracker = FetchTracker("pcr_fetcher")
    for sym in symbols:
        rec = fetch_one(sym)
        tracker.record(sym, ok=rec is not None)
    tracker.finish()   # prints a summary; sys.exit(1) if failure rate crosses the threshold,
                        # which the existing per-step .catch() in queues.ts already surfaces
                        # as a real job failure instead of a silent partial success.
"""

from __future__ import annotations

import sys
import time
import random


def retry_get(session_or_requests, url: str, retries: int = 3, backoff_base: float = 1.0, **kwargs):
    """GET with exponential backoff + jitter. Raises the last exception after `retries` attempts.

    Mirrors requests' call signature (session.get(url, **kwargs) or requests.get(url, **kwargs))
    so it's a drop-in replacement at existing call sites.
    """
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = session_or_requests.get(url, **kwargs)
            resp.raise_for_status()
            return resp
        except Exception as e:
            last_exc = e
            if attempt == retries:
                break
            sleep_s = backoff_base * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
            print(f"[RETRY] {url} attempt {attempt}/{retries} failed ({e}); retrying in {sleep_s:.1f}s")
            time.sleep(sleep_s)
    raise last_exc  # type: ignore[misc]


class FetchTracker:
    """Accumulates per-item success/failure across a fetch run and makes the failure rate
    visible: prints a summary every run, and exits non-zero when failures cross the threshold
    so a silently-degraded run stops looking identical to a healthy one in the job monitor.
    """

    def __init__(self, job_name: str, fail_threshold: float = 0.15, min_total_for_threshold: int = 10):
        self.job_name = job_name
        self.fail_threshold = fail_threshold
        self.min_total_for_threshold = min_total_for_threshold
        self.succeeded: list[str] = []
        self.failed: list[str] = []

    def record(self, item: str, ok: bool) -> None:
        (self.succeeded if ok else self.failed).append(item)

    @property
    def total(self) -> int:
        return len(self.succeeded) + len(self.failed)

    @property
    def fail_rate(self) -> float:
        return (len(self.failed) / self.total) if self.total else 0.0

    def finish(self, exit_on_threshold: bool = True) -> None:
        total = self.total
        rate_pct = self.fail_rate * 100
        print(f"[FETCH SUMMARY] {self.job_name}: {len(self.succeeded)}/{total} succeeded "
              f"({100 - rate_pct:.1f}%), {len(self.failed)} failed")
        if self.failed:
            preview = ", ".join(self.failed[:15])
            more = f" (+{len(self.failed) - 15} more)" if len(self.failed) > 15 else ""
            print(f"[FETCH SUMMARY] {self.job_name}: failed items — {preview}{more}")

        if (exit_on_threshold
                and total >= self.min_total_for_threshold
                and self.fail_rate > self.fail_threshold):
            print(f"[FETCH SUMMARY] {self.job_name}: failure rate {rate_pct:.1f}% exceeds "
                  f"{self.fail_threshold * 100:.0f}% threshold — exiting non-zero so this run "
                  f"is flagged instead of silently reported as a success.")
            sys.exit(1)
