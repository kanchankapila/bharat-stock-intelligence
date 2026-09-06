"""Bounded, parallel sequence loading for the DL trainer.

Why: dl-retrain-weekly ran 14h48m on 2026-09-05 and produced nothing before being killed
(AF-20260906-01). It was not hung -- 409,277s of CPU across 14.8 wall-clock hours -- and it was
not compute-bound: the GPU sat at 15-24% while ~8 CPU cores were pegged. `train_lstm()` loads
training data with ONE serial Postgres round-trip per symbol across ~2,300 symbols, so the GPU
spent its time waiting on the database.

Three defects, all addressed by this loader:

  1. Serial I/O where the work is I/O-bound. read_df() takes a pooled connection per call and
     releases it, so a small thread pool is safe and stays inside the Python connection budget
     recorded in pgClient.ts's comment. Workers are capped deliberately low for that reason --
     recurring-bugs.md's "connection-pool max sized for the production server is wrong inside
     another process" was a real incident here.
  2. No time bound. train_lstm() is invoked IN-PROCESS by dl_trainer, so _run()'s 1800s
     subprocess cap does not apply to it and nothing bounded it but the 24h BullMQ lock. A
     training job should degrade to "train on what loaded" rather than run until it is killed.
  3. One symbol's failure must never abort the pass -- the old loop's per-symbol try/except was
     right about that and is preserved.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dl_sequence_loader import load_sequences_bounded


def test_loads_every_symbol_when_nothing_fails():
    seen = []
    def loader(sym):
        seen.append(sym)
        return f"data-{sym}"
    out = list(load_sequences_bounded(["A", "B", "C"], loader, max_workers=2))
    assert sorted(out) == ["data-A", "data-B", "data-C"]
    assert sorted(seen) == ["A", "B", "C"]


def test_a_failing_symbol_is_skipped_not_fatal():
    """A single bad symbol must not cost the whole 2,300-symbol pass."""
    def loader(sym):
        if sym == "BAD":
            raise ValueError("no rows")
        return f"data-{sym}"
    out = list(load_sequences_bounded(["A", "BAD", "C"], loader, max_workers=2))
    assert sorted(out) == ["data-A", "data-C"]


def test_empty_results_are_dropped():
    """load_symbol_sequences returns an empty array for a symbol with no usable history;
    carrying those forward just makes the caller filter them again."""
    def loader(sym):
        return None if sym == "EMPTY" else f"data-{sym}"
    assert list(load_sequences_bounded(["EMPTY", "A"], loader, max_workers=2)) == ["data-A"]


def test_stops_early_once_the_deadline_passes():
    """The bound that would have turned a 14h48m run into a bounded one."""
    def slow(sym):
        time.sleep(0.05)
        return f"data-{sym}"
    symbols = [f"S{i}" for i in range(200)]
    started = time.monotonic()
    out = list(load_sequences_bounded(symbols, slow, max_workers=2,
                                      deadline=time.monotonic() + 0.3))
    elapsed = time.monotonic() - started
    assert len(out) < len(symbols), "must stop before loading everything"
    assert out, "must still return what it managed to load"
    assert elapsed < 5.0, f"must not run to completion regardless of deadline ({elapsed:.1f}s)"


def test_no_deadline_means_load_everything():
    out = list(load_sequences_bounded(["A", "B"], lambda s: f"data-{s}", max_workers=2))
    assert len(out) == 2


def test_parallelism_actually_overlaps_io():
    """Negative control on the whole point of the change: if this ran serially the elapsed time
    would be ~8x the per-item sleep, not ~2x."""
    def slow(sym):
        time.sleep(0.1)
        return sym
    symbols = [f"S{i}" for i in range(8)]
    t0 = time.monotonic()
    out = list(load_sequences_bounded(symbols, slow, max_workers=4))
    elapsed = time.monotonic() - t0
    assert len(out) == 8
    assert elapsed < 0.6, f"4 workers over 8 x 0.1s should be ~0.2s, got {elapsed:.2f}s"
