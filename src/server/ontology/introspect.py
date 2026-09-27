"""
Live introspection — does the documented layer still match the database?

`validate()` (model.py) checks the layer against *itself*: unknown parents, a property bound
to nothing, a metric whose SQL does not reference its declared sources. None of that needs a
database, and none of it can catch the failure this module exists for: **a card naming a
column the table no longer has**, or a writer that silently stopped.

Two entry points:

    live_columns()  read `information_schema` for the current schema
    coverage()      diff that against the ontology, with optional freshness probes

The freshness probe is **opt-in** (`fresh=True`) and validates every interpolated identifier
first, because it is the only thing here that reads table data: `SELECT max(col)` is an
indexed lookup where an index exists and a full scan where it does not. A weekly audit can
pay that; an everyday command should not.

`coverage.json` is the artifact PROV-O deliberately does not try to be: runtime observation.
Static lineage lives in `ontology.prov.ttl`; this is the live verdict.
"""
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from . import vocab
from .model import Ontology

#: Interpolated identifiers (table/column names from our own definitions) are validated before
#: they reach SQL. They are static repo constants, but a semantic layer that builds SQL by
#: string concatenation must still be the last place that trusts its own input.
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

#: The layer's own materialized output. `store` creates ~20 `kg_*` tables/views in the same
#: schema it introspects, so without this filter every coverage run reports the ontology's own
#: artifacts as undocumented data — a report that inflates its own backlog and buries the 212
#: real tables under 20 fake ones. These are outputs of this layer, not gaps in it.
SELF_PREFIX = "kg_"

_LIVE_COLUMNS_SQL = (
    "SELECT table_name, column_name, data_type, is_nullable "
    "FROM information_schema.columns WHERE table_schema = current_schema() "
    "ORDER BY table_name, ordinal_position"
)


def _ident_check(name: str, what: str) -> str:
    if not IDENT.match(name or ""):
        raise ValueError(f"{what} {name!r} is not a safe SQL identifier")
    return name


def _open(conn=None) -> Tuple[Any, bool]:
    """Return (connection, owns_it) — one place that knows how to get a connection."""
    if conn is not None:
        return conn, False
    import db_compat

    return db_compat.connect(), True


def live_columns(conn=None) -> Dict[str, Dict[str, str]]:
    """`{table: {column: data_type}}` for the current schema."""
    c, owns = _open(conn)
    try:
        rows = c.execute(_LIVE_COLUMNS_SQL).fetchall()
    finally:
        if owns:
            c.close()
    out: Dict[str, Dict[str, str]] = {}
    for r in rows:
        out.setdefault(r["table_name"], {})[r["column_name"]] = r["data_type"]
    return out


def current_schema(conn=None) -> str:
    c, owns = _open(conn)
    try:
        row = c.execute("SELECT current_schema() AS s").fetchone()
    finally:
        if owns:
            c.close()
    return (row or {}).get("s") or "unknown"


def _from_epoch(number: float) -> Optional[datetime]:
    """Epoch seconds, milliseconds, microseconds or nanoseconds -> an aware datetime.

    The magnitude decides the unit, and the band is checked rather than assumed: a value
    outside 2000-01-01..2100-01-01 is not a timestamp at all, so it returns None instead of
    producing a confidently wrong date.
    """
    magnitude = abs(number)
    if magnitude >= 1e17:          # nanoseconds
        number /= 1e9
    elif magnitude >= 1e14:        # microseconds
        number /= 1e6
    elif magnitude >= 1e11:        # milliseconds
        number /= 1e3
    try:
        dt = datetime.fromtimestamp(number, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    if not (datetime(2000, 1, 1, tzinfo=timezone.utc) <= dt
            <= datetime(2100, 1, 1, tzinfo=timezone.utc)):
        return None
    return dt


def _parse_time(value: Optional[str]) -> Optional[datetime]:
    """Best-effort parse of a freshness value read back as text.

    Tolerates what Postgres actually renders: `2026-09-22`, `2026-09-22 06:28:24`,
    `2026-09-22 06:28:24.123456+00:00`, and a trailing `Z`. Also accepts the epoch
    encodings two writers use (`job_heartbeat.last_success_at` and
    `data_quality_results.checked_at` are both epoch **milliseconds** written by
    `Date.now()`-style JS) — a value we cannot read is a value we cannot hold anyone
    accountable for, so it must not be silently filed under "unparseable" noise.

    Returns None rather than guessing beyond these forms: an unreadable freshness is
    reported as unparseable, never as fresh.
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return _from_epoch(float(value))
    text = str(value).strip()
    if not text:
        return None
    if text.lstrip("-").isdigit() and len(text.lstrip("-")) >= 11:
        # 11+ digits cannot be a year/month/day; it is an epoch in seconds or millis.
        return _from_epoch(float(text))
    text = text.replace("Z", "+00:00")
    if " " in text:
        text = text.replace(" ", "T", 1)
    if "." in text:
        head, _, tail = text.partition(".")
        frac, tz = tail, ""
        for i, ch in enumerate(tail):
            if ch in "+-":
                frac, tz = tail[:i], tail[i:]
                break
        text = head + "." + frac[:6] + tz
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt



def _freshness_probe(conn, table: str, column: str, lag_hours: Optional[float],
                     data_type: Optional[str] = None) -> Dict[str, Any]:
    """One `SELECT max(<col>)` against one table, guarded by identifier validation.

    **A DATE freshness column is read as the END of the day it names, not its midnight.**
    `stock_ohlcv.date` holding `2026-09-23` means "this table covers the whole of 2026-09-23",
    so at 02:44 on 09-24 the newest bar is current, not 26.7 hours late. Parsing the value as an
    instant silently added up to a full day of phantom age and reported four healthy tables as
    stale — the one failure mode a freshness check must not have, because a reader learns to
    ignore it. A timestamp column is still compared as the instant it is.
    """
    _ident_check(table, "table")
    _ident_check(column, "column")
    row = conn.execute(f"SELECT max({column})::text AS v FROM {table}").fetchone()
    value = (row or {}).get("v")
    parsed = _parse_time(value)
    out: Dict[str, Any] = {"table": table, "column": column, "value": value,
                           "data_type": data_type}
    if parsed is None:
        out.update({"verdict": "no-data" if value is None else "unparseable", "age_hours": None})
        return out
    day_granular = (data_type == "date")
    if day_granular:
        parsed = parsed + timedelta(days=1)      # the value covers the whole day
    age = (datetime.now(timezone.utc) - parsed).total_seconds() / 3600.0
    out["age_hours"] = round(age, 2)
    if day_granular:
        out["granularity"] = "day"
    if lag_hours is None:
        out["verdict"] = "observed"
    else:
        out["expected_lag_hours"] = lag_hours
        out["verdict"] = "fresh" if age <= lag_hours else "stale"
    return out


def coverage(onto: Ontology, conn=None, fresh: bool = False,
             max_listed: int = 200) -> Dict[str, Any]:
    """Diff the documented layer against the live database (and optionally its freshness).

    `ok` is False on exactly three conditions: a documented table that does not exist, a bound
    column that does not exist, or a metric whose declared source table is gone. An
    undocumented live table is a *gap*, not drift — the ontology documents the tables it makes
    semantic claims about, not every table in the database.
    """
    c, owns = _open(conn)
    try:
        schema = current_schema(c)
        live = live_columns(c)
        self_tables = sorted(t for t in live if t.startswith(SELF_PREFIX))
        live = {t: cols for t, cols in live.items() if not t.startswith(SELF_PREFIX)}

        documented = {card.table: card for card in onto.cards}
        documented_live = sorted(t for t in documented if t in live)
        live_only = sorted(t for t in live if t not in documented)
        missing_tables = sorted(t for t in documented if t not in live)

        missing_columns: List[str] = []
        unbound: Dict[str, List[str]] = {}
        for table in documented_live:
            bound = {b.column for b in onto.bindings_for_table(table)}
            cols = live[table]
            for col in sorted(bound):
                if col not in cols:
                    missing_columns.append(f"{table}.{col}")
            extra = sorted(col for col in cols if col not in bound)
            if extra:
                unbound[table] = extra[:max_listed]

        metrics_missing_source = sorted({f"{m.name} -> {t}"
                                         for m in onto.metrics for t in m.source_tables
                                         if t not in live})

        freshness: List[Dict[str, Any]] = []
        if fresh:
            for table in documented_live:
                card = documented[table]
                if not card.freshness_column or card.freshness_column not in live[table]:
                    continue
                try:
                    freshness.append(_freshness_probe(
                        c, table, card.freshness_column, card.expected_lag_hours,
                        live[table].get(card.freshness_column)))
                except Exception as exc:          # noqa: BLE001 - reported, not raised
                    freshness.append({"table": table, "column": card.freshness_column,
                                      "verdict": "error", "detail": str(exc)[:200]})

        broken_tables = {m.split(".")[0] for m in missing_columns}
        sound = len(documented_live) - len(broken_tables)
        total = len(documented)
        return {
            "schema": schema,
            "ontology_version": onto.version,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "counts": {
                "live_tables": len(live),
                "documented_tables": total,
                "documented_tables_present": len(documented_live),
                "undocumented_live_tables": len(live_only),
                "bound_columns": len(onto.bindings),
                "missing_columns": len(missing_columns),
                "documented_tables_sound_pct": round(100.0 * sound / total, 1) if total else 0.0,
            },
            "ok": not missing_tables and not missing_columns and not metrics_missing_source,
            "drift": {
                "missing_tables": missing_tables,
                "missing_columns": missing_columns,
                "metrics_with_missing_sources": metrics_missing_source,
            },
            "gaps": {
                "undocumented_live_tables": live_only[:max_listed],
                "undocumented_truncated": len(live_only) > max_listed,
                "columns_not_bound": unbound,
                "excluded_self_tables": self_tables,
            },
            "freshness": freshness,
            "stale": [f["table"] for f in freshness if f.get("verdict") == "stale"],
        }
    finally:
        if owns:
            c.close()


def write_coverage(path: str, report: Dict[str, Any]) -> str:
    """Write `coverage.json` (LF, UTF-8) and return the path."""
    with open(path, "wb") as fh:
        fh.write((json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    return path


def suggestions(onto: Ontology, table: str, limit: int = 5) -> Sequence[str]:
    """Near-miss table names, for a drift report that says what to look at next."""
    from . import search

    return [h.name for h in search.search(onto, table, kinds=("card",), limit=limit)]


def vocab_source_columns() -> List[str]:
    """Every column a controlled vocabulary claims to have been read from (or `authored`)."""
    return [v.source for v in vocab.vocabularies()]
