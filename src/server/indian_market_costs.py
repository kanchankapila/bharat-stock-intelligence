"""Indian Equity & Derivatives Transaction Cost Model."""
from __future__ import annotations
import math
from typing import Literal

STT_RATES = {
    ("equity", "delivery"): 0.001,
    ("equity", "intraday"): 0.00025,
    # Finance Act 2026, effective 2026-04-01. Futures/options STT is charged on
    # the sell leg only; round_trip_cost_bps accounts for the taxable-leg count.
    ("futures", "intraday"): 0.0005,
    ("options", "intraday"): 0.0015,
}
# NSE circular FA/73061, effective 2026-03-01: transaction charge + IPFT outflow
# per side (cash Rs307/crore, futures Rs183/crore, options Rs3,553/crore premium).
EXCHANGE_TXN_CHARGES = {
    "equity": 0.0000307,
    "futures": 0.0000183,
    "options": 0.0003553,
}
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


def equity_trade_type_for_timeframe(timeframe) -> Literal["intraday", "delivery"]:
    """Map a recommendation horizon to the cash-market settlement whose charges apply.

    Only a same-session square-off avoids delivery. Unknown/missing horizons use delivery,
    the conservative cost assumption; treating a multi-session SWING/POSITIONAL plan as
    intraday materially understates STT.
    """
    return "intraday" if str(timeframe or "").strip().upper() == "INTRADAY" else "delivery"

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
    """Return the round-trip cost as a decimal fraction (0.002 == 20 bps).

    The historical function name is retained for callers, but the return value is not a
    bps integer. STT is applied to the legally taxable legs: both legs for delivery equity,
    the sell leg only for intraday equity and derivatives.
    """
    exchange_rate = EXCHANGE_TXN_CHARGES.get(asset_class, EXCHANGE_TXN_CHARGES["equity"])
    sebi_rate = SEBI_TURNOVER_FEE
    brokerage_rate = BROKERAGE_RATES.get(key, 0.0)
    stamp_rate = STAMP_DUTY_RATES.get(key, 0.0)
    gst_rate = GST_RATE * (brokerage_rate + exchange_rate)
    per_leg_non_stt = exchange_rate + sebi_rate + gst_rate + brokerage_rate
    stt_legs = 2 if key == ("equity", "delivery") else 1
    round_trip_explicit = stt_legs * stt_rate + 2 * per_leg_non_stt + stamp_rate
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
    exchange = EXCHANGE_TXN_CHARGES.get(asset_class, EXCHANGE_TXN_CHARGES["equity"])
    sebi = SEBI_TURNOVER_FEE
    brokerage = BROKERAGE_RATES.get(key, 0.0)
    stamp = STAMP_DUTY_RATES.get(key, 0.0)
    gst = GST_RATE * (brokerage + exchange)
    per_leg_non_stt = exchange + sebi + gst + brokerage
    stt_legs = 2 if key == ("equity", "delivery") else 1
    round_trip = stt_legs * stt + 2 * per_leg_non_stt + stamp
    per_leg = stt + per_leg_non_stt
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
