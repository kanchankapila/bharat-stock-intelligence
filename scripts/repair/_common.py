"""Shared runner for the AF-20261008-13 history-repair scripts.

Contract (spec 2026-10-08 sub-project B.4): DRY-RUN by default -- only SELECT count(*) runs and
per-table counts are printed. `--apply` performs the writes in ONE transaction, and is refused
(exit 2) unless `--dump-path` names an existing pg_dump file of the affected tables made within
MAX_DUMP_AGE_HOURS. Running with --apply is a production write and NEEDS user approval.

Each script builds a list of Op: the count SQL and the write SQL share the same predicate, so the
dry-run number is the number the write would touch.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "server"))

MAX_DUMP_AGE_HOURS = 24


@dataclass
class Op:
    label: str          # what is printed, e.g. a table name
    verb: str           # delete / update / change / reattribute
    count_sql: str
    apply_sql: str
    params: tuple = ()


def parser(description: str) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument("--apply", action="store_true", help="perform the writes (default: dry-run)")
    ap.add_argument("--dump-path", help="pg_dump -t file of the affected tables, required with --apply")
    return ap


def dump_problem(path: str | None) -> str | None:
    """Why `path` is not an acceptable pre-repair dump, or None if it is."""
    if not path:
        return "--apply requires --dump-path (run pg_dump -t <tables> first)"
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return f"dump file {path!r} does not exist or is empty"
    with open(path, "rb") as f:
        head = f.read(4096)
    # -Fc custom format starts with the magic PGDMP; plain format carries this banner.
    if not (head.startswith(b"PGDMP") or b"PostgreSQL database dump" in head):
        return f"{path!r} does not look like a pg_dump file"
    age_h = (time.time() - os.path.getmtime(path)) / 3600
    if age_h > MAX_DUMP_AGE_HOURS:
        return f"dump {path!r} is {age_h:.0f}h old; take a fresh one (max {MAX_DUMP_AGE_HOURS}h)"
    return None


def table_exists(conn, table: str) -> bool:
    return bool(conn.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?",
        (table,)).fetchall())


def column_exists(conn, table: str, column: str) -> bool:
    return bool(conn.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?",
        (table, column)).fetchall())


def run(args, conn, plan) -> int:
    """Dry-run or apply the ops `plan(conn)` returns as (ops, notes); returns the exit code.
    `conn` None opens a production connection AFTER the --apply refusal check."""
    if args.apply:
        problem = dump_problem(args.dump_path)
        if problem:
            print(f"REFUSED: {problem}")
            return 2
    own = conn is None
    if own:
        from db_compat import connect
        conn = connect()
    try:
        ops, notes = plan(conn)
        for n in notes:
            print(n)
        totals: dict[tuple[str, str], int] = {}
        for op in ops:
            if args.apply:
                n = conn.execute(op.apply_sql, op.params).rowcount
            else:
                n = conn.execute(op.count_sql, op.params).fetchall()[0][0]
            totals[(op.label, op.verb)] = totals.get((op.label, op.verb), 0) + int(n)
        for (label, verb), n in totals.items():
            print(f"{label}: {'would ' + verb if not args.apply else verb + ' (done)'} {n}")
        if args.apply:
            conn.commit()
            print("APPLIED (committed)")
        else:
            conn.rollback()
            print("DRY-RUN: nothing written. Re-run with --apply --dump-path <pg_dump file> to write.")
        return 0
    except Exception:
        conn.rollback()
        raise
    finally:
        if own:
            conn.close()
