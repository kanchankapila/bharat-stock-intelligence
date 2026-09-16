"""Unit tests for the MCP tool-input guards (2026-09-13 review, H2/M2).

market_intelligence_mcp.py hands agent-supplied strings to subprocess argv and file
paths. These tests pin the identifier guard: a name containing a path separator or a
leading '-' must be rejected BEFORE any filesystem check or subprocess spawn, and the
misleading requeue_dlq tool must stay retired (it relabelled DLQ rows and reported
{"requeued": N} while nothing consumes that table's status values).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "mcp"))

import market_intelligence_mcp as mcp  # noqa: E402


def test_identifier_guard_rejects_traversal():
    assert mcp._require_identifier("../evil", "fetcher_name") is not None
    assert mcp._require_identifier("a/b", "fetcher_name") is not None
    assert mcp._require_identifier("..", "fetcher_name") is not None
    assert mcp._require_identifier("-flag", "fetcher_name") is not None
    assert mcp._require_identifier("", "fetcher_name") is not None
    assert mcp._require_identifier(None, "fetcher_name") is not None


def test_identifier_guard_accepts_plain_names():
    assert mcp._require_identifier("fii_dii_fetcher", "fetcher_name") is None
    assert mcp._require_identifier("win_probability", "score_col") is None


def test_run_fetcher_rejects_traversal_before_any_fs_or_spawn(monkeypatch):
    # If the guard ever stops firing first, these would reach os.path.exists/subprocess —
    # make any such attempt explode the test instead of silently passing.
    monkeypatch.setattr(mcp.os.path, "exists",
                        lambda p: (_ for _ in ()).throw(AssertionError("fs touched")))
    called = {"n": 0}

    class _Boom:
        def __call__(self, *a, **k):
            called["n"] += 1
            raise AssertionError("subprocess spawned")

    monkeypatch.setattr(mcp.subprocess, "run", _Boom())
    res = mcp.run_fetcher("../evil")
    assert res["success"] is False
    assert "Invalid fetcher_name" in res["error"]
    assert called["n"] == 0


def test_run_fetcher_rejects_flag_smuggling_param_names(monkeypatch):
    monkeypatch.setattr(mcp.os.path, "exists", lambda p: True)
    monkeypatch.setattr(mcp.subprocess, "run",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("spawned")))
    res = mcp.run_fetcher("zzz_nonexistent_fetcher", params={"dry-run --evil": "1"})
    assert res["success"] is False
    assert "Invalid param name" in res["error"]


def test_requeue_dlq_stays_retired():
    # The DLQ table keeps no reconstructable payload and nothing consumes its status
    # values; the tool must refuse rather than relabel rows and claim "requeued".
    res = mcp.requeue_dlq()
    assert res["success"] is False
    assert "retired" in res["error"]


def test_run_alphaquant_backtest_rejects_bad_factor_and_date():
    res = mcp.run_alphaquant_backtest("../../evil", "2023-01-01")
    assert res["success"] is False and "Invalid factor" in res["error"]
    res = mcp.run_alphaquant_backtest("value_book_to_price", "not-a-date")
    assert res["success"] is False and "Invalid start_date" in res["error"]
