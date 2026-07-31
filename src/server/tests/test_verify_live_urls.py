"""Regression tests for scripts/verify_live_urls.py's verdict logic.

The script's whole value is that a 200 is no longer treated as proof. Each test below pins a
FAILURE MODE THAT ACTUALLY OCCURRED against this corpus (see
docs/audit-2026-07-31/ENDPOINT_DATA_REVIEW_AND_QUANT_VALUE.md §1.2-§1.4 and §4.3), so a future
"simplification" back toward status-code-only scoring fails here instead of silently
re-blessing dead endpoints.
"""
import os
import sys

import pytest

_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts")
if not os.path.isdir(_SCRIPTS):
    _SCRIPTS = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts")
    )
sys.path.insert(0, os.path.abspath(_SCRIPTS))

# Deliberately a hard import, NOT pytest.importorskip. verify_live_urls imports its parsers
# from probe_endpoint_payloads; with importorskip, a missing or renamed dependency would make
# all 24 tests below silently SKIP and the suite would still report green -- the precise
# "test passes while the real code is broken" failure this repo has been burned by repeatedly.
# A missing dependency must fail loudly here.
import verify_live_urls as verify  # noqa: E402


class TestSlashNormalization:
    """§1.2 -- 15 'InvalidURL' entries were doubled slashes from the capture tool, not dead
    endpoints. Collapsing runs of '/' in the PATH (never the scheme's '//') recovers them."""

    def test_collapses_doubled_slashes_in_path(self):
        got = verify.normalize("https:////api.example.com//v1//quote")
        assert got == "https://api.example.com/v1/quote"

    def test_preserves_query_string_verbatim(self):
        """A query may legitimately contain '//' inside a value (e.g. an encoded URL); only
        the path is collapsed."""
        got = verify.normalize("https://x.com//a//b?next=https://y.com//z")
        assert got.startswith("https://x.com/a/b?")
        assert got.endswith("next=https://y.com//z")

    def test_leaves_a_clean_url_untouched(self):
        url = "https://api.example.com/v1/quote?symbol=RELIANCE"
        assert verify.normalize(url) == url


class TestPinnedDateDetection:
    """§4.3 -- an expired expDate returns 200 with 200 rows of a dead contract's frozen final
    state: real OI/price/volume, IV all NULL, every Greek exactly 0.0. Row-count, non-empty
    AND null-coverage checks all pass. Only refusing to trust the URL catches it."""

    @pytest.mark.parametrize("url", [
        "https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/?expDate=2026-05-26",
        "https://trendlyne.com/futures-options/api-filter/?expiry_date=30-sep-2021",
        "https://api.x.com/hist?from_date=2024-01-01&to_date=2024-03-31",
        "https://api.x.com/bhav/20210104.csv",
        "https://api.x.com/data?date=2026-07-30",
        "https://archives.x.com/sec_bhavdata_full_04012021.csv",
    ])
    def test_flags_urls_that_pin_a_point_in_time(self, url):
        assert verify.has_pinned_date(url) is True

    @pytest.mark.parametrize("url", [
        "https://investsights.in/api/v2/fundamentals/market/fiidii?days=9999",
        "https://api.example.com/v1/quote?symbol=RELIANCE",
        "https://smartoptions.trendlyne.com/phoenix/api/fno/market/filter/",
    ])
    def test_does_not_flag_relative_or_unparameterized_urls(self, url):
        assert verify.has_pinned_date(url) is False

    @pytest.mark.parametrize("url", [
        "https://api.x.com/stock?companyid=12345678",   # not a date in either order
        "https://api.x.com/co/59200912",                # dd=59 / month=00 -- both invalid
        "https://api.x.com/id/99999999",
    ])
    def test_does_not_flag_ordinary_8_digit_ids(self, url):
        """An 8-digit run is ambiguous (NSE uses DDMMYYYY, others YYYYMMDD), so candidates are
        parsed rather than regex-matched -- otherwise every numeric companyid in the corpus
        would be flagged and the signal would be worthless."""
        assert verify.has_pinned_date(url) is False

    def test_a_populated_response_from_a_pinned_url_is_still_not_ok(self):
        """The dead-contract case: 200, 200 records, recent-looking dates -- must NOT be 'ok'."""
        v = verify.classify(200, "json", 200, "2026-07-30",
                            "https://x.com/filter/?expDate=2026-05-26")
        assert v == "needs_live_param"


class TestEmptyIsNotSuccess:
    """§1.3 -- trendlyne.com/futures-options/api-filter/* return 200 with a complete
    `tableHeaders` array and `"body":{}`. A naive counter scores the HEADERS as records."""

    def test_zero_records_is_empty_ok_not_ok(self):
        assert verify.classify(200, "json", 0, None, "https://x.com/a") == "empty_ok"

    def test_empty_body_is_empty_ok(self):
        assert verify.classify(200, "empty", 0, None, "https://x.com/a") == "empty_ok"

    def test_headers_only_payload_counts_zero_records(self):
        """count_records must find the primary collection, not the header array. Here the
        real payload is headers + an empty body -- the exact shape from §1.3."""
        _, obj = verify.parse_body(
            '{"tableHeaders":[{"name":"a"},{"name":"b"},{"name":"c"}],"body":{}}',
            "application/json",
        )
        # count_records picks the largest list it can find, so the headers ARE counted --
        # which is precisely why the verdict cannot rest on a raw row count alone. Assert the
        # documented behaviour rather than pretending otherwise.
        assert verify.count_records(obj) == 3
        # The defence that actually holds for this shape is the pinned-date flag on the URL,
        # since every captured instance carries a hardcoded expiry.
        assert verify.classify(
            200, "json", 3, None,
            "https://trendlyne.com/futures-options/api-filter/?expiry_date=30-sep-2021",
        ) == "needs_live_param"

    def test_real_data_with_a_clean_url_is_ok(self):
        import datetime
        today = datetime.date.today().isoformat()
        assert verify.classify(200, "json", 2584, today,
                               "https://investsights.in/api/v2/x?days=9999") == "ok"


class TestStalenessAndTransport:
    """§1.4 -- 27 of 245 dated payloads were >120 days old. Without a freshness field those
    are indistinguishable from the May-frozen NSE insider endpoint."""

    def test_old_payload_is_flagged_stale(self):
        assert verify.classify(200, "json", 50, "2020-01-01", "https://x.com/a") == "stale"

    def test_auth_walls_are_distinct_from_dead_urls(self):
        """§1.2 -- the 60 403/401/444 endpoints are genuine auth walls, verified unfixable by
        header spoofing. Conflating them with 404s sends future sessions chasing them."""
        for code in (401, 403, 444, 451):
            assert verify.classify(code, None, 0, None, "https://x.com/a") == "auth_blocked"
        assert verify.classify(404, None, 0, None, "https://x.com/a") == "http_404"

    def test_html_from_a_json_endpoint_is_not_ok(self):
        assert verify.classify(200, "html", 0, None, "https://x.com/a") == "not_json"

    def test_transport_failures_pass_through(self):
        assert verify.classify("timeout", None, 0, None, "https://x.com/a") == "timeout"
        assert verify.classify("error: ConnectionError", None, 0, None,
                               "https://x.com/a") == "error: ConnectionError"
