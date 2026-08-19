"""
backup_pg.py — logical backup/restore for the TimescaleDB instance (P5 hardening).

Uses the running container's own `pg_dump`/`pg_restore` (version-matched to the server)
via `docker exec`, so no local Postgres client install is required. Custom format (-Fc):
compressed, and restorable selectively with pg_restore.

  Backup (default):   python scripts/backup_pg.py
                      -> backups/bharat_intel_YYYYMMDD_HHMMSS.dump  (keeps last N)
  List a dump's TOC:  python scripts/backup_pg.py --list <file>
  Restore (DESTRUCTIVE, requires --yes):
                      python scripts/backup_pg.py --restore <file> --yes

TimescaleDB note: hypertables (stock_ohlcv, feature_store, confluence_signals, ...) must
be restored with the extension in restore-mode, or chunk metadata is corrupted. The
--restore path wraps pg_restore in timescaledb_pre_restore()/_post_restore() automatically.
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
from datetime import datetime
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
        msg = f"pg_dump failed: {proc.stderr.decode(errors='replace')[:1000]}"
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

    psql = _docker_base(interactive=False) + ["psql", "-U", PG_USER, "-d", PG_DB, "-c"]
    print("[RESTORE] timescaledb_pre_restore() ...")
    subprocess.run(psql + ["SELECT timescaledb_pre_restore();"], check=True)

    print(f"[RESTORE] pg_restore {p.name} (clean, if-exists) ...")
    cmd = _docker_base(interactive=True) + [
        "pg_restore", "-U", PG_USER, "-d", PG_DB, "--clean", "--if-exists", "--no-owner",
    ]
    with open(p, "rb") as fh:
        r = subprocess.run(cmd, stdin=fh, stderr=subprocess.PIPE)
    # pg_restore returns non-zero on benign --clean DROP warnings; surface stderr but continue to post_restore.
    if r.returncode != 0:
        print(f"[RESTORE] pg_restore reported issues (often benign DROP-IF-EXISTS warnings):\n"
              f"{r.stderr.decode(errors='replace')[:2000]}")

    print("[RESTORE] timescaledb_post_restore() ...")
    subprocess.run(psql + ["SELECT timescaledb_post_restore();"], check=True)
    print("[RESTORE] done.")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        backup()
    elif args[0] == "--list" and len(args) == 2:
        list_toc(args[1])
    elif args[0] == "--restore" and len(args) >= 2:
        if "--yes" not in args:
            sys.exit("[RESTORE] refusing to overwrite the live DB without --yes.")
        restore(args[1])
    else:
        sys.exit(__doc__)
