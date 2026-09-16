"""Regression tests for two 2026-08-10 accuracy-review fixes.

1. unified_recommendations.generated_at
   computed_at is a bare DATE and the upsert key is (symbol, computed_at), so a manual
   same-day re-run silently replaced that morning's 07:30 IST cron row. Nothing recorded WHEN
   a row was produced, so a genuine pre-market signal and a post-close re-run were
   indistinguishable -- which makes the canonical ranking table ungradeable, because grading a
   session against a row that may have been computed after that session closed is look-ahead.

2. densify_feature_matrix.NEVER_FILL
   The set existed to stop a stale model output being carried forward and presented as a
   prediction that was never made -- but it enumerated only 3 of the 7 model-output columns
   technical_signals actually carries. flyer_probability (populated on exactly ONE date, and
   backtested at a significantly NEGATIVE -0.20%/day, t=-5.36) was a live candidate to be
   smeared across the whole grid.
"""
import os
import re
import sys

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

RANKER_SRC = open(os.path.join(SERVER_DIR, "unified_ranker.py"), encoding="utf-8").read()


# ── 1. generated_at is actually wired through the write path ──────────────────

def _insert_block():
    """The unified_recommendations INSERT ... ON CONFLICT statement, as source text."""
    m = re.search(r"INSERT INTO unified_recommendations(.*?)'''", RANKER_SRC, re.S)
    assert m, "could not locate the unified_recommendations INSERT"
    return m.group(1)


def test_generated_at_present_in_insert_columns_values_and_conflict_update():
    """All three must agree. A column named in the INSERT list but missing from VALUES (or
    vice versa) is an immediate runtime failure of the daily ranker, not a silent degradation.
    """
    block = _insert_block()
    cols, values = block.split("VALUES", 1)
    conflict = values.split("DO UPDATE SET", 1)[1]

    assert "generated_at" in cols, "generated_at missing from the INSERT column list"
    assert ":generated_at" in values, "generated_at missing from the VALUES bind list"
    assert "generated_at=excluded.generated_at" in conflict, (
        "generated_at not refreshed on conflict -- a re-run would keep the FIRST run's "
        "timestamp and label a post-close re-run as pre-market, which is the exact defect "
        "this column exists to expose")


def test_run_stamps_one_timestamp_per_run_not_per_row():
    """One run is one generation event. A per-row now() would imply precision that does not
    exist and would make 'was this snapshot pre-market' answerable only per-row."""
    # Accepts either the bare clock read or the collision-safe helper that replaced it
    # (_next_generated_at, added 2026-08-15). What matters here is that ONE run-level UTC
    # timestamp is assigned once -- not which source produced it.
    #
    # The helper exists because datetime.now()'s resolution is the system clock tick (0.015625 s
    # on Windows; 2000 back-to-back calls return ONE distinct value), so two runs inside that
    # window shared a generated_at and unified_recommendations_history's
    # `ON CONFLICT(symbol, generated_at) DO NOTHING` silently discarded the second snapshot.
    # See _next_generated_at()'s docstring in unified_ranker.py.
    assert re.search(
        r"generated_at\s*=\s*(datetime\.now\(timezone\.utc\)|_next_generated_at\(\))",
        RANKER_SRC,
    ), "expected a single run-level UTC timestamp"
    # Bound to the row dict, not recomputed inside the results loop.
    assert "'generated_at':            generated_at" in RANKER_SRC or \
           re.search(r"'generated_at':\s+generated_at", RANKER_SRC), \
        "row dict must reuse the run-level timestamp"
    assert "datetime.now" not in _insert_block(), \
        "timestamp must not be recomputed inside the INSERT"


def test_generated_at_is_not_part_of_the_upsert_key():
    """Adding it to the key would create multiple snapshots per day and silently change what
    'the latest snapshot' means for every consumer of this table."""
    assert "ON CONFLICT(symbol, computed_at)" in RANKER_SRC, \
        "upsert key changed -- every consumer's 'latest snapshot' semantics depend on it"


# ── 2. NEVER_FILL covers every model output ──────────────────────────────────

# Columns in technical_signals that are a MODEL'S PREDICTION rather than an observed or
# vendor-supplied quantity. Carrying any of these forward fabricates a prediction.
MODEL_OUTPUT_COLUMNS = [
    "win_probability",
    "calibrated_win_probability",
    "breakout_probability",
    "flyer_probability",
    "movement_probability",
    "pead_score",
    "cs_score",
]


@pytest.mark.parametrize("col", MODEL_OUTPUT_COLUMNS)
def test_model_output_is_never_forward_filled(col):
    from densify_feature_matrix import NEVER_FILL
    assert col in NEVER_FILL, (
        f"{col} is a model prediction but may be forward-filled; a day its producer fails "
        f"would have the last prediction carried forward and presented as if made on each "
        f"of those days")


def test_never_fill_still_protects_prices_and_bookkeeping():
    """Guard against someone 'tidying' the set and dropping the original members."""
    from densify_feature_matrix import NEVER_FILL
    for col in ("close", "open", "high", "low", "volume", "symbol", "date",
                "enrichment_ffill_age_days"):
        assert col in NEVER_FILL, f"{col} dropped from NEVER_FILL"


def test_flyer_classifier_records_its_negative_verdict():
    """flyer_probability's purged-OOF AUC is 0.81, which reads as excellent and is a trap:
    ranking by it is significantly NEGATIVE (-0.20%/day, t=-5.36 at 0.15% cost). The verdict
    must stay next to the AUC so nobody wires it into unified_ranker on the AUC alone."""
    src = open(os.path.join(SERVER_DIR, "flyer_classifier.py"), encoding="utf-8").read()
    assert "DO NOT WIRE THIS IN" in src
    assert "t=-5.36" in src, "the measured verdict must stay in the docstring"


def test_flyer_classifier_is_not_scheduled():
    """It writes an ML feature column with measured-negative alpha; scheduling it would spend
    daily compute to keep an anti-predictive column fresh."""
    root = os.path.join(SERVER_DIR, "..", "..")
    hits = []
    for rel in ["src/server/queues.ts"] + [
        os.path.join("src/server/jobs", f)
        for f in os.listdir(os.path.join(root, "src/server/jobs"))
        if f.endswith(".ts")
    ]:
        p = os.path.join(root, rel)
        if os.path.exists(p) and "flyer_classifier" in open(p, encoding="utf-8").read():
            hits.append(rel)
    assert not hits, f"flyer_classifier.py became scheduled in {hits} despite a NO-EDGE verdict"
