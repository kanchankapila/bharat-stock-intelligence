"""Tests for Indian transaction cost model."""
import sys
sys.path.insert(0, "src/server")
from transaction_costs import (
    calculate_indian_costs,
    calculate_round_trip_cost,
    estimate_break_even_move,
    CostParameters,
    CostBreakdown,
)


def test_delivery_buy_costs():
    """Test delivery buy side costs."""
    costs = calculate_indian_costs(1_000_000, is_buy=True, is_delivery=True)
    assert costs.stt > 0  # 0.1% = 1000
    assert costs.stamp_duty > 0  # 0.015% = 150
    assert costs.exchange > 0
    assert costs.sebi > 0
    assert costs.brokerage == 0  # Zero for delivery
    assert costs.gst > 0
    assert costs.slippage > 0
    assert costs.total > 0
    assert costs.total_pct > 0


def test_delivery_sell_costs():
    """Test delivery sell side costs."""
    costs = calculate_indian_costs(1_000_000, is_buy=False, is_delivery=True)
    assert costs.stt > 0  # 0.1% on sell too
    assert costs.stamp_duty == 0  # No stamp on sell (delivery)
    assert costs.brokerage == 0
    assert costs.total > 0


def test_intraday_costs():
    """Test intraday costs (different STT structure)."""
    buy = calculate_indian_costs(1_000_000, is_buy=True, is_delivery=False)
    sell = calculate_indian_costs(1_000_000, is_buy=False, is_delivery=False)
    assert buy.stt == 0  # No STT on intraday buy
    assert sell.stt > 0  # 0.025% on intraday sell
    assert buy.brokerage > 0  # Intraday has brokerage
    assert sell.brokerage > 0


def test_futures_costs():
    """Test futures costs."""
    costs = calculate_indian_costs(1_000_000, is_buy=False, is_futures=True)
    assert costs.stt > 0  # 0.02% on sell
    assert costs.brokerage > 0
    assert costs.stamp_duty > 0


def test_options_costs():
    """Test options costs."""
    costs = calculate_indian_costs(1_000_000, is_buy=False, is_options=True)
    assert costs.stt > 0  # 0.0625% on sell (notional)
    assert costs.stamp_duty > 0


def test_round_trip_delivery():
    """Test round-trip delivery cost."""
    rt = calculate_round_trip_cost(1_000_000, is_delivery=True)
    one_way = calculate_indian_costs(1_000_000, is_buy=True, is_delivery=True)
    # Round trip should be roughly 2x one way (minus stamp duty asymmetry)
    assert rt.total > one_way.total
    assert rt.stt == one_way.stt * 2  # Both sides pay STT
    assert rt.stamp_duty == one_way.stamp_duty  # Only buy side pays stamp


def test_round_trip_intraday():
    """Test round-trip intraday cost."""
    rt = calculate_round_trip_cost(1_000_000, is_delivery=False)
    assert rt.stt > 0  # Only sell side
    assert rt.brokerage > 0  # Both sides
    assert rt.total > 0


def test_slippage_participation_sensitivity():
    """Test that slippage increases with participation rate."""
    low_part = calculate_indian_costs(1_000_000, participation_rate=0.01)
    high_part = calculate_indian_costs(1_000_000, participation_rate=0.10)
    assert high_part.slippage > low_part.slippage


def test_break_even_move():
    """Test break-even calculation."""
    result = estimate_break_even_move(entry_price=500, quantity=100, is_delivery=True)
    assert result["turnover"] == 50_000
    assert result["round_trip_cost"] > 0
    assert result["break_even_move_per_share"] > 0
    assert result["break_even_pct"] > 0
    assert "cost_breakdown" in result


def test_zero_turnover():
    """Test zero turnover returns zero costs."""
    costs = calculate_indian_costs(0)
    assert costs.total == 0
    assert costs.total_pct == 0


def test_custom_parameters():
    """Test custom cost parameters."""
    params = CostParameters(
        stt_delivery_buy=0.002,
        brokerage_delivery=0.0005,
        base_slippage=0.001,
    )
    costs = calculate_indian_costs(1_000_000, is_delivery=True, params=params)
    assert costs.stt == pytest.approx(2000, rel=0.01)  # 0.2%
    assert costs.brokerage == pytest.approx(500, rel=0.01)


def test_cost_breakdown_to_dict():
    """Test CostBreakdown serialization."""
    costs = calculate_indian_costs(1_000_000)
    d = costs.to_dict()
    assert isinstance(d, dict)
    assert "stt" in d
    assert "total" in d
    assert "total_pct" in d


def test_brokerage_override():
    """Test brokerage override."""
    costs = calculate_indian_costs(1_000_000, is_delivery=True, brokerage_override=0.001)
    assert costs.brokerage == pytest.approx(1000, rel=0.01)


import pytest

if __name__ == "__main__":
    test_delivery_buy_costs()
    test_delivery_sell_costs()
    test_intraday_costs()
    test_futures_costs()
    test_options_costs()
    test_round_trip_delivery()
    test_round_trip_intraday()
    test_slippage_participation_sensitivity()
    test_break_even_move()
    test_zero_turnover()
    test_custom_parameters()
    test_cost_breakdown_to_dict()
    test_brokerage_override()
    print("All transaction cost tests passed")
