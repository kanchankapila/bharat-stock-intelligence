"""Tests for screener_name_concepts.py.

Pure-function module, so these need no DB and run in CI. Every test here was
negative-controlled: each fails against the pre-fix / stripped source (see the
`test_..._catches_regression` docstrings for what specifically must break it).
"""
import csv
import os

import pytest

from screener_name_concepts import (
    CONCEPT_PATTERNS,
    ConceptTags,
    decompose,
    decompose_catalog,
    normalize_name,
    polarity_hint,
)

_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
_CATALOG = os.path.join(_REPO_ROOT, "screener_names.csv")


def _tags(name: str) -> set:
    return set(decompose(name).tags)


# ── normalization ──────────────────────────────────────────────────────────────────────

def test_deglues_etnow_runon_description():
    """ETnow names glue the description onto the title with no separator. Left unsplit, one
    concept fragments across many tag sets. Fails if _GLUED_BOUNDARY is removed."""
    out = normalize_name("High Dividend Yield StocksIdentifies stocks with significant payouts")
    assert out == "high dividend yield stocks"


def test_deglue_does_not_truncate_on_a_false_intraword_split():
    """The lowercase→uppercase split fires inside real words too: 'Strong QoQ EPS Growth in
    recent results' splits at 'Strong Qo|Q', which would throw away the quarterly/growth/
    results content of the name and leave a 9-char fragment matching nothing. The len < 12
    guard keeps the full string. Fails (all three tags lost) if that guard is dropped."""
    concept = decompose("Strong QoQ EPS Growth in recent results")
    assert {"tf_quarterly", "fund_growth", "event_results"} <= set(concept.tags)


def test_deglue_does_not_split_on_a_lowercase_initial_company_name():
    """Indian tickers that start lowercase (eClerx, iGate, mPhasis) put a lowercase→uppercase
    boundary at index 1, which would reduce the whole name to 'e'. Fails if the `i >= 4`
    short-head guard is removed."""
    concept = decompose("eClerx Services breakout above 50Day EMA")
    assert {"mech_breakout", "mech_ma_stack"} <= set(concept.tags)


def test_normalize_handles_empty_and_none_like():
    assert normalize_name("") == ""


# ── the moving-average ordering regression ─────────────────────────────────────────────

@pytest.mark.parametrize("name", [
    "Stocks with their SMA5 trading above their SMA20",   # Trendlyne ordering
    "Current Price above 100Day EMA",                      # ETnow/MoneyControl ordering
    "Bearish Cross - SMA 3,5 and 7",
    "Death Cross 20 day below 200 day",                    # via 'moving average'-less crossover
])
def test_ma_family_tagged_in_both_orderings_catches_regression(name):
    """The live catalog writes moving averages BOTH ways. The original vocabulary matched
    only `SMA100`-style and silently dropped the 11 `100Day EMA`-style names from
    combination search. Fails against the pre-fix pattern `\\b[se]ma\\s*\\d+\\b|moving average`
    for the 'Current Price above 100Day EMA' case."""
    tags = _tags(name)
    assert tags & {"mech_ma_stack", "mech_crossover"}, f"{name!r} produced no MA/crossover tag"


# ── facet orthogonality (the property combination search depends on) ───────────────────

def test_name_carries_multiple_facets_simultaneously():
    """Combination search across facets is the whole point; if decompose collapsed a name to
    a single winning tag the search space would be empty. Fails if tags stopped accumulating."""
    concept = decompose("30 min Williams %R crossed -80 from above")
    assert "tf_intraday_min" in concept.facets.get("timeframe", [])
    assert {"mech_oscillator", "mech_crossover"} <= set(concept.facets.get("mechanism", []))


def test_signal_tags_exclude_descriptive_facet():
    """A sector/theme membership is not a signal leg -- scoring_engine.py scored exactly this
    class as bearish evidence for months (recurring-bugs.md). Fails if signal_tags returns
    self.tags unfiltered."""
    concept = decompose("Adani Group share prices & companies list")
    assert "desc_group_list" in concept.tags
    assert "desc_group_list" not in concept.signal_tags


# ── same-day relevance ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", [
    "30 min Supertrend Buys",
    "Relative Outperformance versus Nifty500 over Day",
    "Bollinger Band Breakdown",
])
def test_same_day_relevant_true_for_short_horizon_mechanisms(name):
    assert decompose(name).same_day_relevant is True


@pytest.mark.parametrize("name", [
    # Carries a real participation tag (flow_shareholding) AND a quarterly/annual timeframe,
    # so only the explicit veto — not the "has no mechanism" fallback — can reject it. These
    # are the cases that actually negative-control the veto; a pure-fundamental name like
    # "Annual Revenue Growth..." returns False either way and tests nothing.
    "Increasing public shareholding in the past quarter (QoQ)",
    "Decreasing public shareholding in the past year (YoY)",
])
def test_same_day_relevant_false_for_quarterly_ownership_drift(name):
    """A shareholding change reported once a quarter qualifies the same stock every day for
    ~60 sessions, so it cannot predict WHICH day that stock moves — it would contribute a
    permanently-on column to combination search. Fails if the quarterly/annual veto is
    removed (the participation tag then makes these read as same-day relevant)."""
    assert decompose(name).same_day_relevant is False


def test_same_day_veto_does_not_swallow_weekly_names():
    """The veto must not reject a name that pairs an annual comparison with a weekly cadence.
    Fails if the `and not timeframes & {tf_weekly, tf_monthly}` escape is dropped."""
    assert decompose("Week RSI oversold with YoY profit growth").same_day_relevant is True


# ── polarity is a hint, never a direction ──────────────────────────────────────────────

def test_polarity_hint_is_directional_but_documented_unvalidated():
    assert polarity_hint(normalize_name("Bullish Harami Cross (Bullish Reversal)")) == 1
    assert polarity_hint(normalize_name("Bearish Cross - SMA 3,5 and 7")) == -1


def test_polarity_hint_returns_zero_when_balanced():
    """A name with equal up/down wording must not be forced to a pole -- the asymmetric
    ternary that treated 'not bullish' as bearish is a logged recurring bug
    (recurring-bugs.md, scoring_engine.py's _screener_polarity). Fails if the tie case
    falls through to -1."""
    assert polarity_hint("bullish above and bearish below") == 0


# ── source casing (the documented join hazard) ─────────────────────────────────────────

def test_decompose_catalog_lowercases_source():
    """screener_catalog carries trendlyne/Trendlyne as distinct PK rows (recurring-bugs.md).
    Any join keyed on source must normalize first. Fails if the lowercasing is removed."""
    rows = [{"source": "Trendlyne", "screener_name": "CCI Overbought"},
            {"source": "trendlyne", "screener_name": "CCI Overbought"}]
    assert {row["source"] for row, _ in decompose_catalog(rows)} == {"trendlyne"}


# ── vocabulary health, derived from the real catalog (not a hand-enumerated list) ──────

@pytest.mark.skipif(not os.path.exists(_CATALOG), reason="screener_names.csv not present")
def test_every_declared_tag_fires_on_the_real_catalog():
    """A pattern that never matches is dead vocabulary that looks like coverage. Derived by
    scanning the real 1,534-name catalog rather than an allowlist someone remembered to
    update -- the failure mode called out in recurring-bugs.md's testing section."""
    with open(_CATALOG, newline="", encoding="utf-8") as fh:
        fired = set()
        for row in csv.DictReader(fh):
            fired.update(decompose(row["screener_name"]).tags)
    declared = {tag for tag, _, _ in CONCEPT_PATTERNS}
    assert declared - fired == set(), f"tags that never fire: {sorted(declared - fired)}"


@pytest.mark.skipif(not os.path.exists(_CATALOG), reason="screener_names.csv not present")
def test_catalog_signal_tag_coverage_floor():
    """Guards against a refactor quietly dropping a whole family. Floor is set below the
    measured 82.3% so normal catalog growth doesn't flap it, but high enough that losing
    the MA or oscillator family (the two largest) trips it."""
    with open(_CATALOG, newline="", encoding="utf-8") as fh:
        concepts = [decompose(row["screener_name"]) for row in csv.DictReader(fh)]
    covered = sum(1 for c in concepts if c.signal_tags)
    assert covered / len(concepts) >= 0.75


def test_decompose_returns_concept_tags_instance():
    assert isinstance(decompose("CCI Overbought"), ConceptTags)
