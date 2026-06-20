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
"""
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

CONTAINER = os.environ.get("PG_CONTAINER", "bharat_timescaledb")
PG_USER = os.environ.get("POSTGRES_USER", "bharat")
PG_PASS = os.environ.get("POSTGRES_PASSWORD", "bharat")
PG_DB = os.environ.get("POSTGRES_DB", "bharat_intel")
RETENTION = int(os.environ.get("PG_BACKUP_RETENTION", "7"))
BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups"


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
    BACKUP_DIR.mkdir(exist_ok=True)
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
        sys.exit(f"[BACKUP] pg_dump failed:\n{proc.stderr.decode(errors='replace')}")

    size_mb = out.stat().st_size / 1_048_576
    print(f"[BACKUP] wrote {out} ({size_mb:.1f} MB)")
    _prune()


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
