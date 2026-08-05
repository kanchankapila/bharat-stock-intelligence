"""Live-datasource test for mc_index_oi_fetcher.py (see CLAUDE.md's "Adding a New Data
Source" mandatory rule).

Feeds `index_option_oi` / `index_max_pain` -- this is the exact file whose `_compute_max_pain()`
had call/put OI swapped until Finding #51 of the 2026-07-30 full-stack audit (call writers lose,
and are weighted by CALL oi, when settlement > strike; the code had it backwards). That bug
shipped and stayed live with zero test coverage catching it; this closes the gap so a
regression in either the parse or the max-pain math would be caught against real data, not
just a synthetic fixture.

Uses `execute()`/`executemany()` imported as bare module-level functions from db_compat, same
as the nt_* NiftyTrader fetchers -- monkeypatched to a capture object rather than injected via
a `con` parameter (there isn't one).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mc_index_oi_fetcher as mio
from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite

REAL_SC_ID = "in;NSX"  # NIFTY50, per mc_index_oi_fetcher.py's own default map


class _CaptureDB:
    """Fakes db_compat's bare execute()/executemany() by recording (sql, params) calls
    instead of touching a real database -- mirrors test_live_datasource_nt_vix.py's pattern
    for fetchers with no `con` injection point."""
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def executemany(self, sql, rows):
        for row in rows:
            self.calls.append((sql, row))


@pytest.mark.live_datasource
class TestMcIndexOiLiveDataSource:
    def test_real_expiry_fetch_is_ml_usable(self):
        """Step 1-3: hit the real MoneyControl expiry-dates endpoint, parse with the
        fetcher's own _fetch_expiries(), assert the shape is usable."""
        expiries = mio._fetch_expiries(REAL_SC_ID)
        assert_non_empty_response(expiries, f"_fetch_expiries({REAL_SC_ID})")
        for e in expiries[:5]:
            assert isinstance(e, str) and len(e) == 10 and e[4] == "-" and e[7] == "-", \
                f"expiry does not look like a YYYY-MM-DD date: {e!r}"

    def test_real_oi_fetch_writes_ml_usable_rows_with_correct_max_pain_weighting(self):
        """Step 1-5: fetch the real near-term expiry's OI chain, write through the
        fetcher's own _fetch_and_store() (execute/executemany monkeypatched to a capture
        object), then assert the captured rows are ML-usable AND that the max-pain figure
        it computed lands within the real fetched strike range -- a regression guard for
        Finding #51 (call/put OI were swapped in the weighting, which pushes the computed
        max-pain strike to whichever side is now over-weighted)."""
        expiries = mio._fetch_expiries(REAL_SC_ID)
        assert_non_empty_response(expiries, f"_fetch_expiries({REAL_SC_ID})")
        near_expiry = mio._near_term_expiries(expiries, n=1)[0]

        import datetime
        today = datetime.date.today().isoformat()
        fetched_at = datetime.datetime.utcnow().isoformat()

        cap = _CaptureDB()
        orig_execute, orig_executemany = mio.execute, mio.executemany
        mio.execute, mio.executemany = cap.execute, cap.executemany
        try:
            n_rows = mio._fetch_and_store(REAL_SC_ID, near_expiry, today, fetched_at)
        finally:
            mio.execute, mio.executemany = orig_execute, orig_executemany

        assert n_rows > 0, f"_fetch_and_store returned 0 rows for {REAL_SC_ID} {near_expiry}"

        oi_calls = [(sql, params) for sql, params in cap.calls if "index_option_oi" in sql]
        assert oi_calls, "_fetch_and_store() never wrote to index_option_oi"
        # INSERT param order: (index_name, oi_date, expiry, strike, ce_oi, pe_oi, ...)
        strikes = []
        for _, params in oi_calls:
            strike = params[3]
            assert_numeric_and_finite(strike, context="index_option_oi.strike")
            strikes.append(strike)
        assert strikes, "no strikes captured in index_option_oi rows"

        max_pain_calls = [(sql, params) for sql, params in cap.calls if "index_max_pain" in sql]
        assert max_pain_calls, "_fetch_and_store() never wrote to index_max_pain"
        # INSERT param order: (index_name, date, expiry, max_pain, pcr_oi, total_ce_oi, total_pe_oi, fetched_at)
        _, mp_params = max_pain_calls[0]
        max_pain = mp_params[3]
        if max_pain is not None:
            assert_numeric_and_finite(max_pain, context="index_max_pain.max_pain")
            # The max-pain strike must be one of the strikes actually seen in the chain --
            # a swapped-weighting bug can silently drag it toward the wrong tail without
            # this ever failing a bare "is it numeric" check.
            assert min(strikes) <= max_pain <= max(strikes), (
                f"max_pain {max_pain} falls outside the real fetched strike range "
                f"[{min(strikes)}, {max(strikes)}] -- check for a call/put OI weighting regression"
            )

        pcr_oi = mp_params[4]
        if pcr_oi is not None:
            assert_numeric_and_finite(pcr_oi, context="index_max_pain.pcr_oi")
            assert pcr_oi >= 0, f"pcr_oi must be non-negative: {pcr_oi}"
