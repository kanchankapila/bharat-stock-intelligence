import sys
sys.path.insert(0, "src/server")
import pytest

from indian_market_costs import (
    round_trip_cost_bps,
    estimate_slippage_bps,
    cost_adjusted_return,
    minimum_edge_required,
    cost_table,
    equity_trade_type_for_timeframe,
)


def test_cost_table_equity_intraday():
    t = cost_table("equity", "intraday")
    assert t["stt_bps"] == 2.5
    assert abs(t["stamp_duty_bps"] - 0.3) < 0.001
    # NSE cash-market transaction charge + IPFT is Rs 307/crore/side from 2026-03-01.
    assert t["exchange_bps"] == pytest.approx(0.307, abs=0.0001)
    assert t["total_explicit_round_trip_bps"] == pytest.approx(8.2645, abs=0.001)


def test_cost_table_equity_delivery():
    t = cost_table("equity", "delivery")
    assert t["stt_bps"] == 10.0
    assert abs(t["stamp_duty_bps"] - 1.5) < 0.001
    assert t["brokerage_bps"] == 0.0
    # Delivery STT is charged on both purchase and sale: 10bps + 10bps.
    assert t["total_explicit_round_trip_bps"] == pytest.approx(22.2445, abs=0.001)


def test_round_trip_cost_largecap():
    cost = round_trip_cost_bps(
        asset_class="equity",
        trade_type="intraday",
        participation_rate=0.01,
        market_cap_cr=50000,
        volatility_pct=2.0,
    )
    assert 0.001 < cost < 0.005


def test_round_trip_cost_smallcap():
    cost_sc = round_trip_cost_bps(
        asset_class="equity",
        trade_type="intraday",
        participation_rate=0.05,
        market_cap_cr=500,
        volatility_pct=3.0,
    )
    cost_lc = round_trip_cost_bps(
        asset_class="equity",
        trade_type="intraday",
        participation_rate=0.05,
        market_cap_cr=50000,
        volatility_pct=3.0,
    )
    assert cost_sc > cost_lc


def test_slippage_scales_with_participation():
    s1 = estimate_slippage_bps(participation_rate=0.01, market_cap_cr=50000)
    s4 = estimate_slippage_bps(participation_rate=0.04, market_cap_cr=50000)
    assert s4 > s1


def test_cost_adjusted_return():
    net = cost_adjusted_return(5.0, 0.002)
    assert abs(net - 4.8) < 0.001


def test_minimum_edge_required():
    edge = minimum_edge_required(0.002, hit_rate=0.55, avg_win_loss_ratio=1.5)
    assert edge > 0


def test_explicit_only():
    cost = round_trip_cost_bps(
        asset_class="equity",
        trade_type="intraday",
        include_slippage=False,
    )
    assert 0.0005 < cost < 0.002


def test_delivery_cost_is_not_priced_as_intraday():
    # A multi-session cash-equity recommendation takes delivery. Delivery STT applies on both
    # legs and must exceed the otherwise-identical intraday charge.
    del_cost = round_trip_cost_bps(
        asset_class="equity",
        trade_type="delivery",
        participation_rate=0.001,
        market_cap_cr=100000,
        volatility_pct=1.5,
    )
    int_cost = round_trip_cost_bps(
        asset_class="equity",
        trade_type="intraday",
        participation_rate=0.001,
        market_cap_cr=100000,
        volatility_pct=1.5,
    )
    assert del_cost > int_cost


def test_2026_derivatives_stt_is_sell_leg_only():
    # Finance Act 2026 rates from 2026-04-01: futures 0.05%, options 0.15% on the
    # sale leg. A round trip must not double either sell-only levy.
    fut = cost_table("futures", "intraday")
    opt = cost_table("options", "intraday")
    assert fut["stt_bps"] == 5.0
    assert opt["stt_bps"] == 15.0
    assert fut["total_explicit_round_trip_bps"] == pytest.approx(10.3719, abs=0.001)
    assert opt["total_explicit_round_trip_bps"] == pytest.approx(28.4251, abs=0.001)


@pytest.mark.parametrize("timeframe", ["INTRADAY", "intraday"])
def test_intraday_horizon_uses_non_delivery_charges(timeframe):
    assert equity_trade_type_for_timeframe(timeframe) == "intraday"


@pytest.mark.parametrize(
    "timeframe", ["SWING", "POSITIONAL", "short_term", "long_term", "medium", None]
)
def test_multi_session_horizons_use_delivery_charges(timeframe):
    assert equity_trade_type_for_timeframe(timeframe) == "delivery"


if __name__ == "__main__":
    test_cost_table_equity_intraday()
    test_cost_table_equity_delivery()
    test_round_trip_cost_largecap()
    test_round_trip_cost_smallcap()
    test_slippage_scales_with_participation()
    test_cost_adjusted_return()
    test_minimum_edge_required()
    test_explicit_only()
    test_delivery_cheaper_than_intraday_for_large_buy()
    print("All cost model tests passed")
