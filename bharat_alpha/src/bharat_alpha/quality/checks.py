"""Data-quality checks, GENERATED from the connector registry plus delivery checks.

Every registered connector automatically gets (a) freshness measured in TRADING sessions
against the exchange calendar, and (b) per-field fill-rate on its latest date. On top:
ingest runs that ended 'failed'/'empty' fail loudly, and the end product — today's
recommendations — is checked for DELIVERY, not just table freshness (legacy: a fresh table
whose feature never populated passed every freshness check).

Checks report share-of-rows against thresholds sized to real defects, never bare count > 0.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import psycopg

from bharat_alpha.db import read_df, upsert
from bharat_alpha.ingest.registry import CONNECTORS
from bharat_alpha.timeutil import ist_now


@dataclass
class CheckResult:
    check_id: str
    status: str
    value: float | None
    detail: str


def _sessions_between(conn, a: dt.date | None, b: dt.date) -> int | None:
    if a is None:
        return None
    r = read_df(conn, "SELECT count(*) AS n FROM alpha.trading_day WHERE trade_date > %s AND trade_date <= %s", (a, b))
    return int(r.n[0])


def run_checks(conn: psycopg.Connection, as_of: dt.date, horizons: tuple[int, ...] = ()) -> list[CheckResult]:
    out: list[CheckResult] = []
    for name, cls in CONNECTORS.items():
        h = cls.health
        where = f"WHERE {h.scope_sql}" if h.scope_sql else ""
        latest = read_df(conn, f"SELECT max({h.date_column})::date AS d FROM {h.table} {where}").d[0]
        stale = _sessions_between(conn, latest, as_of)
        if stale is None:
            status = "warn" if h.sparse else "fail"
            out.append(CheckResult(f"fresh:{name}", status, None, "no rows ever written"))
        else:
            status = "pass"
            if stale >= h.fail_after_sessions and not h.sparse:
                status = "fail"
            elif stale >= h.warn_after_sessions:
                status = "warn"
            out.append(CheckResult(f"fresh:{name}", status, float(stale), f"latest {latest}, {stale} sessions behind {as_of}"))
        if latest is not None and h.fill_rates:
            cond = f"{h.date_column}::date = %s" + (f" AND {h.scope_sql}" if h.scope_sql else "")
            cols = ", ".join(f"avg(({c} IS NOT NULL)::int) AS {c}" for c in h.fill_rates)
            fr = read_df(conn, f"SELECT count(*) AS n, {cols} FROM {h.table} WHERE {cond}", (latest,))
            for c, floor in h.fill_rates.items():
                v = float(fr[c][0]) if fr.n[0] else 0.0
                out.append(CheckResult(f"fill:{name}:{c}", "pass" if v >= floor else "fail", v,
                                       f"{v:.1%} non-null on {latest} (floor {floor:.0%}, n={int(fr.n[0])})"))
    runs = read_df(conn, """SELECT source, status, detail FROM alpha.ingest_run
                            WHERE target_date = %s AND status IN ('failed','empty')""", (as_of,))
    out.append(CheckResult("ingest:failed_or_empty", "fail" if len(runs) else "pass", float(len(runs)),
                           "; ".join(f"{r.source}={r.status}" for r in runs.itertuples()) or "none"))
    susp = read_df(conn, "SELECT avg(is_suspect::int) AS s, count(*) AS n FROM alpha.daily_bar WHERE trade_date=%s", (as_of,))
    if susp.n[0]:
        v = float(susp.s[0])
        out.append(CheckResult("bars:suspect_share", "fail" if v > 0.02 else "warn" if v > 0.005 else "pass", v,
                               f"{v:.2%} of {int(susp.n[0])} bars flagged suspect"))
    for h in horizons:
        rec = read_df(conn, "SELECT count(*) AS n FROM alpha.recommendation WHERE as_of_date=%s AND horizon=%s", (as_of, h))
        uni = read_df(conn, "SELECT count(*) AS n FROM alpha.daily_bar WHERE trade_date=%s AND NOT is_suspect", (as_of,))
        share = rec.n[0] / uni.n[0] if uni.n[0] else 0.0
        out.append(CheckResult(f"delivery:recommendations_h{h}", "pass" if share >= 0.2 else "fail", float(share),
                               f"{int(rec.n[0])} recommendations vs {int(uni.n[0])} traded instruments"))
    now = ist_now()
    upsert(conn, "alpha.dq_result", [{"check_id": r.check_id, "run_at": now, "status": r.status, "value": r.value,
                                      "detail": r.detail} for r in out], key=("check_id", "run_at"))
    conn.commit()
    return out
