"""Bounded, parallel sequence loading for the DL trainer.

Extracted from `dl_engine.train_lstm()`'s inline loop after dl-retrain-weekly ran 14h48m on
2026-09-05 and produced nothing before being killed (AF-20260906-01).

It was not hung: 409,277 seconds of CPU across 14.8 wall-clock hours. It was not
compute-bound either -- the GPU sat at 15-24% while ~8 CPU cores were pegged. The training
loop was loading its data with one serial Postgres round-trip per symbol across ~2,300
symbols, so the GPU spent almost all of its time waiting on the database.

Kept as its own module rather than a method on the engine so it can be tested without
importing torch (dl_engine pulls in CUDA at import time, which makes a fast unit test
impossible) and without a database.
"""
from __future__ import annotations

import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Iterable, Iterator, Optional, TypeVar

T = TypeVar("T")

# Deliberately small. read_df() takes a pooled SQLAlchemy connection per call, so each worker
# holds one for the duration of its query, and this process shares `max_connections` with
# bharat-server, ml-api, alphaquant, chatbot and the test suite. recurring-bugs.md records a
# real incident where a pool sized for the production server was wrong inside another process
# and surfaced as unexplained timeouts rather than as connection errors. Four workers is enough
# to hide query latency behind each other without moving that budget meaningfully.
DEFAULT_MAX_WORKERS = 4


def load_sequences_bounded(
    symbols: Iterable[str],
    loader: Callable[[str], Optional[T]],
    max_workers: int = DEFAULT_MAX_WORKERS,
    deadline: Optional[float] = None,
) -> Iterator[T]:
    """Yield each symbol's loaded sequences, in completion order, skipping failures.

    `deadline` is a `time.monotonic()` timestamp. Past it, no further symbols are submitted and
    whatever has already loaded is yielded. That bound is the point: `train_lstm()` is called
    IN-PROCESS by `dl_trainer.py`, so `_run()`'s 1800s subprocess cap does not apply to it and
    nothing bounded it except the 24h BullMQ lock. Degrading to "train on the symbols that
    loaded" is strictly better than being killed with nothing to show -- which is exactly what
    happened on 2026-09-05.

    A symbol that raises is skipped rather than aborting the pass: one bad symbol must not cost
    the other 2,299. A loader returning None (or anything falsy) is treated as "no usable
    history" and dropped here, so callers do not filter twice.
    """
    symbols = list(symbols)
    if not symbols:
        return

    skipped = 0

    # The deadline is checked INSIDE each task, not around the submit loop. Submitting 2,300
    # futures takes microseconds while executing them takes hours, so a check around submission
    # would always pass and the bound would never fire -- the first version of this did exactly
    # that and the test caught it.
    _SKIPPED = object()

    def _guarded(sym: str):
        if deadline is not None and time.monotonic() >= deadline:
            return _SKIPPED
        return loader(sym)

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_guarded, sym): sym for sym in symbols}

        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                result = fut.result()
            except Exception as e:
                print(f"[DL] Skip {sym}: {e}", file=sys.stderr)
                continue
            if result is _SKIPPED:
                skipped += 1
                continue
            if result is None:
                continue
            # numpy arrays are ambiguous in a boolean context, so length is checked explicitly
            # rather than relying on truthiness -- `if result:` raises ValueError on an ndarray.
            if hasattr(result, "__len__") and len(result) == 0:
                continue
            yield result

    if skipped:
        print(
            f"[DL] Load deadline reached -- {skipped} of {len(symbols)} symbols not loaded "
            f"this run; training on what did load rather than running to the 24h kill.",
            file=sys.stderr,
        )
