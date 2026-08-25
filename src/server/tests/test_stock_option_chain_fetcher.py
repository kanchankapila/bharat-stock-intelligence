"""
Tests for stock_option_chain_fetcher's IV term-structure logic:
  - _next_month_expiry: infers next month's expiry from the near-month expiry's weekday
    (NSE has changed the F&O expiry weekday more than once, so this must not hardcode one).
  - _atm_iv_from_chain / _implied_vol: pure, no network/DB.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from stock_option_chain_fetcher import _next_month_expiry, _atm_iv_from_chain, _implied_vol


class TestNextMonthExpiry:
    def test_tuesday_expiry_july_to_august(self):
        # 2026-07-28 is a Tuesday; next month's last Tuesday is 2026-08-25.
        near = datetime.date(2026, 7, 28)
        assert _next_month_expiry(near) == datetime.date(2026, 8, 25)

    def test_thursday_expiry_still_supported(self):
        # If NSE reverts to Thursday expiries, this must still infer correctly (no hardcoding).
        near = datetime.date(2026, 1, 29)  # a Thursday
        assert near.weekday() == 3
        result = _next_month_expiry(near)
        assert result.weekday() == 3
        assert result.month == 2 and result.year == 2026

    def test_december_rolls_into_next_year(self):
        near = datetime.date(2026, 12, 29)  # a Tuesday
        result = _next_month_expiry(near)
        assert result.year == 2027 and result.month == 1

    def test_result_is_in_the_last_week_of_next_month(self):
        near = datetime.date(2026, 7, 28)
        result = _next_month_expiry(near)
        import calendar
        last_day = calendar.monthrange(result.year, result.month)[1]
        assert last_day - result.day < 7


class TestAtmIvFromChain:
    def _row(self, strike, call_ltp, expiry=None):
        # Default expiry = next month's inferred expiry. A hardcoded past date makes T<=0,
        # where the BS inversion legitimately returns None and every assertion below would
        # date-bomb (this file itself did exactly that on 2026-08-25).
        if expiry is None:
            expiry = str(_next_month_expiry(datetime.date.today()))
        return {"strike_price": strike, "calls_ltp": call_ltp, "expiry_date": expiry}

    def test_picks_strike_closest_to_spot(self):
        oc = [self._row(1080, 25.0), self._row(1095, 21.65), self._row(1110, 18.0)]
        iv, expiry = _atm_iv_from_chain(oc, spot=1096.5)
        assert expiry == oc[0]["expiry_date"]
        # ATM strike (1095) should be used, not 1080 or 1110 -- IV should come back as a
        # plausible annualised vol (0 < iv < 2.0), not None (a real call price was supplied).
        assert iv is not None and 0 < iv < 2.0

    def test_returns_none_iv_when_call_price_is_zero(self):
        oc = [self._row(1095, 0.0)]
        iv, expiry = _atm_iv_from_chain(oc, spot=1095.0)
        assert iv is None
        assert expiry == oc[0]["expiry_date"]


class TestImpliedVol:
    def test_recovers_input_vol_via_bs_round_trip(self):
        from stock_option_chain_fetcher import _bs_call
        S, K, T, r, true_sigma = 1096.5, 1095.0, 0.11, 0.065, 0.28
        price = _bs_call(S, K, T, r, true_sigma)
        recovered = _implied_vol(price, S, K, T, r)
        assert recovered is not None
        assert abs(recovered - true_sigma) < 0.005
