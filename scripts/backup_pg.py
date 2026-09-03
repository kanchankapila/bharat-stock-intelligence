"""
backup_pg.py — logical backup/restore for the TimescaleDB instance (P5 hardening).

Uses the running container's own `pg_dump`/`pg_restore` (version-matched to the server)
via `docker exec`, so no local Postgres client install is required. Custom format (-Fc):
compressed, and restorable selectively with pg_restore.

  Backup (default):   python scripts/backup_pg.py
                      -> backups/bharat_intel_YYYYMMDD_HHMMSS.dump  (keeps last N)
                      Only runs within ~90 min of its scheduled 23:15 IST cron_restart fire --
                      pass --force to run it manually at any other time.
  List a dump's TOC:  python scripts/backup_pg.py --list <file>
  Restore (DESTRUCTIVE, requires --yes):
                      python scripts/backup_pg.py --restore <file> --yes

TimescaleDB note: hypertables (stock_ohlcv, feature_store, confluence_signals, ...) must
be restored with the extension in restore-mode, or chunk metadata is corrupted. The
--restore path wraps pg_restore in timescaledb_pre_restore()/_post_restore() automatically,
and drops+recreates the target database rather than using `pg_restore --clean` (the
timescaledb image preloads the extension into every database via template1, and --clean's
DROP EXTENSION + CREATE EXTENSION in one long pg_restore session always fails against a
preloaded extension — see the comment in restore() for the live-verified failure mode).
A plain `pg_restore` of this dump WILL break hypertables — use this script.

Every backup() run is verified (`pg_restore --list` against the dump just written) and
recorded in `job_heartbeat` under 'pg-backup'. Both exist because an unscheduled, unmonitored
backup script is indistinguishable from no backup at all: this file sat in the repo unreferenced
by queues.ts, jobRegistry.ts or ecosystem.config.cjs, so nothing ever ran it and nothing could
have noticed. A dump whose TOC cannot be read is a file, not a backup -- verifying at WRITE time
turns a silent restore-day failure into a same-day alert (dataQualityChecks' 'pg-backup-recency').
"""
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "server"))

CONTAINER = os.environ.get("PG_CONTAINER", "bharat_timescaledb")
PG_USER = os.environ.get("POSTGRES_USER", "bharat")
PG_PASS = os.environ.get("POSTGRES_PASSWORD", "bharat")
PG_DB = os.environ.get("POSTGRES_DB", "bharat_intel")
RETENTION = int(os.environ.get("PG_BACKUP_RETENTION", "7"))
BACKUP_DIR = Path(os.environ.get("PG_BACKUP_DIR") or (Path(__file__).resolve().parent.parent / "backups"))
HEARTBEAT_JOB = "pg-backup"

# A dump on the same disk as the database survives corruption and deletion, not disk loss or
# host loss -- which are the failure modes a single-box deployment actually faces. Set
# PG_BACKUP_DIR to an off-box mount to make this a real backup rather than a local snapshot.

# Target: ecosystem.config.cjs's cron_restart '15 23 * * *' (23:15 IST daily).
_SCHEDULE_IST_HOUR, _SCHEDULE_IST_MINUTE = 23, 15
# 5 min, not generous: pm2's croner fires a cron_restart app at the exact scheduled minute (this
# guard runs before any DB/network work), and the nearest neighbouring job (gf-divergence-daily,
# 22:15 IST) is only 60 min away -- a wider tolerance would let a single off-schedule pm2 restart
# land inside BOTH jobs' acceptance windows at once. See the TS twin's isWithinScheduleWindow
# doc comment (market-calendar/session-calendar.ts) for the full reasoning.
_SCHEDULE_TOLERANCE_MINUTES = 5


def _is_within_schedule_window() -> bool:
    """True near the intended 23:15 IST fire time (see the TS twin of this guard,
    market-calendar's isWithinScheduleWindow, for the live 2026-09-03 incident this fixes:
    a pm2 ecosystem restart at 09:20 IST fired every cron_restart app immediately, including
    this one -- a full pg_dump mid-morning during market hours, blocking a concurrent schema
    migration and every other session's job_heartbeat reads for ~12 minutes)."""
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    target = now_ist.replace(hour=_SCHEDULE_IST_HOUR, minute=_SCHEDULE_IST_MINUTE, second=0, microsecond=0)
    diff_minutes = abs((now_ist - target).total_seconds()) / 60
    return min(diff_minutes, 1440 - diff_minutes) <= _SCHEDULE_TOLERANCE_MINUTES


def _record_heartbeat(ok: bool, detail: str) -> None:
    """Stamp job_heartbeat so an unrun or failing backup is visible to existing monitoring.

    Never raises: a DB blip must not turn a SUCCESSFUL dump into a failed exit code. The dump
    on disk is the thing that matters; the heartbeat is how anyone finds out about it.
    """
    now_ms = int(time.time() * 1000)
    try:
        from db_compat import connect
        conn = connect()
        try:
            conn.execute(
                """INSERT INTO job_heartbeat
                       (job_name, last_status, last_run_at, last_success_at, last_error,
                        run_count, fail_count)
                   VALUES (?, ?, ?, ?, ?, 1, ?)
                   ON CONFLICT (job_name) DO UPDATE SET
                       last_status     = excluded.last_status,
                       last_run_at     = excluded.last_run_at,
                       last_success_at = COALESCE(excluded.last_success_at,
                                                  job_heartbeat.last_success_at),
                       last_error      = excluded.last_error,
                       run_count       = job_heartbeat.run_count + 1,
                       fail_count      = job_heartbeat.fail_count + ?""",
                (HEARTBEAT_JOB, "success" if ok else "failed", now_ms,
                 now_ms if ok else None, None if ok else detail[:2000],
                 0 if ok else 1, 0 if ok else 1),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:                                       # noqa: BLE001
        print(f"[BACKUP] WARNING: could not record heartbeat: {exc}", file=sys.stderr)


def _docker_base(interactive: bool) -> list[str]:
    flag = "-i" if interactive else ""
    cmd = ["docker", "exec"]
    if flag:
        cmd.append(flag)
    cmd += ["-e", f"PGPASSWORD={PG_PASS}", CONTAINER]
    return cmd


def _check_container() -> None:
    r = subprocess.run(
        ["docker", "ps", "--filter", f"name=^{CONTAINER}$", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    if CONTAINER not in r.stdout:
        sys.exit(f"[BACKUP] container '{CONTAINER}' is not running. `docker compose up -d timescaledb` first.")


def backup() -> None:
    if "--force" not in sys.argv[1:] and not _is_within_schedule_window():
        print(
            "[BACKUP] off-schedule invocation (expected ~23:15 IST daily) -- likely a pm2 "
            "registration/restart launch, not the real cron fire. Skipping (pass --force to run manually)."
        )
        return
    _check_container()
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = BACKUP_DIR / f"{PG_DB}_{ts}.dump"

    cmd = _docker_base(interactive=False) + [
        "pg_dump", "-U", PG_USER, "-d", PG_DB, "-Fc", "--no-owner",
    ]
    print(f"[BACKUP] dumping {PG_DB} -> {out.name} ...")
    with open(out, "wb") as fh:
        proc = subprocess.run(cmd, stdout=fh, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        out.unlink(missing_ok=True)
        # Keep the TAIL, not the head: TimescaleDB's circular-FK warnings on its own catalog
        # tables (hypertable/chunk/continuous_agg) are benign boilerplate that pg_dump repeats
        # for every affected table, and they front-load enough text that a head-truncated
        # message cuts off exactly where the real fatal "pg_dump: error: ..." line starts --
        # found 2026-08-27 diagnosing a live 5/31 pg-backup failure rate: job_heartbeat's
        # stored error read "...pg_dump: er" with the actual cause never recorded anywhere.
        stderr_text = proc.stderr.decode(errors='replace')
        msg = f"pg_dump failed: {stderr_text[-2000:]}"
        _record_heartbeat(False, msg)
        sys.exit(f"[BACKUP] {msg}")

    size_mb = out.stat().st_size / 1_048_576

    # Verify at WRITE time. pg_dump can exit 0 having produced a truncated file (disk filling
    # mid-write is the realistic case on a single box), and a dump whose TOC cannot be read is
    # a file, not a backup. Reading it back is the only check that distinguishes the two, and
    # restore day is the worst possible moment to find out.
    ok, toc_err = _verify_dump(out)
    if not ok:
        out.unlink(missing_ok=True)
        msg = f"dump failed verification and was deleted (corrupt/truncated): {toc_err[:1000]}"
        _record_heartbeat(False, msg)
        sys.exit(f"[BACKUP] {msg}")

    print(f"[BACKUP] wrote {out} ({size_mb:.1f} MB), TOC verified")
    _prune()
    _record_heartbeat(True, f"{out.name} ({size_mb:.1f} MB)")


def _verify_dump(path: Path) -> tuple[bool, str]:
    """True when pg_restore can read the dump's table of contents."""
    cmd = _docker_base(interactive=True) + ["pg_restore", "--list"]
    with open(path, "rb") as fh:
        r = subprocess.run(cmd, stdin=fh, capture_output=True, text=True)
    if r.returncode != 0:
        return False, r.stderr
    if "TABLE DATA" not in r.stdout:
        return False, "TOC readable but contains no TABLE DATA entries — dump is effectively empty"
    return True, ""


def _prune() -> None:
    dumps = sorted(BACKUP_DIR.glob(f"{PG_DB}_*.dump"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in dumps[RETENTION:]:
        old.unlink()
        print(f"[BACKUP] pruned old backup {old.name}")


def list_toc(path: str) -> None:
    _check_container()
    p = Path(path)
    if not p.exists():
        sys.exit(f"[BACKUP] no such file: {path}")
    cmd = _docker_base(interactive=True) + ["pg_restore", "--list"]
    with open(p, "rb") as fh:
        r = subprocess.run(cmd, stdin=fh, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"[BACKUP] pg_restore --list failed (corrupt dump?):\n{r.stderr}")
    print(r.stdout)


def restore(path: str) -> None:
    _check_container()
    p = Path(path)
    if not p.exists():
        sys.exit(f"[BACKUP] no such file: {path}")

    # Drop and recreate the database rather than `pg_restore --clean` on top of it. The
    # timescaledb Docker image installs the extension into template1, so every database on
    # this container -- fresh or existing -- already has it. --clean's DROP EXTENSION then
    # CREATE EXTENSION run inside ONE long-lived pg_restore session, but TimescaleDB's .so is
    # already loaded into that backend at fork time (shared_preload_libraries) and requires
    # CREATE EXTENSION to be the literal first statement of a *fresh* session -- so the
    # CREATE EXTENSION always fails ("already been loaded with another version"),
    # _timescaledb_internal (just dropped by the CASCADE) is never recreated, and every
    # compressed-hypertable chunk table restore fails with "schema does not exist".
    # Live-verified 2026-08-20: the naive --clean restore aborted with 7-8 errors and
    # post_restore() itself then failed non-zero. DROP+CREATE DATABASE (the new DB still gets
    # the extension via template1) plus a plain pg_restore with no --clean restores cleanly:
    # 215/215 tables, 24/24 hypertables, exact row-count match against the source. This is
    # also just what "restore" should mean for a script already gated behind --yes as
    # DESTRUCTIVE -- replace the database outright, not patch objects inside it.
    maint = _docker_base(interactive=False) + ["psql", "-U", PG_USER, "-d", "postgres", "-c"]
    print(f"[RESTORE] dropping and recreating database {PG_DB} ...")
    subprocess.run(maint + [f"DROP DATABASE IF EXISTS {PG_DB} WITH (FORCE);"], check=True)
    subprocess.run(maint + [f"CREATE DATABASE {PG_DB};"], check=True)

    psql = _docker_base(interactive=False) + ["psql", "-U", PG_USER, "-d", PG_DB, "-c"]
    print("[RESTORE] timescaledb_pre_restore() ...")
    subprocess.run(psql + ["SELECT timescaledb_pre_restore();"], check=True)

    print(f"[RESTORE] pg_restore {p.name} ...")
    cmd = _docker_base(interactive=True) + ["pg_restore", "-U", PG_USER, "-d", PG_DB, "--no-owner"]
    with open(p, "rb") as fh:
        r = subprocess.run(cmd, stdin=fh, stderr=subprocess.PIPE)
    if r.returncode != 0:
        print(f"[RESTORE] pg_restore reported issues:\n{r.stderr.decode(errors='replace')[:2000]}")

    print("[RESTORE] timescaledb_post_restore() ...")
    subprocess.run(psql + ["SELECT timescaledb_post_restore();"], check=True)
    print("[RESTORE] done.")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args == ["--force"]:
        backup()
    elif args[0] == "--list" and len(args) == 2:
        list_toc(args[1])
    elif args[0] == "--restore" and len(args) >= 2:
        if "--yes" not in args:
            sys.exit("[RESTORE] refusing to overwrite the live DB without --yes.")
        restore(args[1])
    else:
        sys.exit(__doc__)
