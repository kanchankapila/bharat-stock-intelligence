"""The mc_pricefeed_daily fallback (2026-08-21) must be applied IDENTICALLY to the training
query and the scoring query.

Why a source-text test rather than a behavioural one: ml_ensemble.py builds three near-identical
giant SQL strings (Postgres training, a dead SQLite training branch, and score_pending's), and
the failure mode being guarded is that someone extends the feature set in one and not the other.
That is train/serve skew -- a model fitted on a real per-date ma30_dist_pct then scored on the
~95%-NULL technical_signals copy -- and it is silent: both queries run fine, the AUC just quietly
decays. recurring-bugs.md records this class four times over ("Grouping training rows by day when
scoring reads one snapshot is train/serve skew").

The mc_* column list is DERIVED from the source, never hand-enumerated here, so adding a 26th
column to one query and not the other fails this test instead of shipping.
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

SRC = os.path.join(os.path.dirname(__file__), "..", "ml_ensemble.py")


def _source():
    with open(SRC, encoding="utf-8") as f:
        return f.read()


def _coalesced_mc_columns(segment: str) -> set:
    """Every ts.mc_* column given a mc_pricefeed_daily fallback in this SQL segment."""
    return set(re.findall(r'COALESCE\(ts\.(mc_\w+),\s*mp\.\w+\)', segment))


def _func_body(src, name):
    """Source of one top-level function -- located by name, never by a nearby SQL landmark.
    ml_ensemble.py contains three `FROM technical_signals ts` queries; anchoring on the first
    one silently selects the wrong function, which is how the first version of this test
    failed against perfectly correct code."""
    a = src.index("def " + name + "(")
    nxt = src.find(chr(10) + "def ", a + 1)
    return src[a:nxt if nxt != -1 else len(src)]


def _training_pg_query(src):
    body = _func_body(src, "load_training_data")
    a = body.index("    if use_postgres():")
    return body[a:body.index("    else:", a)]   # the live Postgres branch only


def _scoring_query(src):
    return _func_body(src, "load_pending_signals")


class TestPricefeedFallbackParity:
    def test_training_query_has_the_fallback(self):
        cols = _coalesced_mc_columns(_training_pg_query(_source()))
        assert len(cols) >= 20, f"expected the mc_pricefeed_daily fallback, found {len(cols)}"

    def test_scoring_query_has_the_fallback(self):
        cols = _coalesced_mc_columns(_scoring_query(_source()))
        assert len(cols) >= 20, f"expected the mc_pricefeed_daily fallback, found {len(cols)}"

    def test_training_and_scoring_coalesce_the_same_columns(self):
        src = _source()
        train = _coalesced_mc_columns(_training_pg_query(src))
        score = _coalesced_mc_columns(_scoring_query(src))
        assert train == score, (
            "train/serve skew: these mc_* columns get a live pricefeed fallback in one query "
            f"but not the other.\n  train-only: {sorted(train - score)}\n  score-only: "
            f"{sorted(score - train)}")

    def test_both_queries_join_the_pricefeed_lateral(self):
        src = _source()
        for name, seg in (("training", _training_pg_query(src)), ("scoring", _scoring_query(src))):
            assert "mc_pricefeed_daily mp2" in seg, f"{name} query has no pricefeed LATERAL"
            # Point-in-time: must not read a row dated after the signal it is describing.
            assert re.search(r'mp2\.date <= \w+\.(signal_date|date)\b', seg), (
                f"{name} query's pricefeed join is not bounded to <= the signal date -- "
                "that is look-ahead")

    def test_fallback_never_overrides_an_existing_value(self):
        # COALESCE(ts.x, mp.y), not COALESCE(mp.y, ts.x): where technical_signals already has a
        # value it must still win, so this change cannot regress anything that worked before.
        src = _source()
        for seg in (_training_pg_query(src), _scoring_query(src)):
            assert not re.search(r'COALESCE\(mp\.\w+,\s*ts\.mc_\w+\)', seg), \
                "pricefeed must be the FALLBACK, not the primary"
