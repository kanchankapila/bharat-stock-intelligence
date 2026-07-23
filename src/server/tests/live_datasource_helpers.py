"""
Shared assertions for live_datasource tests.

The pattern (see MANDATORY rule in CLAUDE.md "Adding a new data source"): every fetcher
that pulls from an external URL/API needs one test, marked `@pytest.mark.live_datasource`,
that:
  1. Hits the real endpoint for ONE real, well-known ticker/screener/companyId.
  2. Uses the fetcher's OWN parsing function (not a hand-rolled reimplementation) so the
     test exercises the real code path.
  3. Asserts the parsed response is non-empty and shaped as expected.
  4. Writes it through the fetcher's OWN DB-write function into a throwaway DB.
  5. Asserts the stored row is ML-usable: numeric columns are real numbers (not None/NaN/
     stringified-non-numeric), identifier columns look like real identifiers (not a URL or
     other malformed scrape artifact — this is the exact defect class root-caused in
     trendlyne_screener_discovery.py on 2026-07-23, where a raw Trendlyne profile URL got
     written into a `symbol` column instead of a ticker).

These tests are skipped by default (see conftest.py) — run with RUN_LIVE_DATASOURCE_TESTS=1
before merging a new fetcher, or periodically as a manual canary. They intentionally do NOT
run in CI (no guaranteed network access to third-party financial sites, and a transient
upstream outage/rate-limit must never fail the build).
"""

import math
import re

TICKER_RE = re.compile(r'^[A-Z0-9&\-]+$')


def assert_looks_like_ticker(value: str, context: str = ""):
    """A real NSE/BSE ticker is short, uppercase, alnum plus & and -, and never a URL.
    This is the exact check that would have caught the trendlyne_screener_discovery.py bug
    (a raw 'https://trendlyne.com/equity/.../SOME-COMPANY-LTD/' string written as a symbol)
    at test time instead of after ~2M rows of production corruption."""
    assert value, f"{context}: empty/falsy value where a ticker was expected"
    assert "://" not in value, f"{context}: value looks like a URL, not a ticker: {value!r}"
    assert " " not in value, f"{context}: value contains a space, not a ticker: {value!r}"
    assert len(value) <= 20, f"{context}: value is too long to be a ticker ({len(value)} chars): {value!r}"
    assert TICKER_RE.match(value), f"{context}: value doesn't match ticker shape [A-Z0-9&-]+: {value!r}"


def assert_numeric_and_finite(value, context: str = ""):
    """A value destined for an ML feature column must be a real, finite number — not None,
    not NaN, not a stringified number that never got cast, not +/-inf."""
    assert value is not None, f"{context}: value is None, would store NULL in a feature column"
    assert isinstance(value, (int, float)), f"{context}: value is {type(value).__name__}, not numeric: {value!r}"
    assert not (isinstance(value, float) and math.isnan(value)), f"{context}: value is NaN"
    assert not (isinstance(value, float) and math.isinf(value)), f"{context}: value is +/-inf"


def assert_non_empty_response(data, context: str = ""):
    """Fails loudly instead of silently treating an empty/None response as 'nothing to do'
    — the exact silent-swallow pattern this project's fetcher audits keep finding."""
    assert data is not None, f"{context}: fetch returned None — endpoint may be down/changed shape"
    if isinstance(data, (list, dict)):
        assert len(data) > 0, f"{context}: fetch returned an empty {type(data).__name__}"


def assert_stored_row_ml_usable(row: dict, numeric_cols: list, ticker_cols: list, context: str = ""):
    """Run after reading a just-written row back out of the DB. Checks the STORED
    representation, not the in-memory Python object — catches type coercion bugs that only
    show up after a round-trip through the DB driver (e.g. a numeric column silently storing
    the string '12.5' instead of the float 12.5, which breaks a pandas/sklearn feature
    matrix downstream)."""
    for col in numeric_cols:
        assert col in row, f"{context}: expected numeric column {col!r} missing from stored row"
        assert_numeric_and_finite(row[col], f"{context}.{col}")
    for col in ticker_cols:
        assert col in row, f"{context}: expected ticker column {col!r} missing from stored row"
        assert_looks_like_ticker(row[col], f"{context}.{col}")
