"""Single-process scheduler. One schedule, defined here, in code — no mirrored cron tables to
drift (legacy: a cron pattern mirrored into two registries drifted 6 times and produced
phantom 'late' alerts).

Every few minutes after the evening cutoff it runs the daily DAG for each probable session
that has no successful publish yet (bounded catch-up), so a missed evening self-heals the
next time the process is up. A bhavcopy that is not out yet is retried until the cutoff.
"""
from __future__ import annotations

import datetime as dt
import logging
import time

from bharat_alpha.db import connect, read_df
from bharat_alpha.pipeline.daily import run_daily
from bharat_alpha.timeutil import IST, is_probable_session, ist_now, latest_completed_session

log = logging.getLogger("bharat_alpha.scheduler")
START_AFTER = dt.time(19, 0)
MAX_CATCHUP_SESSIONS = 5
POLL_SECONDS = 120          # must fit at least twice into the 6-minute pre-open window


def pending_sessions(conn, today_session: dt.date, horizons: tuple[int, ...]) -> list[dt.date]:
    out, d = [], today_session
    while len(out) < MAX_CATCHUP_SESSIONS:
        if is_probable_session(d):
            done = read_df(conn, "SELECT count(DISTINCT job) n FROM alpha.job_run WHERE as_of_date=%s AND status='success' "
                                 "AND job = ANY(%s)", (d, [f"publish_h{h}" for h in horizons]))
            if int(done.n[0]) == len(horizons):
                break
            out.append(d)
        d -= dt.timedelta(days=1)
    return sorted(out)


PREOPEN_WINDOW = (dt.time(9, 8), dt.time(9, 14))


def capture_preopen(conn, now: dt.datetime) -> dict | None:
    """One pre-open capture per session, inside the 09:08-09:14 IST window (after the auction
    closes, before the market opens)."""
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_preopen import NsePreopen
    from bharat_alpha.pipeline.daily import run_step

    d = now.date()
    if not (is_probable_session(d) and PREOPEN_WINDOW[0] <= now.time() <= PREOPEN_WINDOW[1]):
        return None

    def go():
        status, n = run_connector(conn, NsePreopen(), d)
        if status not in ("success",):
            raise RuntimeError(f"pre-open capture {status} ({n} rows)")
        return {"rows": n}

    return run_step(conn, "preopen", d, go)


def tick(now: dt.datetime | None = None) -> list[dict]:
    from bharat_alpha.config import get_settings

    now = (now or ist_now()).astimezone(IST)
    results = []
    with connect() as conn:
        po = capture_preopen(conn, now)
        if po is not None:
            results.append({"preopen": po})
        todo = pending_sessions(conn, latest_completed_session(now), get_settings().horizons)
        # today's files are not reliably out before the cutoff; earlier sessions are caught up any time
        todo = [d for d in todo if d < now.date() or now.time() >= START_AFTER]
        for d in todo:
            res = run_daily(conn, d)
            log.info("daily %s -> %s", d, {k: v.get("status") for k, v in res.items() if isinstance(v, dict)})
            results.append({"date": str(d), **res})
            if res.get("ingest", {}).get("status") == "failed":
                break                        # not published yet (or source down); retry next tick
    return results


def run_forever() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    while True:
        try:
            tick()
        except Exception:
            log.exception("scheduler tick failed")
        time.sleep(POLL_SECONDS)


def preopen_tick(now: dt.datetime | None = None) -> dict | None:
    """Run only the time-sensitive pre-open capture, never the heavy daily DAG."""
    now = (now or ist_now()).astimezone(IST)
    with connect() as conn:
        return capture_preopen(conn, now)


def run_preopen_forever() -> None:
    """Keep the six-minute pre-open window covered without competing with evening jobs."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    while True:
        try:
            result = preopen_tick()
            if result is not None:
                log.info("preopen -> %s", result)
        except Exception:
            log.exception("preopen scheduler tick failed")
        time.sleep(POLL_SECONDS)
