"""The CLI is the documented entry point; its exit codes are the contract.

A CI job cannot read a printed "OK". `python -m ontology verify` must return non-zero on
drift, `export` must not half-succeed, and the query surfaces must work without a database
(the ontology is static, so a laptop with Postgres down should still be able to read it).
"""
import os
import subprocess
import sys

import pytest

SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from ontology import build_ontology  # noqa: E402
from ontology.cli import main  # noqa: E402


def _run(*args):
    return subprocess.run(
        [sys.executable, "-m", "ontology", *args],
        cwd=SERVER_DIR, capture_output=True, text=True, timeout=180,
    )


def test_verify_exits_zero():
    proc = _run("verify")
    assert proc.returncode == 0, proc.stderr
    assert "OK" in proc.stdout or "no integrity" in proc.stdout


def test_stats_reports_counts():
    proc = _run("stats")
    assert proc.returncode == 0, proc.stderr
    assert "classes" in proc.stdout


def test_export_writes_everything(tmp_path):
    proc = _run("export", "--out", str(tmp_path))
    assert proc.returncode == 0, proc.stderr
    names = {p.name for p in tmp_path.iterdir()}
    assert {"ontology.ttl", "ontology.jsonld", "ontology.shacl.ttl", "manifest.json"} <= names


def test_export_to_a_missing_directory_fails_cleanly(tmp_path):
    proc = _run("export", "--out", str(tmp_path / "nope" / "deeper"))
    # Either it creates the path or it reports the error — it must not traceback.
    assert "Traceback" not in proc.stderr, proc.stderr


def test_the_query_surfaces_need_no_database(monkeypatch):
    """`ask`/`context`/`card`/`show` read the static definitions, not Postgres.

    Forcing the DB unavailable proves the layer is usable as documentation even when the
    database is down — which is exactly when someone needs to read the caveats.
    """
    import db_compat

    def _boom(*a, **k):
        raise RuntimeError("database intentionally unavailable")

    monkeypatch.setattr(db_compat, "connect", _boom)
    monkeypatch.setattr(db_compat, "query_all", _boom)
    onto = build_ontology()
    assert onto.validate() == []
    from ontology.cli import cmd_ask, cmd_card, cmd_context, cmd_show

    import argparse

    ns = argparse.Namespace(query="delivery", limit=5, max_chars=800)
    assert cmd_ask(onto, ns) == 0
    assert cmd_context(onto, ns) == 0
    assert cmd_card(onto, argparse.Namespace(table="block_deals")) == 0
    assert cmd_show(onto, argparse.Namespace(name="close_price")) == 0


def test_unknown_command_is_a_usage_error():
    proc = _run("definitely-not-a-command")
    assert proc.returncode != 0
    assert "invalid choice" in proc.stderr or "usage" in proc.stderr


def test_show_of_an_unknown_concept_is_reported():
    proc = _run("show", "NoSuchConcept")
    # A miss is a legitimate answer, not a crash; the message must say so.
    assert proc.returncode in (0, 1)
    assert "Traceback" not in proc.stderr


def test_standards_command_lists_licenses():
    proc = _run("standards")
    assert proc.returncode == 0
    for expected in ("SKOS", "FIBO", "QUDT"):
        assert expected in proc.stdout, expected
