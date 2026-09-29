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


ADJ_LOOKBACK_DAYS = 45
ADJ_TOLERANCE = 0.02


def check_adjustments(conn: psycopg.Connection, as_of: dt.date) -> list[CheckResult]:
    """Derived price factors (from PREV_CLOSE) against the exchange's own corporate-action record
    (nse_pr_bc) over the recent window: every recorded split/bonus/consolidation with an ex-date
    that has traded must have a derived factor within ADJ_TOLERANCE, and a derived factor with no
    recorded action is flagged for review. Nothing to compare (no Bc data) is a warn, never a pass."""
    since = as_of - dt.timedelta(days=ADJ_LOOKBACK_DAYS)
    ex = read_df(conn, """SELECT e.instrument_id, e.event_type, e.event_date,
                                 (e.detail->>'expected_factor')::float8 AS expected, a.factor
                          FROM alpha.corporate_event e
                          LEFT JOIN alpha.adjustment a ON a.instrument_id = e.instrument_id AND a.ex_date = e.event_date
                          WHERE e.source = 'nse_pr_bc' AND e.detail->>'expected_factor' IS NOT NULL
                            AND e.event_date BETWEEN %s AND %s
                            AND EXISTS (SELECT 1 FROM alpha.daily_bar b
                                        WHERE b.instrument_id = e.instrument_id AND b.trade_date = e.event_date)""",
                 (since, as_of))
    covered = read_df(conn, "SELECT count(*) AS n FROM alpha.corporate_event WHERE source='nse_pr_bc' AND knowable_at::date >= %s",
                      (since,)).n[0]
    if not covered:
        return [CheckResult("adjustments:vs_exchange", "warn", None, "no exchange corporate-action data in window")]
    bad = []
    for r in ex.itertuples():
        if r.factor != r.factor or r.factor is None:
            bad.append(f"iid {r.instrument_id} {r.event_type} {r.event_date}: exchange {r.expected:.4f}, no derived factor")
        elif abs(r.factor / r.expected - 1) > ADJ_TOLERANCE:
            bad.append(f"iid {r.instrument_id} {r.event_type} {r.event_date}: exchange {r.expected:.4f} vs derived {r.factor:.4f}")
    orphans = read_df(conn, """SELECT a.instrument_id, a.ex_date, a.factor FROM alpha.adjustment a
                               WHERE a.ex_date BETWEEN %s AND %s AND NOT EXISTS (
                                 SELECT 1 FROM alpha.corporate_event e WHERE e.source = 'nse_pr_bc'
                                   AND e.instrument_id = a.instrument_id AND e.event_date = a.ex_date)""", (since, as_of))
    out = [CheckResult("adjustments:vs_exchange", "fail" if bad else "pass", float(len(bad)),
                       "; ".join(bad[:10]) or f"{len(ex)} exchange actions match derived factors")]
    out.append(CheckResult("adjustments:unexplained", "warn" if len(orphans) else "pass", float(len(orphans)),
                           "; ".join(f"iid {r.instrument_id} {r.ex_date} factor {r.factor:.4f}" for r in orphans.head(10).itertuples())
                           or "every derived factor has an exchange record"))
    return out


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
    out.extend(check_adjustments(conn, as_of))
    now = ist_now()
    upsert(conn, "alpha.dq_result", [{"check_id": r.check_id, "run_at": now, "status": r.status, "value": r.value,
                                      "detail": r.detail} for r in out], key=("check_id", "run_at"))
    conn.commit()
    return out
