"""Both writers of alpha.instrument.sector must use ONE taxonomy.

AF-20260929-10: nse_constituents writes NSE's index-file industry names ("Financial Services",
"Realty") while the legacy nse_stocks master writes GICS-style ones ("Financials", "Real
Estate"). Unmapped, the column carried BOTH -- 32 distinct labels for ~11 real sectors -- and
the portfolio's sector cap then applies a separate 25% cap to each NAME, i.e. up to 50% of the
book in one real sector. Better coverage with a split taxonomy is weaker risk control than the
sparse column it replaced, which is why this is a test and not a comment.
"""
from __future__ import annotations

import pytest

from bharat_alpha.ingest.sources.nse_constituents import parse_constituents
from bharat_alpha.reference.provider_ids import SECTOR_ALIASES, normalise_sector

# The canonical set: what the legacy master emits, which is the broader of the two sources.
CANONICAL = {"Financials", "Industrials", "Consumer Discretionary", "Consumer Staples",
             "Materials", "Healthcare", "Information Technology", "Real Estate",
             "Utilities", "Energy", "Communication Services"}


@pytest.mark.parametrize("nse_name, expected", [
    ("Financial Services", "Financials"),
    ("Capital Goods", "Industrials"),
    ("Realty", "Real Estate"),
    ("Fast Moving Consumer Goods", "Consumer Staples"),
    ("Metals & Mining", "Materials"),
    ("Oil Gas & Consumable Fuels", "Energy"),
    ("Power", "Utilities"),
    ("Automobile and Auto Components", "Consumer Discretionary"),
    ("Telecommunication", "Communication Services"),
    ("Telecommunications", "Communication Services"),
])
def test_nse_industry_names_collapse_onto_the_canonical_taxonomy(nse_name, expected):
    assert normalise_sector(nse_name) == expected


def test_every_alias_target_is_canonical():
    """A typo in the alias table would invent a 12th bucket that caps independently."""
    assert set(SECTOR_ALIASES.values()) <= CANONICAL, set(SECTOR_ALIASES.values()) - CANONICAL


@pytest.mark.parametrize("junk", ["Unknown", "unknown", "  ", "-", "N/A", "Other", None])
def test_placeholder_labels_become_null_not_a_sector(junk):
    """A literal 'Unknown' reads as populated while carrying nothing, so nothing flags it as
    missing -- worse than NULL, which the DQ fill check can see."""
    assert normalise_sector(junk) is None


def test_already_canonical_names_pass_through_unchanged():
    for s in CANONICAL:
        assert normalise_sector(s) == s


def test_the_constituents_parser_normalises_at_the_boundary():
    """Guard the WRITER, not just the helper: the connector is the other thing that writes this
    column, and it wrote raw NSE names until 2026-09-29.
    """
    csv_text = ("Company Name,Industry,Symbol,ISIN Code\n"
                "X Ltd,Financial Services,XLTD,INE1\n"
                "Y Ltd,Realty,YLTD,INE2\n"
                "Z Ltd,Unknown,ZLTD,INE3\n")
    got = {r["symbol"]: r["industry"] for r in parse_constituents(csv_text)}
    assert got == {"XLTD": "Financials", "YLTD": "Real Estate", "ZLTD": None}
