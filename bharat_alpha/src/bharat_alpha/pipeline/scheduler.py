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
POLL_SECONDS = 300


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


def tick(now: dt.datetime | None = None) -> list[dict]:
    from bharat_alpha.config import get_settings

    now = (now or ist_now()).astimezone(IST)
    results = []
    with connect() as conn:
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
