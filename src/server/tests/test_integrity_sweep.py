import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts"))

from integrity_sweep import _classify  # noqa: E402


class TestClassify:
    """AF-20260818-45: sweep_table() was rewritten from one query PER column to one query for
    the whole table (a full-repo sweep took 20+ minutes with zero output before the first
    finding could even print, because every table paid one network round trip per column --
    303 for technical_signals alone, measured 8.07s before / 3.2s after for that table). This
    pins _classify(), the decision logic both the fast batched path and the per-column fallback
    now share -- the correctness the batched rewrite must preserve, live-verified separately by
    running --table technical_signals/feature_store/unified_recommendations before and after and
    diffing the exact dead/frozen column lists (identical both times)."""

    def test_zero_non_null_is_dead(self):
        assert _classify(nn=0, nd=0, n=100, dt='double precision') == 'dead'

    def test_single_distinct_numeric_value_is_frozen(self):
        assert _classify(nn=100, nd=1, n=100, dt='double precision') == 'frozen'

    def test_single_distinct_text_value_is_not_frozen(self):
        # FROZEN only fires for numeric-ish types -- a text column legitimately having one
        # value (e.g. every row's regime='BULL' on a single-regime day) isn't the same defect.
        assert _classify(nn=100, nd=1, n=100, dt='text') is None

    def test_populated_and_varying_is_neither(self):
        assert _classify(nn=100, nd=42, n=100, dt='double precision') is None

    def test_partial_null_is_neither_dead_nor_frozen(self):
        # nn < n means SOME rows are null and some aren't -- not the "100% NULL" or "every row
        # identical" shape this sweep exists to catch.
        assert _classify(nn=50, nd=3, n=100, dt='double precision') is None
