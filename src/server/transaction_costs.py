"""Indian Equity & Derivatives Transaction Cost Model.

Implements realistic transaction cost calculation for NSE/BSE trading,
including STT, exchange fees, SEBI charges, GST, stamp duty, and slippage.

Usage:
    from transaction_costs import calculate_indian_costs, CostParameters

    costs = calculate_indian_costs(turnover=1_000_000, is_buy=True)
    # Returns CostBreakdown with detailed breakdown
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


@dataclass
class CostParameters:
    """Configurable transaction cost parameters for Indian markets.

    All rates are expressed as decimals (e.g., 0.001 = 0.1%).
    Defaults reflect current NSE equity delivery rates (2026).
    """
    # Securities Transaction Tax
    stt_delivery_buy: float = 0.001       # 0.1% on buy side (delivery)
    stt_delivery_sell: float = 0.001      # 0.1% on sell side (delivery)
    stt_intraday_buy: float = 0.0         # No STT on buy (intraday)
    stt_intraday_sell: float = 0.00025    # 0.025% on sell side (intraday)
    stt_futures_sell: float = 0.0002      # 0.02% on sell side (futures)
    stt_options_sell: float = 0.000625    # 0.0625% on sell side (options, notional)

    # Exchange Transaction Charges
    nse_exchange_buy: float = 0.0000322   # 0.00322% on buy side
    nse_exchange_sell: float = 0.0000322  # 0.00322% on sell side

    # SEBI Turnover Fees
    sebi_fee: float = 0.000001            # 0.0001% per side

    # GST (on brokerage + exchange charges)
    gst_rate: float = 0.18                # 18%

    # Stamp Duty
    stamp_duty_buy: float = 0.00015       # 0.015% on buy side (delivery)
    stamp_duty_sell: float = 0.0000       # No stamp duty on sell (delivery)
    stamp_duty_intraday: float = 0.00003  # 0.003% on intraday
    stamp_duty_futures: float = 0.00002   # 0.002% on futures
    stamp_duty_options: float = 0.00003   # 0.003% on options

    # Brokerage (discount broker typical)
    brokerage_delivery: float = 0.0       # Zero for delivery
    brokerage_intraday: float = 0.0002    # 0.02% or flat per order
    brokerage_futures: float = 0.0002     # 0.02% per side
    brokerage_options: float = 0.0        # Flat per order typically

    # Slippage model
    base_slippage: float = 0.0005         # 5 bps base
    participation_sensitivity: float = 10.0  # Scales with participation rate

    # Minimum charges
    min_brokerage_per_order: float = 0.0  # Some brokers charge flat


@dataclass
class CostBreakdown:
    """Detailed breakdown of transaction costs."""
    stt: float = 0.0
    exchange: float = 0.0
    sebi: float = 0.0
    gst: float = 0.0
    stamp_duty: float = 0.0
    brokerage: float = 0.0
    slippage: float = 0.0
    total: float = 0.0
    total_pct: float = 0.0  # As percentage of turnover

    def to_dict(self) -> dict:
        return {
            "stt": round(self.stt, 2),
            "exchange": round(self.exchange, 2),
            "sebi": round(self.sebi, 2),
            "gst": round(self.gst, 2),
            "stamp_duty": round(self.stamp_duty, 2),
            "brokerage": round(self.brokerage, 2),
            "slippage": round(self.slippage, 2),
            "total": round(self.total, 2),
            "total_pct": round(self.total_pct, 4),
        }


def calculate_indian_costs(
    turnover: float,
    is_buy: bool = True,
    is_delivery: bool = True,
    is_futures: bool = False,
    is_options: bool = False,
    participation_rate: float = 0.01,
    params: Optional[CostParameters] = None,
    brokerage_override: Optional[float] = None,
) -> CostBreakdown:
    """Calculate total transaction costs for Indian equity/derivatives trade.

    Args:
        turnover: Total trade value in INR
        is_buy: True for buy side, False for sell side
        is_delivery: True for delivery-based trade
        is_futures: True for futures trade
        is_options: True for options trade
        participation_rate: Fraction of daily volume traded (affects slippage)
        params: Custom cost parameters (uses defaults if None)
        brokerage_override: Override brokerage rate

    Returns:
        CostBreakdown with detailed cost breakdown
    """
    if turnover <= 0:
        return CostBreakdown()

    if is_futures or is_options:
        is_delivery = False

    p = params or CostParameters()

    # STT calculation
    if is_options:
        stt = turnover * (p.stt_options_sell if not is_buy else 0.0)
    elif is_futures:
        stt = turnover * (p.stt_futures_sell if not is_buy else 0.0)
    elif is_delivery:
        stt = turnover * (p.stt_delivery_buy if is_buy else p.stt_delivery_sell)
    else:  # intraday
        stt = turnover * (p.stt_intraday_sell if not is_buy else 0.0)

    # Exchange charges
    exchange = turnover * (p.nse_exchange_buy if is_buy else p.nse_exchange_sell)

    # SEBI fees
    sebi = turnover * p.sebi_fee

    # Brokerage
    if brokerage_override is not None:
        brokerage = brokerage_override * turnover
    elif is_delivery:
        brokerage = p.brokerage_delivery * turnover
    elif is_futures:
        brokerage = p.brokerage_futures * turnover
    elif is_options:
        brokerage = p.brokerage_options * turnover
    else:
        brokerage = p.brokerage_intraday * turnover

    brokerage = max(brokerage, p.min_brokerage_per_order)
    gst = (brokerage + exchange) * p.gst_rate

    # Stamp duty
    if is_delivery:
        stamp = turnover * (p.stamp_duty_buy if is_buy else p.stamp_duty_sell)
    elif is_futures:
        stamp = turnover * p.stamp_duty_futures
    elif is_options:
        stamp = turnover * p.stamp_duty_options
    else:
        stamp = turnover * p.stamp_duty_intraday

    # Slippage (participation-rate sensitive)
    slippage = turnover * p.base_slippage * (1 + participation_rate * p.participation_sensitivity)

    # Total
    total = stt + exchange + sebi + gst + stamp + brokerage + slippage

    return CostBreakdown(
        stt=stt,
        exchange=exchange,
        sebi=sebi,
        gst=gst,
        stamp_duty=stamp,
        brokerage=brokerage,
        slippage=slippage,
        total=total,
        total_pct=total / turnover if turnover > 0 else 0.0,
    )


def calculate_round_trip_cost(
    turnover: float,
    is_delivery: bool = True,
    is_futures: bool = False,
    is_options: bool = False,
    participation_rate: float = 0.01,
    params: Optional[CostParameters] = None,
) -> CostBreakdown:
    """Calculate round-trip cost (buy + sell) for a complete trade.

    Args:
        turnover: One-way trade value (same for buy and sell)
        is_delivery: Delivery-based trade
        is_futures: Futures trade
        is_options: Options trade
        participation_rate: Fraction of daily volume
        params: Custom cost parameters

    Returns:
        CostBreakdown for the round trip
    """
    buy_costs = calculate_indian_costs(
        turnover, is_buy=True, is_delivery=is_delivery,
        is_futures=is_futures, is_options=is_options,
        participation_rate=participation_rate, params=params
    )
    sell_costs = calculate_indian_costs(
        turnover, is_buy=False, is_delivery=is_delivery,
        is_futures=is_futures, is_options=is_options,
        participation_rate=participation_rate, params=params
    )

    return CostBreakdown(
        stt=buy_costs.stt + sell_costs.stt,
        exchange=buy_costs.exchange + sell_costs.exchange,
        sebi=buy_costs.sebi + sell_costs.sebi,
        gst=buy_costs.gst + sell_costs.gst,
        stamp_duty=buy_costs.stamp_duty + sell_costs.stamp_duty,
        brokerage=buy_costs.brokerage + sell_costs.brokerage,
        slippage=buy_costs.slippage + sell_costs.slippage,
        total=buy_costs.total + sell_costs.total,
        total_pct=(buy_costs.total + sell_costs.total) / turnover if turnover > 0 else 0.0,
    )


def estimate_break_even_move(
    entry_price: float,
    quantity: int,
    is_delivery: bool = True,
    participation_rate: float = 0.01,
    params: Optional[CostParameters] = None,
) -> dict:
    """Estimate the minimum price move needed to break even after costs.

    Args:
        entry_price: Entry price per share
        quantity: Number of shares
        is_delivery: Delivery-based trade
        participation_rate: Fraction of daily volume
        params: Custom cost parameters

    Returns:
        Dict with break-even info
    """
    turnover = entry_price * quantity
    rt_costs = calculate_round_trip_cost(
        turnover, is_delivery=is_delivery,
        participation_rate=participation_rate, params=params
    )

    break_even_move = rt_costs.total / quantity if quantity > 0 else 0.0
    break_even_pct = (break_even_move / entry_price * 100) if entry_price > 0 else 0.0

    return {
        "turnover": turnover,
        "round_trip_cost": rt_costs.total,
        "cost_per_share": rt_costs.total / quantity if quantity > 0 else 0.0,
        "break_even_move_per_share": break_even_move,
        "break_even_pct": break_even_pct,
        "cost_breakdown": rt_costs.to_dict(),
    }
