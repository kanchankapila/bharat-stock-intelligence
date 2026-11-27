"""Screener labels that are wrong under any reading of the screener's own condition (AF-20261126-11).

Four writers set the same bias and the last one wins, and the feature builder re-derives direction from
the name, so a correction made in any one of them is lost. These pins are meant to be applied after all
of them. NOT WIRED YET: wiring is gated on the replay in
docs/audits/2026-11-26-screener-bias-pins-preregistration.md.

Deliberately narrow. Convention disputes (CCI, Williams %R, bare RSI oversold) are not pinned: the
repo's measured daily rules and AF-20260829-11 own those.
"""
import re

_PINS = (
    (r"^previous (day|month) breakout - down", "bearish"),
    (r"^price crossed below (\S+( min)? )?bollinger band$", "bearish"),
    (r"\badx strong trending stocks$", "neutral"),
    (r"^(oversold|overbought) on both .*\b(rsi|mfi)\b", "neutral"),
)


def pinned_bias(name):
    """'bullish' / 'bearish' / 'neutral' for a pinned screener name, else None."""
    t = (name or "").strip().lower()
    return next((bias for pattern, bias in _PINS if re.search(pattern, t)), None)
