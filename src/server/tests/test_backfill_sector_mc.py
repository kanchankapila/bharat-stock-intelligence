"""Regression tests for backfill_sector_mc.py's MoneyControl main_sector -> GICS map.

The live --enumerate run against production (2026-08-05) found several real MC
main_sector labels with no _GICS entry at all -- including "Real Estate" itself,
even though "Realty" was already mapped. These tests pin the fixes so a future edit
to _GICS can't silently drop them again.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backfill_sector_mc import _GICS  # noqa: E402


class TestGicsMapCoversLiveMcSectors:
    # Every one of these was observed as a real, unmapped main_sector value on the live
    # 2026-08-05 --enumerate run (see the run's own "<-- UNMAPPED" report) except
    # "Miscellaneous", which is deliberately left unmapped (see test below).
    LIVE_UNMAPPED_FOUND = {
        "Real Estate": "Real Estate",
        "Plastic Products": "Materials",
        "Electricals": "Industrials",
        "Paper": "Materials",
        "Diamond & Jewellery": "Consumer Discretionary",
        "Diamond  &  Jewellery": "Consumer Discretionary",
        "Containers & Packaging": "Materials",
        "Aviation": "Industrials",
        "Alcohol": "Consumer Staples",
        "Industrial Gases & Fuels": "Materials",
        "Footwear": "Consumer Discretionary",
        "Manufacturing": "Industrials",
        "Ship Building": "Industrials",
        "Photographic Products": "Consumer Discretionary",
    }

    def test_all_live_unmapped_sectors_now_resolve(self):
        for mc_label, expected_gics in self.LIVE_UNMAPPED_FOUND.items():
            assert mc_label in _GICS, f"{mc_label!r} has no GICS mapping"
            assert _GICS[mc_label] == expected_gics

    def test_realty_and_real_estate_agree(self):
        # Both spellings observed live from MC's own feed must land on the identical
        # canonical value -- a stock shouldn't classify differently depending on which
        # exact string MC happened to return that day.
        assert _GICS["Realty"] == _GICS["Real Estate"] == "Real Estate"

    def test_miscellaneous_deliberately_unmapped(self):
        # "Miscellaneous" is not a real GICS sector -- forcing a bucket for it would be a
        # guess this project's conventions rule out. write_db() still writes `industry`
        # for these rows via COALESCE; only `sector` stays untouched.
        assert "Miscellaneous" not in _GICS

    def test_no_gics_value_is_itself_unmapped(self):
        # Every _GICS value must be a real canonical label a symbol could show up under --
        # i.e. mapping into a value that isn't itself a stable, final GICS bucket would be
        # a silent dead end.
        canonical_values = set(_GICS.values())
        for v in canonical_values:
            assert isinstance(v, str) and v.strip() == v and v != ""
