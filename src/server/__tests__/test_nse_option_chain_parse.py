"""NSE option-chain-v3 as a coverage fallback for so_option_chain.

Why this exists: Trendlyne SmartOptions enforces a cumulative REQUEST ALLOWANCE, measured
live 2026-09-05 -- a full 210-symbol pass costs 115s (well inside its 30-min budget) but
succeeds for only ~160 requests before failing 41 of the last 50 in a block. Because the
universe was iterated alphabetically from a fixed start, the SAME 34 names past ~SRF (TCS,
TITAN, TATASTEEL, TRENT, VEDL, WIPRO...) had zero rows in 30 days while the job exited 0.

NSE's own endpoint was recorded in so_chain_source.py as dead ("HTTP 200 with a literal empty
{}"). Re-measured 2026-09-05: that is true only WITHOUT an `expiry` query parameter. WITH one,
`option-chain-v3?type=Equity&symbol=TCS&expiry=29-Sep-2026` returns 97KB and 47 strikes, and
returned data for all 8 of the names pcr_fetcher reports as uncovered. It is the authoritative
source, free, and has no request allowance.

It is a FALLBACK, not a replacement: NSE publishes OI/IV/price/volume but NO Greeks and no
buildup label, which Trendlyne does. So Trendlyne stays primary for full rows and NSE fills
the symbols the allowance refused -- real OI/IV rows with NULL Greeks beat no rows at all.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nse_option_chain_source import parse_nse_chain

# Shaped exactly like a real records payload (field names copied from a live TCS response).
PAYLOAD = {
    "records": {
        "underlyingValue": 2304,
        "data": [
            {"strikePrice": 2200,
             "CE": {"lastPrice": 130.0, "totalTradedVolume": 100, "openInterest": 500,
                    "changeinOpenInterest": 25, "impliedVolatility": 24.5},
             "PE": {"lastPrice": 20.0, "totalTradedVolume": 200, "openInterest": 900,
                    "changeinOpenInterest": -10, "impliedVolatility": 22.0}},
            {"strikePrice": 2300,
             "CE": {"lastPrice": 66.7, "totalTradedVolume": 3132, "openInterest": 2960,
                    "changeinOpenInterest": 246, "impliedVolatility": 23.51},
             "PE": {"lastPrice": 60.0, "totalTradedVolume": 400, "openInterest": 1040,
                    "changeinOpenInterest": 5, "impliedVolatility": 23.0}},
            # NSE genuinely sends rows carrying only one leg at far strikes.
            {"strikePrice": 2400,
             "CE": {"lastPrice": 12.0, "totalTradedVolume": 10, "openInterest": 100,
                    "changeinOpenInterest": 0, "impliedVolatility": 26.0}},
        ],
    }
}


def rows_and_summary():
    return parse_nse_chain(PAYLOAD, "TCS", "2026-09-05", "2026-09-29")


def test_maps_both_legs_oi_iv_price_and_volume():
    rows, _ = rows_and_summary()
    by_strike = {r[3]: r for r in rows}
    r = by_strike[2300.0]
    assert r[0] == "TCS" and r[1] == "2026-09-05" and r[2] == "2026-09-29"
    assert (r[4], r[5], r[6], r[7], r[8]) == (66.7, 3132.0, 2960.0, 246.0, 23.51)   # CE
    assert (r[16], r[17], r[18], r[19], r[20]) == (60.0, 400.0, 1040.0, 5.0, 23.0)  # PE


def test_greeks_are_none_not_zero():
    """NSE does not publish Greeks. Writing 0.0 would be a sentinel indistinguishable from a
    real zero delta -- recurring-bugs.md's sentinel-instead-of-NULL class, which is explicitly
    NOT retroactively fixable."""
    rows, _ = rows_and_summary()
    r = next(r for r in rows if r[3] == 2300.0)
    for i in (9, 10, 11, 12, 13, 14, 15):   # ce_iv_chg, delta, gamma, theta, vega, rho, buildup
        assert r[i] is None, f"CE index {i} should be None, got {r[i]!r}"
    for i in (21, 22, 23, 24, 25, 26, 27):
        assert r[i] is None, f"PE index {i} should be None, got {r[i]!r}"


def test_row_arity_matches_the_trendlyne_parser():
    """Control against drift: both parsers feed the same save_chain INSERT, so a shape change
    in either must fail here rather than silently shifting every column by one."""
    rows, _ = rows_and_summary()
    assert all(len(r) == 28 for r in rows)


def test_a_single_leg_row_still_yields_a_row_with_the_other_leg_null():
    rows, _ = rows_and_summary()
    r = next(r for r in rows if r[3] == 2400.0)
    assert r[4] == 12.0          # CE present
    assert r[16] is None         # PE absent -> NULL, not 0.0


def test_summary_pcr_is_total_put_oi_over_total_call_oi():
    _, summary = rows_and_summary()
    assert summary["pcr"] == (900 + 1040) / (500 + 2960 + 100)


def test_summary_atm_is_the_strike_nearest_the_underlying():
    _, summary = rows_and_summary()
    assert summary["atm"] == 2300.0
    assert summary["iv_call"] == 23.51 and summary["iv_put"] == 23.0


def test_max_pain_is_computed_since_nse_does_not_publish_it():
    _, summary = rows_and_summary()
    assert summary["max_pain"] in (2200.0, 2300.0, 2400.0)


def test_an_empty_payload_yields_no_rows_rather_than_raising():
    rows, summary = parse_nse_chain({}, "TCS", "2026-09-05", "2026-09-29")
    assert rows == [] and summary is None
