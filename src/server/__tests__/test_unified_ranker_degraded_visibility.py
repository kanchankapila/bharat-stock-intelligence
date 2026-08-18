"""Regression test: a degraded read/write in UnifiedRanker must be visible, not just logged to
a stdout line nobody watches.

Before this fix, every one of ~30 read methods printed its failure to STDOUT on exception. But
pythonRunner.ts's runPython() only treats STDERR content as a signal -- it's the sole condition
under which a "successful" (exit 0) run gets logged as `log.warn('... finished successfully
with warnings/stderr output', ...)`. A run that silently degraded to Hold-everywhere (the
2026-08-17 stock_event_triggers incident) still reported success with nothing to grep for.

self._degraded() routes every one of those messages to stderr and counts them, so (a) the
existing pythonRunner.ts hook now actually fires, and (b) run()'s own JSON output carries a
`degraded_count` field. See recurring-bugs.md's "except Exception: pass does NOT contain the
failure on Postgres" entry.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from unified_ranker import UnifiedRanker


class _BrokenConn:
    """Every query raises; rollback is a no-op, matching a real conn's contract."""
    def execute(self, sql, params=()):
        raise RuntimeError("table does not exist")

    def rollback(self):
        pass


def test_degraded_writes_to_stderr_not_stdout(capsys):
    r = UnifiedRanker(conn=_BrokenConn())
    r._degraded("[UnifiedRanker] test message")
    captured = capsys.readouterr()
    assert captured.out == "", "must not print to stdout -- pythonRunner.ts never inspects it"
    assert "[UnifiedRanker] test message" in captured.err


def test_degraded_increments_counter():
    r = UnifiedRanker(conn=_BrokenConn())
    assert r._degraded_count == 0
    r._degraded("[UnifiedRanker] one")
    r._degraded("[UnifiedRanker] two")
    assert r._degraded_count == 2


def test_a_failed_read_method_counts_itself_as_degraded(capsys):
    """Negative control: this fails before the except block calls self._degraded()."""
    r = UnifiedRanker(conn=_BrokenConn())
    result = r._get_sector_map()
    assert result == {}, "still degrades to the same empty fallback -- behaviour unchanged"
    assert r._degraded_count == 1
    assert "_get_sector_map failed" in capsys.readouterr().err
