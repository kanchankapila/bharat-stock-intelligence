"""Live-datasource test for nifty_pe_fetcher.py (see CLAUDE.md's "Adding a New Data Source"
mandatory rule). First test coverage for this fetcher.

Regression coverage for the 2026-08-07 dead-column fix: fetch_mc_pe_pb() guessed
ov.get("divYield")/ov.get("eps") against MC's real indices/fundamentals/overview response --
neither key exists (real keys: div_yield, ttmEps, comma-formatted). index_valuation.div_yield
was 0/7,384 rows; eps silently degraded to 26.7% (well below pe/pb's ~90%, both from a separate
graph endpoint this bug didn't touch).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nifty_pe_fetcher as npf
from live_datasource_helpers import assert_numeric_and_finite

NIFTY50_IND_ID = 9  # per this fetcher's own docstring example


@pytest.mark.live_datasource
class TestNiftyPeFetcherLiveDataSource:
    def test_real_overview_fetch_populates_div_yield_and_eps(self):
        """Hits the real MC indices/fundamentals endpoints for NIFTY50 (graph/pe, graph/pb,
        overview) via the fetcher's own fetch_mc_pe_pb(), and asserts today's entry has
        real, plausible div_yield/eps values -- not just that the call didn't crash."""
        result = npf.fetch_mc_pe_pb(NIFTY50_IND_ID, days=30)
        assert result, "fetch_mc_pe_pb returned no data at all for NIFTY50"

        import datetime
        today = datetime.date.today().isoformat()
        entry = result.get(today)
        assert entry is not None, f"no entry for today ({today}) -- overview fetch may have failed"

        assert "div_yield" in entry, "div_yield missing -- check ov.get('div_yield') is still the real MC key"
        assert_numeric_and_finite(entry["div_yield"], context="index_valuation.div_yield")
        # Nifty50's dividend yield realistically sits in a low single-digit % range.
        assert 0 < entry["div_yield"] < 10, f"div_yield {entry['div_yield']} is outside a plausible range"

        assert "eps" in entry, "eps missing -- check ov.get('ttmEps') is still the real MC key"
        assert_numeric_and_finite(entry["eps"], context="index_valuation.eps")
        assert entry["eps"] > 0, f"eps {entry['eps']} should be positive for Nifty50"

        # pe/pb come from a separate, already-working graph endpoint -- confirms this test
        # exercises the real end-to-end call, not just the overview leg in isolation.
        assert_numeric_and_finite(entry.get("pe"), context="index_valuation.pe")
        assert_numeric_and_finite(entry.get("pb"), context="index_valuation.pb")
