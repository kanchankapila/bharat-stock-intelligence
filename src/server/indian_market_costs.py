"""Indian Equity & Derivatives Transaction Cost Model."""
from __future__ import annotations
import math
from typing import Literal

STT_RATES = {
    ("equity", "delivery"): 0.001,
    ("equity", "intraday"): 0.00025,
    ("futures", "intraday"): 0.0001,
    ("options", "intraday"): 0.0005,
}
EXCHANGE_TXN_CHARGES = 0.0000345
SEBI_TURNOVER_FEE = 0.000001
GST_RATE = 0.18
STAMP_DUTY_RATES = {
    ("equity", "delivery"): 0.00015,
    ("equity", "intraday"): 0.00003,
    ("futures", "intraday"): 0.00002,
    ("options", "intraday"): 0.00003,
}
BROKERAGE_RATES = {
    ("equity", "delivery"): 0.0,
    ("equity", "intraday"): 0.0002,
    ("futures", "intraday"): 0.0002,
    ("options", "intraday"): 0.0002,
}
SLIPPAGE_BASE_BPS = {
    "largecap": 0.0002,
    "midcap": 0.0005,
    "smallcap": 0.0010,
    "microcap": 0.0025,
}
MARKET_CAP_TIERS = [
    (20000, "largecap"),
    (5000, "midcap"),
    (1000, "smallcap"),
    (0, "microcap"),
]

def _market_cap_tier(market_cap_cr):
    if market_cap_cr is None or not math.isfinite(market_cap_cr) or market_cap_cr <= 0:
        return "midcap"
    for threshold, tier in MARKET_CAP_TIERS:
        if market_cap_cr >= threshold:
            return tier
    return "microcap"


def estimate_slippage_bps(participation_rate=0.01, market_cap_cr=None, volatility_pct=None):
    tier = _market_cap_tier(market_cap_cr)
    base = SLIPPAGE_BASE_BPS[tier]
    participation_mult = math.sqrt(max(participation_rate, 0.0001) / 0.01)
    vol_mult = 1.0
    if volatility_pct is not None and volatility_pct > 0 and math.isfinite(volatility_pct):
        vol_mult = max(0.5, min(3.0, volatility_pct / 2.0))
    return base * participation_mult * vol_mult


def round_trip_cost_bps(
    notional=1.0,
    asset_class="equity",
    trade_type="intraday",
    participation_rate=0.01,
    market_cap_cr=None,
    volatility_pct=None,
    include_slippage=True,
):
    key = (asset_class, trade_type)
    stt_rate = STT_RATES.get(key, 0.001)
    exchange_rate = EXCHANGE_TXN_CHARGES
    sebi_rate = SEBI_TURNOVER_FEE
    brokerage_rate = BROKERAGE_RATES.get(key, 0.0)
    stamp_rate = STAMP_DUTY_RATES.get(key, 0.0)
    gst_rate = GST_RATE * (brokerage_rate + exchange_rate)
    per_leg_explicit = stt_rate + exchange_rate + sebi_rate + gst_rate + brokerage_rate
    if asset_class == "equity" and trade_type == "intraday":
        stt_adjustment = -stt_rate / 2
    else:
        stt_adjustment = 0.0
    round_trip_explicit = 2 * (per_leg_explicit + stt_adjustment) + stamp_rate
    if include_slippage:
        one_way_slippage = estimate_slippage_bps(
            participation_rate=participation_rate,
            market_cap_cr=market_cap_cr,
            volatility_pct=volatility_pct,
        )
        round_trip_slippage = 2 * one_way_slippage
    else:
        round_trip_slippage = 0.0
    return round_trip_explicit + round_trip_slippage


def cost_adjusted_return(gross_return_pct, round_trip_cost_pct, holding_period_days=1):
    return gross_return_pct - (round_trip_cost_pct * 100)


def minimum_edge_required(round_trip_cost_pct, hit_rate=0.50, avg_win_loss_ratio=1.5):
    if hit_rate <= 0 or hit_rate >= 1:
        return float("inf")
    return (round_trip_cost_pct * 100) / (hit_rate * (1 + 1 / avg_win_loss_ratio))


def cost_table(asset_class="equity", trade_type="intraday"):
    key = (asset_class, trade_type)
    stt = STT_RATES.get(key, 0.001)
    exchange = EXCHANGE_TXN_CHARGES
    sebi = SEBI_TURNOVER_FEE
    brokerage = BROKERAGE_RATES.get(key, 0.0)
    stamp = STAMP_DUTY_RATES.get(key, 0.0)
    gst = GST_RATE * (brokerage + exchange)
    per_leg = stt + exchange + sebi + gst + brokerage
    round_trip = 2 * per_leg + stamp
    return {
        "stt_bps": stt * 10000,
        "exchange_bps": exchange * 10000,
        "sebi_bps": sebi * 10000,
        "gst_bps": gst * 10000,
        "brokerage_bps": brokerage * 10000,
        "stamp_duty_bps": stamp * 10000,
        "total_explicit_per_leg_bps": per_leg * 10000,
        "total_explicit_round_trip_bps": round_trip * 10000,
    }
