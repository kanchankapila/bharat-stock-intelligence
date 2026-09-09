"""Market Constraints for Indian Equity & Derivatives.

Implements circuit breaker awareness, lot size rounding, and
liquidity-adjusted position sizing for NSE/BSE trading.

Usage:
    from market_constraints import (
        round_to_lot_size,
        is_near_circuit,
        adjust_position_for_liquidity,
        MarketConstraints,
    )
"""
from __future__ import annotations
import math
from typing import Optional
from transaction_costs import calculate_round_trip_cost


# NSE circuit limit bands (index-level and stock-level)
# These are the standard daily price bands
CIRCUIT_LIMITS = {
    "index_10": 0.10,   # 10% - market-wide circuit breaker
    "index_15": 0.15,   # 15% - second level
    "index_20": 0.20,   # 20% - third level (market halts)
    "stock_5": 0.05,    # 5% - illiquid stocks
    "stock_10": 0.10,   # 10% - most stocks
    "stock_20": 0.20,   # 20% - liquid stocks / F&O
    "stock_40": 0.40,   # 40% - newly listed (first day)
}

# Threshold for "near circuit" warning (fraction of band)
NEAR_CIRCUIT_THRESHOLD = 0.70  # 70% of circuit limit


class MarketConstraints:
    """Encapsulates market constraints for position sizing."""

    def __init__(
        self,
        lot_size: int = 1,
        circuit_band_pct: float = 0.20,
        max_participation_rate: float = 0.05,
        min_daily_turnover_cr: float = 1.0,
    ):
        self.lot_size = max(1, lot_size)
        self.circuit_band_pct = circuit_band_pct
        self.max_participation_rate = max_participation_rate
        self.min_daily_turnover_cr = min_daily_turnover_cr

    def round_to_lot_size(self, quantity: int) -> int:
        """Round quantity down to nearest lot size multiple."""
        if self.lot_size <= 1:
            return max(0, quantity)
        return (quantity // self.lot_size) * self.lot_size

    def round_to_lot_value(self, value: float, price: float) -> tuple[int, float]:
        """Convert a target value to lot-rounded quantity and actual value.

        Returns:
            (quantity, actual_value) - both lot-size constrained
        """
        if price <= 0:
            return 0, 0.0
        raw_qty = int(value / price)
        rounded_qty = self.round_to_lot_size(raw_qty)
        actual_value = rounded_qty * price
        return rounded_qty, actual_value

    def is_near_circuit(self, current_pct_from_prev: float) -> bool:
        """Check if a stock has moved significantly toward its circuit limit.

        Args:
            current_pct_from_prev: Today\'s move as fraction (e.g. 0.15 for 15%)

        Returns:
            True if near circuit limit
        """
        threshold = self.circuit_band_pct * NEAR_CIRCUIT_THRESHOLD
        return abs(current_pct_from_prev) >= threshold

    def is_circuit_locked(self, current_pct_from_prev: float) -> bool:
        """Check if a stock is at or beyond its circuit limit."""
        return abs(current_pct_from_prev) >= self.circuit_band_pct * 0.95

    def max_quantity_by_liquidity(
        self,
        price: float,
        adt_value: float,
    ) -> int:
        """Calculate maximum quantity based on liquidity constraint.

        Args:
            price: Current stock price
            adt_value: Average daily turnover in same units

        Returns:
            Maximum quantity that respects participation rate
        """
        if price <= 0 or adt_value <= 0:
            return 0
        max_value = adt_value * self.max_participation_rate
        return int(max_value / price)

    def cost_hurdle_check(
        self,
        expected_return_pct: float,
        turnover: float,
        is_delivery: bool = True,
        participation_rate: Optional[float] = None,
    ) -> dict:
        """Evaluate if expected return clears the round-trip transaction cost hurdle.

        Args:
            expected_return_pct: Expected return as percentage (e.g., 2.5 for 2.5%)
            turnover: Trade value in INR
            is_delivery: True for delivery, False for intraday
            participation_rate: Fraction of daily volume traded

        Returns:
            Dict with passed, expected_return_pct, cost_pct, round_trip_cost, net_edge_pct
        """
        if turnover <= 0:
            return {
                "passed": False,
                "expected_return_pct": expected_return_pct,
                "cost_pct": 0.0,
                "round_trip_cost": 0.0,
                "net_edge_pct": expected_return_pct,
            }

        p_rate = participation_rate if participation_rate is not None else self.max_participation_rate
        cost_breakdown = calculate_round_trip_cost(
            turnover=turnover,
            is_delivery=is_delivery,
            participation_rate=p_rate,
        )
        cost_pct = (cost_breakdown.total / turnover) * 100.0 if turnover > 0 else 0.0
        passed = expected_return_pct > cost_pct
        net_edge = expected_return_pct - cost_pct

        return {
            "passed": passed,
            "expected_return_pct": expected_return_pct,
            "cost_pct": cost_pct,
            "round_trip_cost": cost_breakdown.total,
            "net_edge_pct": net_edge,
        }

    def adjust_position_for_liquidity(
        self,
        target_value: float,
        price: float,
        adt_value: float,
        current_pct_from_prev: float = 0.0,
        expected_return_pct: Optional[float] = None,
        is_delivery: bool = True,
    ) -> dict:
        """Full position adjustment pipeline.

        Applies constraints in order:
        1. Liquidity cap (participation rate)
        2. Circuit breaker reduction
        3. Cost hurdle check (if expected_return_pct provided)
        4. Lot size rounding

        Returns:
            Dict with keys: quantity, value, was_capped, was_reduced, reason
        """
        if price <= 0:
            return {
                "quantity": 0,
                "value": 0.0,
                "was_capped": False,
                "was_reduced": False,
                "reason": "invalid_price",
            }

        # Step 1: Liquidity cap
        max_qty = self.max_quantity_by_liquidity(price, adt_value)
        target_qty = int(target_value / price)
        was_capped = False

        if max_qty > 0 and target_qty > max_qty:
            target_qty = max_qty
            was_capped = True

        # Step 2: Circuit breaker reduction
        was_reduced = False
        if self.is_circuit_locked(current_pct_from_prev):
            target_qty = 0
            was_reduced = True
            reason = "circuit_locked"
        elif self.is_near_circuit(current_pct_from_prev):
            # Reduce position by 50% when near circuit
            target_qty = target_qty // 2
            was_reduced = True
            reason = "near_circuit"
        else:
            reason = "ok" if not was_capped else "liquidity_capped"

        # Step 3: Cost hurdle check
        if target_qty > 0 and expected_return_pct is not None:
            turnover = target_qty * price
            part_rate = (turnover / adt_value) if adt_value > 0 else self.max_participation_rate
            hurdle = self.cost_hurdle_check(
                expected_return_pct=expected_return_pct,
                turnover=turnover,
                is_delivery=is_delivery,
                participation_rate=min(part_rate, 0.25),
            )
            if not hurdle["passed"]:
                target_qty = 0
                was_reduced = True
                reason = "insufficient_cost_hurdle"
            elif hurdle["cost_pct"] >= 0.5 * expected_return_pct:
                target_qty = target_qty // 2
                was_reduced = True
                reason = "cost_penalty"

        # Step 4: Lot size rounding
        final_qty = self.round_to_lot_size(target_qty)
        final_value = final_qty * price

        return {
            "quantity": final_qty,
            "value": final_value,
            "was_capped": was_capped,
            "was_reduced": was_reduced,
            "reason": reason,
        }


def round_to_lot_size(quantity: int, lot_size: int) -> int:
    """Standalone function: round quantity to lot size."""
    if lot_size <= 1:
        return max(0, quantity)
    return (quantity // lot_size) * lot_size


def is_near_circuit(
    current_pct_from_prev: float,
    circuit_band_pct: float = 0.20,
    threshold: float = 0.70,
) -> bool:
    """Standalone function: check if near circuit limit."""
    limit = circuit_band_pct * threshold
    return abs(current_pct_from_prev) >= limit


def cost_hurdle_check(
    expected_return_pct: float,
    turnover: float,
    is_delivery: bool = True,
    participation_rate: float = 0.05,
) -> dict:
    """Standalone function: check expected return vs transaction costs."""
    mc = MarketConstraints(max_participation_rate=participation_rate)
    return mc.cost_hurdle_check(
        expected_return_pct=expected_return_pct,
        turnover=turnover,
        is_delivery=is_delivery,
        participation_rate=participation_rate,
    )


def adjust_position_for_liquidity(
    target_value: float,
    price: float,
    adt_value: float,
    lot_size: int = 1,
    max_participation_rate: float = 0.05,
    current_pct_from_prev: float = 0.0,
    circuit_band_pct: float = 0.20,
    expected_return_pct: Optional[float] = None,
    is_delivery: bool = True,
) -> dict:
    """Standalone function: full position adjustment pipeline."""
    mc = MarketConstraints(
        lot_size=lot_size,
        circuit_band_pct=circuit_band_pct,
        max_participation_rate=max_participation_rate,
    )
    return mc.adjust_position_for_liquidity(
        target_value=target_value,
        price=price,
        adt_value=adt_value,
        current_pct_from_prev=current_pct_from_prev,
        expected_return_pct=expected_return_pct,
        is_delivery=is_delivery,
    )


def adjust_position_for_cost_and_liquidity(
    target_value: float,
    price: float,
    adt_value: float,
    expected_return_pct: float,
    lot_size: int = 1,
    max_participation_rate: float = 0.05,
    current_pct_from_prev: float = 0.0,
    circuit_band_pct: float = 0.20,
    is_delivery: bool = True,
) -> dict:
    """Explicit convenience function for cost-and-liquidity adjusted sizing."""
    return adjust_position_for_liquidity(
        target_value=target_value,
        price=price,
        adt_value=adt_value,
        lot_size=lot_size,
        max_participation_rate=max_participation_rate,
        current_pct_from_prev=current_pct_from_prev,
        circuit_band_pct=circuit_band_pct,
        expected_return_pct=expected_return_pct,
        is_delivery=is_delivery,
    )
