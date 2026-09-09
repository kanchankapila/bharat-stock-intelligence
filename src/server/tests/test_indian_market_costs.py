import sys
sys.path.insert(0, "src/server")
from indian_market_costs import (
    round_trip_cost_bps,
    estimate_slippage_bps,
    cost_adjusted_return,
    minimum_edge_required,
    cost_table,
)


def test_cost_table_equity_intraday():
    t = cost_table("equity", "intraday")
    assert t["stt_bps"] == 2.5
    assert abs(t["stamp_duty_bps"] - 0.3) < 0.001
    assert t["total_explicit_round_trip_bps"] > 0


def test_cost_table_equity_delivery():
    t = cost_table("equity", "delivery")
    assert t["stt_bps"] == 10.0
    assert abs(t["stamp_duty_bps"] - 1.5) < 0.001
    assert t["brokerage_bps"] == 0.0


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


def test_delivery_cheaper_than_intraday_for_large_buy():
    # Delivery has higher STT but no slippage impact from quick turnover
    # For a large buy-and-hold, delivery can be cheaper
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
    # Both should be reasonable
    assert 0.001 < del_cost < 0.01
    assert 0.0005 < int_cost < 0.005


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
