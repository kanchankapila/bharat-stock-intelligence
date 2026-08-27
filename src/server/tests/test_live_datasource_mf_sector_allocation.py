"""
live_datasource test for mf_sector_allocation_fetcher.py (ET / mcxlivefeeds).

Covers all four steps of the pattern in live_datasource_helpers.py: hits the real
endpoints via the fetcher's OWN resolution helpers (discover_amcs / discover_schemes),
parses with the fetcher's OWN capture_scheme, asserts shape + finite numerics, then
writes through the fetcher's OWN save_rows into a throwaway schema and reads the row
back to confirm it is ML-usable.

Skipped by default -- opt in with RUN_LIVE_DATASOURCE_TESTS=1 (see conftest.py).

The last test in this file is NOT live and NOT skipped: it pins the vocabulary
agreement between SECTOR_NAME_MAP and SECTOR_LABEL. That is the guard for the defect
this fetcher was written on top of -- SECTOR_LABEL's keys used to be a vocabulary
(`Financial Services`/`Automobile`/`FMCG`/...) that matched nothing in the live
`nse_stocks.sector` column, so _update_macro_asset_prices skipped every sector and
wrote zero rows without erroring.
"""

import os
import sys
import math

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))

import mf_sector_allocation_fetcher as fetcher
from mf_sector_flow_fetcher import SECTOR_LABEL
from live_datasource_helpers import assert_non_empty_response


def _first_scheme_with_sectors(schemeids, limit=25):
    """Return (schemeid, rows) for the first scheme reporting sectors.

    Most schemes are debt/index and legitimately report nothing, so a single
    scheme returning None is not a failure -- exhausting the sample is.
    """
    for sid in sorted(schemeids, key=int)[:limit]:
        rows = fetcher.capture_scheme(sid)
        if rows:
            return sid, rows
    return None, None


@pytest.mark.live_datasource
class TestMfSectorAllocationLiveDataSource:
    def test_real_fetch_parses_and_stores_ml_usable_rows(self, pg_db):
        # 1. AMC universe, through the fetcher's own discovery helper.
        amcs = fetcher.discover_amcs()
        assert_non_empty_response(amcs, "discover_amcs()")
        slug, amcid = amcs[0]
        assert slug.endswith("-mutual-fund"), f"unexpected AMC slug shape: {slug!r}"
        assert amcid.isdigit(), f"amcid is not a provider-issued numeric id: {amcid!r}"

        # 2. Scheme ids for that AMC.
        schemes = fetcher.discover_schemes(slug, amcid)
        assert_non_empty_response(schemes, f"discover_schemes({slug}, {amcid})")
        assert all(s.isdigit() for s in schemes), "non-numeric schemeid leaked from the page"

        # 3. Parse a real payload with the fetcher's own parser.
        sid, rows = _first_scheme_with_sectors(schemes)
        assert rows, (
            f"no scheme in the first 25 of {slug} reported any sector -- either the "
            f"topsectorforportfolio endpoint changed shape or the universe is wrong"
        )
        assert_non_empty_response(rows, f"capture_scheme({sid})")
        for r in rows:
            assert r["sector"], f"empty sector name in {r!r}"
            assert len(r["holding_date"]) == 10 and r["holding_date"][4] == "-", (
                f"holding_date is not ISO: {r['holding_date']!r}"
            )
            for col in ("invest_pct", "invest_value_cr", "mom_change_pct"):
                v = r[col]
                assert isinstance(v, float) and math.isfinite(v), (
                    f"{col} is not a finite number: {v!r}"
                )
            # A sector name must not be a URL/scrape artifact -- the exact failure
            # that corrupted ~2.1M rows via trendlyne_screener_discovery.py.
            assert "/" not in r["sector"] and "http" not in r["sector"].lower(), (
                f"sector looks like a scrape artifact, not a sector: {r['sector']!r}"
            )

        # 4. Round-trip through the fetcher's own writer into the throwaway schema.
        fetcher.ensure_schema()
        fetcher.save_rows(sid, rows)

        from db_compat import read_df
        stored = read_df(
            "SELECT schemeid, holding_date, sector, invest_pct, invest_value_cr, "
            "mom_change_pct FROM mf_scheme_sector_allocation WHERE schemeid = ?",
            params=(sid,),
        )
        assert len(stored) == len(rows), (
            f"save_rows wrote {len(stored)} rows for {len(rows)} parsed sectors"
        )
        got = stored.iloc[0]
        assert str(got["schemeid"]) == str(sid)
        for col in ("invest_pct", "invest_value_cr", "mom_change_pct"):
            assert math.isfinite(float(got[col])), f"{col} unusable after round-trip: {got[col]!r}"

    def test_canonical_sectors_match_the_live_nse_stocks_vocabulary(self):
        """SECTOR_LABEL's keys must be real `nse_stocks.sector` values.

        Reads production read-only (no pg_db) on purpose: the vocabulary this must
        agree with is the live one, and a fixture copy would drift from it silently.
        """
        from db_compat import read_df
        live = set(
            read_df("SELECT DISTINCT sector FROM nse_stocks WHERE sector IS NOT NULL")
            ["sector"].tolist()
        )
        assert live, "nse_stocks.sector is empty -- cannot validate the mapping"

        unknown = sorted(set(SECTOR_LABEL) - live)
        assert not unknown, (
            f"SECTOR_LABEL keys absent from live nse_stocks.sector: {unknown}. "
            f"Propagation to macro_asset_prices/technical_signals silently writes "
            f"nothing for these. Live vocabulary: {sorted(live)}"
        )


def test_sector_label_keys_are_reachable_from_sector_name_map():
    """Every propagating sector must be producible by canonical_sector().

    Not live, never skipped. If SECTOR_NAME_MAP can never emit a name that
    SECTOR_LABEL keys on, that macro feature is dead by construction and nothing
    at runtime says so -- _update_macro_asset_prices just skips it.
    """
    producible = set(fetcher.SECTOR_NAME_MAP.values())
    unreachable = sorted(set(SECTOR_LABEL) - producible)
    assert not unreachable, (
        f"SECTOR_LABEL keys no ET sector name can ever map onto: {unreachable}"
    )


def test_canonical_sector_maps_known_et_names_and_passes_through_unknown():
    # Names measured live on 2026-08-27 across a 100-scheme sample.
    assert fetcher.canonical_sector("Financial") == "Financials"
    assert fetcher.canonical_sector("Automobile") == "Consumer Discretionary"
    assert fetcher.canonical_sector("Capital Goods") == "Industrials"
    assert fetcher.canonical_sector("Metals & Mining") == "Materials"
    assert fetcher.canonical_sector("Communication") == "Telecommunications"
    assert fetcher.canonical_sector("technology") == "Information Technology"
    # Unmapped names are stored verbatim, never invented or forced onto a neighbour.
    assert fetcher.canonical_sector("Services") == "Services"
    assert fetcher.canonical_sector("Unclassified") == "Unclassified"
    assert fetcher.canonical_sector("") == ""
