"""Cost-Aware Position Sizing for Indian Markets.

Integrates transaction costs into position sizing decisions,
adjusting for the economic impact of commissions, fees, and slippage.

Usage:
    from cost_aware_sizing import CostAwareSizer

    sizer = CostAwareSizer(base_capital=10_00_000)
    sizing = sizer.size_position(score=0.85, price=1500, adt_value=5_00_000, atr=45)
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional

from transaction_costs import calculate_round_trip_cost
from market_constraints import MarketConstraints


@dataclass
class SizingResult:
    """Result of cost-aware position sizing."""
    target_quantity: int = 0
    target_value: float = 0.0
    target_pct: float = 0.0
    cost_pct: float = 0.0
    expected_cost: float = 0.0
    risk_value: float = 0.0
    rr_ratio: float = 0.0
    was_capped: bool = False
    was_reduced: bool = False
    reason: str = "ok"
    break_even_move: float = 0.0
    break_even_pct: float = 0.0


class CostAwareSizer:
    """Position sizer that accounts for transaction costs and market constraints."""

    def __init__(
        self,
        base_capital: float,
        max_position_pct: float = 0.20,
        min_position_pct: float = 0.02,
        risk_per_trade_pct: float = 0.02,
        participation_rate: float = 0.05,
        lot_size: int = 1,
        circuit_band_pct: float = 0.20,
        max_participation_rate: float = 0.10,
    ):
        self.base_capital = base_capital
        self.max_position_pct = max_position_pct
        self.min_position_pct = min_position_pct
        self.risk_per_trade_pct = risk_per_trade_pct
        self.participation_rate = participation_rate
        self.constraints = MarketConstraints(
            lot_size=lot_size,
            circuit_band_pct=circuit_band_pct,
                        max_participation_rate=max_participation_rate,
        )

    def size_position(
        self,
        score: float,
        price: float,
        adt_value: float,
        atr: float,
        entry_price: Optional[float] = None,
        is_delivery: bool = True,
        current_pct_from_prev: float = 0.0,
    ) -> SizingResult:
        """Size a position accounting for costs and constraints.

        Args:
            score: Conviction score (0-1, scales position linearly)
            price: Current price
            adt_value: Average daily turnover in INR
            atr: Average True Range
            entry_price: Expected entry price (defaults to current)
            is_delivery: Delivery-based trade (affects costs)
            current_pct_from_prev: How close to circuit (affects sizing)

        Returns:
            SizingResult with all sizing information
        """
        if price <= 0 or adt_value <= 0 or atr <= 0:
            return SizingResult(reason="invalid_inputs")

        entry_price = entry_price or price
        score = max(0.0, min(1.0, score))

        # Conviction-based target
        raw_pct = self.min_position_pct + (self.max_position_pct - self.min_position_pct) * score
        raw_value = self.base_capital * raw_pct

        # Risk-based sizing
        risk_per_trade = self.base_capital * self.risk_per_trade_pct
        risk_per_share = atr
        risk_based_qty = int(risk_per_trade / risk_per_share)
        risk_based_value = risk_based_qty * price

        # Use smaller of conviction-based and risk-based
        target_value = min(raw_value, risk_based_value)

        # Apply market constraints
        constraint_result = self.constraints.adjust_position_for_liquidity(
            target_value=target_value,
            price=entry_price,
            adt_value=adt_value,
                        current_pct_from_prev=current_pct_from_prev,
        )

        if constraint_result["quantity"] == 0:
            return SizingResult(
                target_value=0.0,
                was_capped=constraint_result["was_capped"],
                was_reduced=constraint_result["was_reduced"],
                reason=constraint_result["reason"],
            )

        qty = constraint_result["quantity"]
        actual_value = qty * entry_price

        # Calculate transaction costs
        cost = calculate_round_trip_cost(
            turnover=actual_value,
            is_delivery=is_delivery,
            participation_rate=self.participation_rate,
        )

        # Risk metrics
        risk_value = qty * atr
        cost_pct = cost.total / actual_value if actual_value > 0 else 0.0
        be_move = cost.total / qty if qty > 0 else 0.0
        be_pct = (be_move / entry_price * 100) if entry_price > 0 else 0.0

        # Reward-to-risk with 2R target
        reward = 2 * risk_value
        rr = reward / (risk_value + cost.total) if risk_value > 0 else 0.0

        return SizingResult(
            target_quantity=qty,
            target_value=actual_value,
            target_pct=actual_value / self.base_capital,
            cost_pct=cost_pct,
            expected_cost=cost.total,
            risk_value=risk_value,
            rr_ratio=rr,
            was_capped=constraint_result["was_capped"],
            was_reduced=constraint_result["was_reduced"],
            reason=constraint_result["reason"],
            break_even_move=be_move,
            break_even_pct=be_pct,
        )

    def is_trade_economically_viable(
        self,
        score: float,
        price: float,
        adt_value: float,
        atr: float,
        min_rr: float = 1.5,
        min_score: float = 0.5,
    ) -> bool:
        """Quick viability check before sizing."""
        if score < min_score:
            return False
        result = self.size_position(score, price, adt_value, atr)
        if result.target_value <= 0:
            return False
        return result.rr_ratio >= min_rr

