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


def _is_waf_challenge(exc: Exception) -> bool:
    """True if `exc` is an HTTPError whose response carries AWS WAF's own
    `x-amzn-waf-action` header (e.g. 'captcha', 'challenge') -- an unambiguous signal from
    the WAF itself, not a heuristic on status code alone (a bare 403/405 can mean other
    things on other providers). Retrying THIS specific response is never useful: it will not
    self-clear within a backoff window, and for providers whose allowance is a per-session
    REQUEST COUNT rather than a rate (see cap_to_run_budget's docstring), every retry directly
    consumes budget that a genuinely-fetchable row further down the list could have used.
    """
    resp = getattr(exc, "response", None)
    if resp is None:
        return False
    return bool(resp.headers.get("x-amzn-waf-action"))


def retry_get(session_or_requests, url: str, retries: int = 3, backoff_base: float = 1.0, **kwargs):
    """GET with exponential backoff + jitter. Raises the last exception after `retries` attempts.

    Mirrors requests' call signature (session.get(url, **kwargs) or requests.get(url, **kwargs))
    so it's a drop-in replacement at existing call sites.

    Does NOT retry a response the WAF itself marks as a challenge/captcha (see
    _is_waf_challenge) -- found 2026-08-27: trendlyne_adv_tech_fetcher.py/
    trendlyne_price_analysis_fetcher.py's cap_to_run_budget(limit=110) caps the number of
    SYMBOLS per run, but blindly retrying every WAF-blocked one 3x before FetchTracker's
    abort_after_consecutive_fails=20 circuit breaker trips meant up to 20*3=60 of that
    110-request allowance was spent on responses that were never going to succeed --
    silently multiplying the effective per-run request cost against the exact ceiling this
    budget exists to respect, and explaining trendlyne-midweek's 83% failure rate despite the
    budget "working as designed" by its own row count.
    """
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = session_or_requests.get(url, **kwargs)
            resp.raise_for_status()
            return resp
        except Exception as e:
            last_exc = e
            if _is_waf_challenge(e):
                print(f"[RETRY] {url} blocked by WAF challenge (not retrying -- would not "
                      f"self-clear, and would waste this run's request allowance)")
                break
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

    def __init__(self, job_name: str, fail_threshold: float = 0.15, min_total_for_threshold: int = 10,
                 abort_after_consecutive_fails: int | None = None):
        self.job_name = job_name
        self.fail_threshold = fail_threshold
        self.min_total_for_threshold = min_total_for_threshold
        self.abort_after_consecutive_fails = abort_after_consecutive_fails
        self.succeeded: list[str] = []
        self.failed: list[str] = []
        self._consecutive_fails = 0

    def record(self, item: str, ok: bool) -> None:
        (self.succeeded if ok else self.failed).append(item)
        if ok:
            self._consecutive_fails = 0
            return
        self._consecutive_fails += 1
        # 2026-08-13: trendlyne_price_analysis_fetcher.py was hitting a WAF block on request 1
        # every run (405 on every retry, every symbol) and grinding through all ~2234 stocks
        # anyway -- each one still paying retry_get's full 3-attempt backoff -- until the
        # *outer* 40-minute runPython timeout SIGKILLed it (~52min real, over budget), every
        # ~30-90min via the catch-up retry loop, all day. A total/near-total upstream block
        # doesn't get better by finishing the run; bailing out after N consecutive failures
        # turns a 40-minute forced kill into a fail-fast exit within seconds, and stops
        # hammering an already-blocking WAF with the remaining ~2200 requests. Opt-in
        # (default None) so this doesn't change behavior for fetchers that legitimately have
        # long stretches of expected misses (e.g. tickers genuinely delisted mid-universe-scan).
        if (self.abort_after_consecutive_fails is not None
                and self._consecutive_fails >= self.abort_after_consecutive_fails):
            print(f"[FETCH SUMMARY] {self.job_name}: aborting early after "
                  f"{self._consecutive_fails} consecutive failures (most recent: {item}; "
                  f"{len(self.succeeded)}/{self.total} succeeded so far) -- upstream looks "
                  f"blocked/down, not worth grinding through the rest of the run at the same rate.")
            sys.exit(1)

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


def filter_numeric_tlids(rows, label: str = "trendlyne"):
    """Drop (symbol, tlid) pairs whose tlid is not Trendlyne's numeric stock id.

    Trendlyne's `tlid` is an opaque numeric id (`533`), never the ticker -- see
    .claude/rules/data-sources.md, which is explicit that provider ids are resolved, never
    constructed by convention. nse_stocks.tlid nonetheless holds the TICKER for 412 of 2,234
    rows (legacy seed data: 'AARTECH', 'MOSCHIP', 'MWL', ...), and every one of those builds
    .../adv-technical-analysis/AARTECH/24/ which is a permanent 404.

    Live-verified 2026-08-13: numeric ids return HTTP 200 at 1 AND 15 concurrent workers, the
    ticker-shaped ones 404 -- so this is a resolution defect, not the upstream outage the
    2026-08-12 run's 94.9% failure rate looked like (that part was transient and has healed).

    Filtering in Python, not SQL: `tlid ~ '^[0-9]+$'` is a Postgres-only operator and would
    fail closed on the SQLite fallback (.claude/rules/recurring-bugs.md, SQL dialect).

    Returns (kept, dropped_symbols). Callers should log the dropped count rather than swallow
    it -- these symbols have NO Trendlyne coverage until resolve_trendlyne_tlids.py backfills
    a real id for them, and a silent filter would hide that gap the way the old blind retries did.
    """
    kept, dropped = [], []
    for symbol, tlid in rows:
        if str(tlid).strip().isdigit():
            kept.append((symbol, str(tlid).strip()))
        else:
            dropped.append(symbol)
    if dropped:
        print(f"[{label}] Skipping {len(dropped)} stock(s) whose nse_stocks.tlid is not a "
              f"numeric Trendlyne id (would 404): {', '.join(sorted(dropped)[:10])}"
              f"{' ...' if len(dropped) > 10 else ''}. "
              f"Run resolve_trendlyne_tlids.py to recover them.")
    return kept, dropped


# ── Trendlyne request concurrency ────────────────────────────────────────────────────────
# trendlyne.com sits behind AWS WAF on CloudFront. When its bot rule fires it returns
# HTTP 405 with `x-amzn-waf-action: captcha` and a "Human Verification" HTML body for EVERY
# subsequent request (~10 min), so one trip fails the whole run, not just the request.
#
# The trigger is CONCURRENCY, not volume or sustained rate. Measured live 2026-08-17 against
# the real endpoint, same session/headers/URL the fetchers use:
#
#   concurrency  1 (serial, 0.5s apart) -> 60/60 OK
#   concurrency  2                      -> 16/16 OK
#   concurrency  3                      -> 24/24 OK
#   concurrency  5                      -> TRIPPED after 20 requests
#   concurrency 15 (the old BATCH_SIZE) -> TRIPPED on the very FIRST batch, all 15
#
# 15 tripping on request 1 is why trendlyne-midweek failed every run since 2026-08-04: the
# opening batch poisoned the session before any work happened. price_analysis's BATCH_SIZE=5
# was over the line too, which is why it managed ~145 rows and then died every time.
#
# This matches the one Trendlyne job that has NEVER failed -- trendlyne-daily-fetch
# (87,721 runs, 0 failures) -- which issues ONE request per symbol jittered across a 12-hour
# window (`randomizeTrendlyneFetchDelay`, trendlyneAuthService.ts) and so is never concurrent.
#
# 3 is the highest measured-safe value. Raising it requires re-running the measurement above,
# not a guess -- and note the safe level is a property of Trendlyne's WAF config, which can
# change under us. ponytail: no adaptive concurrency controller; the FetchTracker abort plus
# each fetcher's resume-from-DB means a trip degrades to "finish next run" rather than a loss.
# Serial. Concurrency does not just risk a trip, it SHRINKS the allowance (below), so there is
# nothing to buy by raising this: 1 -> ~131-150 requests, 3 -> ~84, 5 -> ~20, 15 -> 15.
TRENDLYNE_MAX_CONCURRENT = 1

# Per-RUN request budget.
#
# Follow-up measurement (2026-08-17) showed the WAF allowance is a cumulative REQUEST COUNT per
# anonymous session, not a rate -- so no amount of slowing down buys a full-universe pass:
#
#   serial @ 55 req/min (1.0s spacing) -> tripped at request 131 (after 142s)
#   serial @ 23 req/min (2.5s spacing) -> tripped at request 150 (after 386s)
#
# Halving the rate moved the trip point by 19 requests. A 2,234-symbol universe is ~15x the
# allowance, so a single pass is IMPOSSIBLE at any pacing without solving the CAPTCHA.
#
# So each run takes a bounded slice and stops CLEANLY while still under the allowance, instead of
# charging into it and burning the rest of the run on 405s. Combined with each fetcher's
# resume-from-DB skip, successive runs converge on full coverage -- which is exactly how
# trendlyne_adv_tech_daily went 1350 -> 2234/2234 (100%) on 2026-08-17.
#
# 110 leaves ~20 requests of headroom under the lowest observed trip point (131).
TRENDLYNE_RUN_REQUEST_BUDGET = 110


def cap_to_run_budget(rows, label: str, requests_per_row: int = 1,
                      limit: int = TRENDLYNE_RUN_REQUEST_BUDGET):
    """Trim a resumable work list to this run's WAF allowance, logging what was deferred.

    Not a rate limiter -- the allowance is a request COUNT, so pacing is not the lever (see
    TRENDLYNE_RUN_REQUEST_BUDGET). Callers MUST already skip rows completed for the current
    date, or this would re-fetch the same leading slice forever and never converge, which is
    exactly the bug that pinned trendlyne_price_analysis at 145/2234.
    """
    max_rows = max(1, limit // max(1, requests_per_row))
    if len(rows) <= max_rows:
        return rows
    print(f"[{label}] Taking {max_rows} of {len(rows)} remaining this run "
          f"({requests_per_row} request(s)/row against a ~{limit}-request allowance, which is a "
          f"per-session COUNT (~131-150 observed), not a rate). The next scheduled run resumes "
          f"from the DB; a partial run here is normal, not a failure.")
    return rows[:max_rows]
