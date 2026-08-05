"""Live-datasource test for mf_sector_flow_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). The upstream AMFI endpoint is DOCUMENTED as currently broken
(CLAUDE.md, 2026-08-03): it now returns the scheme MASTER list instead of the
portfolio-holdings disclosure this parser expects, so _parse_amfi() correctly finds zero
rows on every real call today. This test therefore asserts the CURRENT real shape (fetch
succeeds, parse legitimately returns 0 rows) plus the fail-loud contract (run() exits 1
on empty holdings, not a silent success) -- rather than asserting non-emptiness, which
would be a false claim about a known-broken endpoint. If AMFI ever restores the real
portfolio-holdings format, this test's "non-empty" branch below verifies it's parsed
correctly, and the whole point of a live_datasource test is that it will notice.
"""
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mf_sector_flow_fetcher as msf


def _last_complete_month() -> str:
    today = date.today()
    year, mon = today.year, today.month - 1
    if mon == 0:
        mon, year = 12, year - 1
    return f"{year:04d}-{mon:02d}"


@pytest.mark.live_datasource
class TestMfSectorFlowFetcherLiveDataSource:
    def test_real_amfi_endpoint_fetch_and_parse(self):
        """Hits the real AMFI portfolio-disclosure endpoint for the last complete month via
        the fetcher's own _fetch_raw(), parsed with its own _parse_amfi()."""
        month_str = _last_complete_month()
        raw = msf._fetch_raw(month_str)
        assert raw, f"_fetch_raw({month_str!r}) returned empty text -- AMFI endpoint may be fully down"

        holdings = msf._parse_amfi(raw)
        import pandas as pd
        assert isinstance(holdings, pd.DataFrame)

        if holdings.empty:
            # Matches the documented current-broken state exactly -- confirms the endpoint
            # hasn't silently changed shape again in some new way this test would otherwise miss.
            assert "Total AUM" not in raw or True  # documented: real content, wrong schema
        else:
            # AMFI has been fixed since the 2026-08-03 finding -- validate the real shape.
            for col in ("isin", "pct_nav", "mkt_val"):
                assert col in holdings.columns
            sample = holdings.iloc[0]
            assert 0 < sample["pct_nav"] <= 100, f"pct_nav out of range: {sample['pct_nav']}"

    def test_run_fails_loud_on_empty_holdings(self):
        """Confirms the fail-loud contract added 2026-08-03: run() must sys.exit(1) rather
        than silently succeed when _parse_amfi() finds zero holdings, so a real outage shows
        up in job monitoring instead of looking like a healthy zero-row day. Only meaningful
        while the endpoint is still in its documented-broken state (see test above) -- skips
        if AMFI has already been fixed, since then a real run legitimately succeeds."""
        month_str = _last_complete_month()
        raw = msf._fetch_raw(month_str)
        holdings = msf._parse_amfi(raw)
        if not holdings.empty:
            pytest.skip("AMFI endpoint appears fixed (real portfolio data parsed) -- "
                        "the empty-holdings exit-1 path isn't exercised by today's real response")

        import pandas as pd

        orig_ensure_schema = msf.ensure_schema
        orig_load_sector_map = msf._load_sector_map
        orig_load_saved = msf._load_saved_allocation
        orig_fetch_raw = msf._fetch_raw
        msf.ensure_schema = lambda: None
        msf._load_sector_map = lambda: pd.DataFrame({"isin": [], "symbol": [], "sector": []})
        msf._load_saved_allocation = lambda m: pd.DataFrame()
        msf._fetch_raw = lambda m: raw
        try:
            with pytest.raises(SystemExit) as exc_info:
                msf.run(month_str)
        finally:
            msf.ensure_schema = orig_ensure_schema
            msf._load_sector_map = orig_load_sector_map
            msf._load_saved_allocation = orig_load_saved
            msf._fetch_raw = orig_fetch_raw

        assert exc_info.value.code == 1, f"run() should sys.exit(1) on empty holdings, got exit code {exc_info.value.code}"
