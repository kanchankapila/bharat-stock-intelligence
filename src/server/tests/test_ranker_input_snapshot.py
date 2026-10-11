"""ranker_input_snapshot.py: nightly immutable, point-in-time copy of what unified_ranker.py read.

Runs against the full production schema in a throwaway Postgres schema (pg_db_conn), so every
input query is checked against real column names, and nothing touches production."""
import hashlib
import json
import math
import os
import stat
import sys

import polars as pl
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ranker_input_snapshot as ris

RUN_DATE = "2026-10-12"                       # the ranker's computed_at label (next session)
GENERATED_AT = "2026-10-09 17:00:02+00"       # 22:30 IST Friday: the ranker's real run time


def _seed(conn):
    conn.execute(
        "INSERT INTO unified_recommendations (symbol, computed_at, generated_at, unified_score, regime, conviction_level) "
        "VALUES ('AAA', ?, ?, 61.0, 'BULL', 'HIGH'), ('BBB', ?, ?, 40.0, 'BULL', 'LOW')",
        (RUN_DATE, GENERATED_AT, RUN_DATE, GENERATED_AT))
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, signal_score, hv_20d, cmp) VALUES "
        "('AAA', '2026-10-09', 'NaN'::float8, 6.5, 'Infinity'::float8, 100.0), "
        "('BBB', '2026-10-09', 0.61, 4.0, 0.22, 50.0), "
        # after the ranker ran: a point-in-time copy must not contain it
        "('AAA', '2026-10-12', 0.99, 9.9, 0.10, 101.0)")
    conn.execute("INSERT INTO stock_scores (symbol, timeframe, score) VALUES ('AAA', 'long_term', 70)")
    conn.execute("INSERT INTO nse_stocks (symbol, name, sector) VALUES ('AAA', 'A Ltd', 'IT'), ('BBB', 'B Ltd', 'Banks')")
    conn.execute(
        "INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) VALUES "
        "('AAA', '2026-10-08', 99, 101, 98, 99.5, 1000), ('AAA', '2026-10-09', 100, 102, 99, 100.0, 2000)")
    conn.commit()


def _sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def _run(out_dir, *extra):
    return ris.main(["--date", RUN_DATE, "--out-dir", str(out_dir), *extra])


def test_end_to_end_manifest_hashes_match_files_and_persist_writes_one_row(pg_db_conn, tmp_path):
    _seed(pg_db_conn)
    assert _run(tmp_path, "--persist") == 0

    day = tmp_path / RUN_DATE
    manifest = json.loads((day / "manifest.json").read_text())
    assert manifest["date"] == RUN_DATE
    assert manifest["ranker_generated_at"].startswith("2026-10-09")
    assert manifest["git_commit"]
    written = {n: t for n, t in manifest["tables"].items() if t["status"] == "ok"}
    assert {"technical_signals", "stock_scores", "nse_stocks", "stock_ohlcv_summary"} <= set(written)
    for name, t in written.items():
        f = day / t["file"]
        assert _sha(f) == t["sha256"], name
        assert not os.stat(f).st_mode & stat.S_IWRITE, f"{name} must be read-only"
        assert pl.read_parquet(f).height == t["rows"]

    ts = pl.read_parquet(day / "technical_signals.parquet")
    assert ts.height == 2, "the row dated after the ranker's run leaked into the snapshot"
    ohlcv = pl.read_parquet(day / "stock_ohlcv_summary.parquet").filter(pl.col("symbol") == "AAA")
    assert ohlcv["last_close"][0] == 100.0

    row = pg_db_conn.execute(
        "SELECT value FROM app_settings WHERE key = 'ranker_input_snapshot_last'").fetchone()
    persisted = json.loads(row["value"])
    assert persisted["date"] == RUN_DATE
    assert persisted["rows"] == sum(t["rows"] for t in written.values())
    assert persisted["bytes"] > 0 and persisted["tables"] == len(written)


def test_nan_and_inf_survive_the_round_trip(pg_db_conn, tmp_path):
    _seed(pg_db_conn)
    assert _run(tmp_path) == 0
    ts = pl.read_parquet(tmp_path / RUN_DATE / "technical_signals.parquet").filter(pl.col("symbol") == "AAA")
    assert math.isnan(ts["win_probability"][0]), "NaN became NULL or 0"
    assert math.isinf(ts["hv_20d"][0])


def test_second_run_is_a_noop_and_changes_nothing(pg_db_conn, tmp_path, capsys):
    _seed(pg_db_conn)
    assert _run(tmp_path) == 0
    day = tmp_path / RUN_DATE
    before = {p.name: (_sha(p), p.stat().st_mtime_ns) for p in day.iterdir()}
    pg_db_conn.execute("UPDATE stock_scores SET score = 1 WHERE symbol = 'AAA'")   # later mutation
    pg_db_conn.commit()
    assert _run(tmp_path) == 0
    assert "already exists" in capsys.readouterr().out
    assert {p.name: (_sha(p), p.stat().st_mtime_ns) for p in day.iterdir()} == before


def test_force_rewrites_and_keeps_the_superseded_copy(pg_db_conn, tmp_path):
    _seed(pg_db_conn)
    assert _run(tmp_path) == 0
    old_manifest = (tmp_path / RUN_DATE / "manifest.json").read_text()
    assert _run(tmp_path, "--force") == 0
    superseded = [p for p in tmp_path.iterdir() if p.name.startswith(f"{RUN_DATE}.superseded.")]
    assert len(superseded) == 1
    assert (superseded[0] / "manifest.json").read_text() == old_manifest
    assert (tmp_path / RUN_DATE / "manifest.json").exists()


def test_missing_optional_table_is_recorded_absent_and_does_not_abort(pg_db_conn, tmp_path):
    _seed(pg_db_conn)
    specs = ris.INPUTS + [ris.Spec("ghost", "SELECT symbol FROM no_such_table_xyz", optional=True,
                                   why="test-only")]
    res = ris.snapshot(pg_db_conn, RUN_DATE, tmp_path, specs=specs)
    t = res["manifest"]["tables"]
    assert t["ghost"]["status"] == "absent"
    assert t["technical_signals"]["status"] == "ok"
    assert not (tmp_path / RUN_DATE / "ghost.parquet").exists()


def test_missing_required_table_aborts_and_writes_nothing(pg_db_conn, tmp_path):
    _seed(pg_db_conn)
    specs = [ris.Spec("ghost", "SELECT symbol FROM no_such_table_xyz", optional=False, why="test-only")]
    with pytest.raises(Exception):
        ris.snapshot(pg_db_conn, RUN_DATE, tmp_path, specs=specs)
    assert list(tmp_path.iterdir()) == []


def test_size_guard_fails_loudly_above_the_cap_and_writes_nothing(pg_db_conn, tmp_path):
    _seed(pg_db_conn)
    with pytest.raises(ris.SnapshotTooLarge):
        ris.snapshot(pg_db_conn, RUN_DATE, tmp_path, max_mb=0.000001)
    assert list(tmp_path.iterdir()) == []
    assert _run(tmp_path, "--max-mb", "0.000001") != 0


def test_every_input_names_why_the_ranker_reads_it():
    names = [s.name for s in ris.INPUTS]
    assert len(names) == len(set(names))
    for s in ris.INPUTS:
        assert s.why.strip(), s.name
        assert "SELECT *" not in s.sql.upper() or s.name == "feature_store", s.name
