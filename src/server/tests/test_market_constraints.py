import sys
sys.path.insert(0, "src/server")
from market_constraints import (
    MarketConstraints,
    round_to_lot_size,
    is_near_circuit,
    adjust_position_for_liquidity,
    cost_hurdle_check,
    adjust_position_for_cost_and_liquidity,
)


def test_lot_size_rounding():
    assert round_to_lot_size(100, 50) == 100
    assert round_to_lot_size(123, 50) == 100
    assert round_to_lot_size(49, 50) == 0
    assert round_to_lot_size(0, 50) == 0
    assert round_to_lot_size(100, 1) == 100


def test_circuit_detection():
    assert is_near_circuit(0.15, circuit_band_pct=0.20) is True
    assert is_near_circuit(0.10, circuit_band_pct=0.20) is False
    assert is_near_circuit(-0.15, circuit_band_pct=0.20) is True
    assert is_near_circuit(0.0, circuit_band_pct=0.20) is False


def test_circuit_locked():
    mc = MarketConstraints(circuit_band_pct=0.20)
    assert mc.is_circuit_locked(0.19) is True
    assert mc.is_circuit_locked(-0.19) is True
    assert mc.is_circuit_locked(0.10) is False


def test_liquidity_cap():
    mc = MarketConstraints(max_participation_rate=0.05)
    price = 100.0
    adt_value = 1_000_000.0
    max_qty = mc.max_quantity_by_liquidity(price, adt_value)
    # 5% of 1,000,000 = 50,000 / 100 = 500
    assert max_qty == 500


def test_full_pipeline():
    mc = MarketConstraints(lot_size=50, circuit_band_pct=0.20, max_participation_rate=0.05)
    result = mc.adjust_position_for_liquidity(
        target_value=100_000,
        price=100.0,
        adt_value=1_000_000,
        current_pct_from_prev=0.0,
    )
    # 5% of ADT = 50K / 100 = 500, rounded to 50 = 500
    assert result["quantity"] == 500
    assert result["was_capped"] is True
    assert result["reason"] == "liquidity_capped"


def test_circuit_blocks_entry():
    mc = MarketConstraints(lot_size=50, circuit_band_pct=0.20)
    result = mc.adjust_position_for_liquidity(
        target_value=100_000,
        price=100.0,
        adt_value=10_000_000,
        current_pct_from_prev=0.19,
    )
    assert result["quantity"] == 0
    assert result["reason"] == "circuit_locked"


def test_near_circuit_reduces():
    mc = MarketConstraints(lot_size=1, circuit_band_pct=0.20, max_participation_rate=0.50)
    result = mc.adjust_position_for_liquidity(
        target_value=100_000,
        price=100.0,
        adt_value=1_000_000,
        current_pct_from_prev=0.15,
    )
    assert result["was_reduced"] is True
    assert result["reason"] == "near_circuit"


def test_standalone_function():
    result = adjust_position_for_liquidity(
        target_value=300_000,
        price=500.0,
        adt_value=5_000_000,
        lot_size=25,
        max_participation_rate=0.05,
    )
    # 5% of 5M = 250K / 500 = 500, rounded to 25 = 500
    assert result["quantity"] == 500


def test_cost_hurdle_check():
    # Healthy expected return of 3.0% vs delivery round trip (~0.3-0.4%)
    res_pass = cost_hurdle_check(expected_return_pct=3.0, turnover=500_000, is_delivery=True)
    assert res_pass["passed"] is True
    assert res_pass["net_edge_pct"] > 0
    assert res_pass["cost_pct"] > 0

    # Weak return of 0.1% does not clear round trip cost
    res_fail = cost_hurdle_check(expected_return_pct=0.1, turnover=500_000, is_delivery=True)
    assert res_fail["passed"] is False
    assert res_fail["net_edge_pct"] < 0


def test_insufficient_cost_hurdle_blocks_entry():
    mc = MarketConstraints(lot_size=10)
    # Expected return is tiny (0.05%), cost is ~0.35%
    result = mc.adjust_position_for_liquidity(
        target_value=100_000,
        price=100.0,
        adt_value=10_000_000,
        expected_return_pct=0.05,
    )
    assert result["quantity"] == 0
    assert result["was_reduced"] is True
    assert result["reason"] == "insufficient_cost_hurdle"


def test_cost_penalty_scales_down():
    mc = MarketConstraints(lot_size=1)
    # If cost is ~0.35% and expected return is 0.50%, cost is > 50% of edge (0.35 >= 0.25)
    # So position should be halved
    result = mc.adjust_position_for_liquidity(
        target_value=100_000,
        price=100.0,
        adt_value=10_000_000,
        expected_return_pct=0.50,
    )
    # Target qty 1000 halved to 500
    assert result["quantity"] == 500
    assert result["was_reduced"] is True
    assert result["reason"] == "cost_penalty"


def test_adjust_position_for_cost_and_liquidity():
    result = adjust_position_for_cost_and_liquidity(
        target_value=200_000,
        price=200.0,
        adt_value=10_000_000,
        expected_return_pct=4.0,  # strong return
        lot_size=25,
    )
    # Target qty = 1000, passes hurdle easily
    assert result["quantity"] == 1000
    assert result["was_reduced"] is False
    assert result["reason"] == "ok"


if __name__ == "__main__":
    test_lot_size_rounding()
    test_circuit_detection()
    test_circuit_locked()
    test_liquidity_cap()
    test_full_pipeline()
    test_circuit_blocks_entry()
    test_near_circuit_reduces()
    test_standalone_function()
    test_cost_hurdle_check()
    test_insufficient_cost_hurdle_blocks_entry()
    test_cost_penalty_scales_down()
    test_adjust_position_for_cost_and_liquidity()
    print("All market constraints tests passed")
