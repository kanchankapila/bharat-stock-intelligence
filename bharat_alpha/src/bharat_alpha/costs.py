"""Indian cash-equity (delivery) transaction costs, per side, as fractions of traded value.

ASSUMPTION: statutory rates below are as understood at build time (STT 0.1% both sides on
delivery, stamp 0.015% on buys, NSE transaction charge ~0.00297%, SEBI ₹10/crore, GST 18% on
brokerage + exchange + SEBI) and were not re-verified against a 2026 circular in this
session. Slippage is a flat assumption, not measured. If any rate is wrong, every net-excess
number shifts by roughly (error x turnover), which is why turnover is always reported
beside net returns.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CostModel:
    stt: float = 0.001
    stamp_buy: float = 0.00015
    exchange: float = 0.0000297
    sebi: float = 0.000001
    gst: float = 0.18
    brokerage: float = 0.0
    slippage: float = 0.0010          # half-spread + impact, per side (assumption)

    def buy(self) -> float:
        fees = self.brokerage + self.exchange + self.sebi
        return self.stt + self.stamp_buy + fees * (1 + self.gst) + self.slippage

    def sell(self) -> float:
        fees = self.brokerage + self.exchange + self.sebi
        return self.stt + fees * (1 + self.gst) + self.slippage

    def round_trip(self) -> float:
        return self.buy() + self.sell()


DEFAULT_COSTS = CostModel()
