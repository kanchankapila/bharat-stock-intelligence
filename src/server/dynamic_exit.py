"""Dynamic Exit Framework for Production Trading.

Implements trailing stops, chandelier exits, time-based exits,
and volatility-adjusted stop management.

Usage:
    from dynamic_exit import DynamicExitManager, ExitConfig

    config = ExitConfig(atr_period=14, trail_mult=2.0)
    manager = DynamicExitManager(config)
    signal = manager.check_exit(price, atr, high, low, bars, entry)
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


class ExitReason(Enum):
    NONE = "none"
    STOP_LOSS = "stop_loss"
    TRAILING_STOP = "trailing_stop"
    CHANDELIER_EXIT = "chandelier_exit"
    TIME_EXIT = "time_exit"
    TARGET_HIT = "target_hit"
    VOLATILITY_EXPANSION = "volatility_expansion"


@dataclass
class ExitConfig:
    """Configuration for dynamic exit management."""
    atr_period: int = 14
    initial_stop_mult: float = 1.0
    trail_mult: float = 2.0
    chandelier_mult: float = 3.0
    use_chandelier: bool = True
    max_hold_days: int = 20
    vol_expansion_threshold: float = 1.5
    move_stop_to_breakeven_at: float = 1.5


@dataclass
class ExitSignal:
    """Signal from exit manager."""
    should_exit: bool = False
    exit_fraction: float = 0.0
    reason: ExitReason = ExitReason.NONE
    stop_price: float = 0.0
    message: str = ""


class DynamicExitManager:
    """Manages dynamic exits for a position."""

    def __init__(self, config: Optional[ExitConfig] = None):
        self.config = config or ExitConfig()

    def compute_initial_stop(
        self,
        entry_price: float,
        atr: float,
        direction: Literal["long", "short"] = "long",
    ) -> float:
        """Compute initial stop loss price."""
        if atr <= 0:
            return entry_price * 0.95 if direction == "long" else entry_price * 1.05

        mult = self.config.initial_stop_mult
        if direction == "long":
            return entry_price - mult * atr
        else:
            return entry_price + mult * atr

    def compute_trailing_stop(
        self,
        highest_price: float,
        atr: float,
        direction: Literal["long", "short"] = "long",
    ) -> float:
        """Compute trailing stop based on highest/lowest price since entry."""
        if atr <= 0:
            return highest_price * 0.95 if direction == "long" else highest_price * 1.05

        mult = self.config.trail_mult
        if direction == "long":
            return highest_price - mult * atr
        else:
            return highest_price + mult * atr

    def compute_chandelier_exit(
        self,
        extreme_price: float,
        atr: float,
        direction: Literal["long", "short"] = "long",
    ) -> float:
        """Compute chandelier exit (extreme - N * ATR)."""
        if atr <= 0:
            return extreme_price * 0.90 if direction == "long" else extreme_price * 1.10

        mult = self.config.chandelier_mult
        if direction == "long":
            return extreme_price - mult * atr
        else:
                        return extreme_price + mult * atr

    def check_exit(
        self,
        current_price: float,
        atr: float,
        highest_since_entry: float,
        lowest_since_entry: float,
        bars_held: int,
        entry_price: float,
        direction: Literal["long", "short"] = "long",
        atr_median: Optional[float] = None,
    ) -> ExitSignal:
        """Check if position should be exited."""
        cfg = self.config
        signal = ExitSignal(should_exit=False, stop_price=current_price)

        extreme = highest_since_entry if direction == "long" else lowest_since_entry
        initial_stop = self.compute_initial_stop(entry_price, atr, direction)
        trailing_stop = self.compute_trailing_stop(extreme, atr, direction)
        chandelier_stop = self.compute_chandelier_exit(extreme, atr, direction)

        if direction == "long":
            effective_stop = max(initial_stop, trailing_stop)
            if cfg.use_chandelier:
                effective_stop = max(effective_stop, chandelier_stop)
        else:
            effective_stop = min(initial_stop, trailing_stop)
            if cfg.use_chandelier:
                effective_stop = min(effective_stop, chandelier_stop)

        signal.stop_price = effective_stop

        # Initial stop
        if direction == "long" and current_price <= initial_stop:
            return ExitSignal(should_exit=True, exit_fraction=1.0,
                reason=ExitReason.STOP_LOSS, stop_price=initial_stop,
                message=f"Initial stop hit at {initial_stop:.2f}")
        if direction == "short" and current_price >= initial_stop:
            return ExitSignal(should_exit=True, exit_fraction=1.0,
                reason=ExitReason.STOP_LOSS, stop_price=initial_stop,
                message=f"Initial stop hit at {initial_stop:.2f}")

        # Trailing stop (only in profit)
        if direction == "long" and current_price > entry_price:
            if current_price <= trailing_stop:
                return ExitSignal(should_exit=True, exit_fraction=1.0,
                    reason=ExitReason.TRAILING_STOP, stop_price=trailing_stop,
                    message=f"Trailing stop at {trailing_stop:.2f}")
        elif direction == "short" and current_price < entry_price:
            if current_price >= trailing_stop:
                return ExitSignal(should_exit=True, exit_fraction=1.0,
                    reason=ExitReason.TRAILING_STOP, stop_price=trailing_stop,
                    message=f"Trailing stop at {trailing_stop:.2f}")

        # Chandelier exit
        if cfg.use_chandelier:
            if direction == "long" and current_price <= chandelier_stop and current_price > entry_price:
                return ExitSignal(should_exit=True, exit_fraction=1.0,
                    reason=ExitReason.CHANDELIER_EXIT, stop_price=chandelier_stop,
                    message=f"Chandelier exit at {chandelier_stop:.2f}")
            if direction == "short" and current_price >= chandelier_stop and current_price < entry_price:
                return ExitSignal(should_exit=True, exit_fraction=1.0,
                    reason=ExitReason.CHANDELIER_EXIT, stop_price=chandelier_stop,
                    message=f"Chandelier exit at {chandelier_stop:.2f}")

        # Time exit
        if bars_held >= cfg.max_hold_days:
            return ExitSignal(should_exit=True, exit_fraction=1.0,
                reason=ExitReason.TIME_EXIT, stop_price=effective_stop,
                message=f"Time exit after {bars_held} bars")

        # Volatility expansion
        if atr_median and atr_median > 0 and atr > atr_median * cfg.vol_expansion_threshold:
            return ExitSignal(should_exit=True, exit_fraction=0.5,
                reason=ExitReason.VOLATILITY_EXPANSION, stop_price=effective_stop,
                message=f"Vol expansion: ATR {atr:.2f} > {cfg.vol_expansion_threshold}x median {atr_median:.2f}")

        return signal

    def compute_position_targets(
        self,
        entry_price: float,
        atr: float,
        direction: Literal["long", "short"] = "long",
    ) -> dict:
        """Compute target levels for a position."""
        initial_stop = self.compute_initial_stop(entry_price, atr, direction)
        risk = abs(entry_price - initial_stop)

        if direction == "long":
            return {
                "entry": entry_price,
                "stop": initial_stop,
                "target_1r": entry_price + risk,
                "target_2r": entry_price + 2 * risk,
                "target_3r": entry_price + 3 * risk,
                "risk": risk,
                "rr_ratio": 2.0,
            }
        else:
            return {
                "entry": entry_price,
                "stop": initial_stop,
                "target_1r": entry_price - risk,
                "target_2r": entry_price - 2 * risk,
                "target_3r": entry_price - 3 * risk,
                "risk": risk,
                "rr_ratio": 2.0,
            }


@dataclass
class PositionState:
    """Tracks position-level state for dynamic exits."""
    symbol: str
    entry_price: float
    entry_atr: float
    highest_high: float
    current_stop: float
    bars_held: int = 0
    target_price: Optional[float] = None
    breakeven_triggered: bool = False


def calculate_chandelier_stop(
    highest_high: float,
    atr: float,
    multiplier: float = 3.0,
) -> float:
    """Compute chandelier stop price: highest_high - multiplier * atr."""
    return max(0.0, highest_high - multiplier * atr)


def calculate_initial_stop(
    entry_price: float,
    atr: float,
    multiplier: float = 1.0,
) -> float:
    """Compute initial stop loss price: entry_price - multiplier * atr."""
    return max(0.0, entry_price - multiplier * atr)


class DynamicExitManager:
    """Production dynamic exit manager implementing chandelier stops,
    breakeven ratchets, volatility expansion guards, and time stops.
    """

    def __init__(self, config: Optional[ExitConfig] = None):
        self.config = config or ExitConfig()
        self.positions: dict[str, PositionState] = {}

    def register_position(
        self,
        symbol: str,
        entry_price: float,
        entry_atr: float,
        target_price: Optional[float] = None,
        initial_stop: Optional[float] = None,
    ) -> PositionState:
        """Register a new active position."""
        if initial_stop is None:
            initial_stop = calculate_initial_stop(
                entry_price, entry_atr, self.config.initial_stop_mult
            )
        pos = PositionState(
            symbol=symbol,
            entry_price=entry_price,
            entry_atr=entry_atr,
            highest_high=entry_price,
            current_stop=initial_stop,
            bars_held=0,
            target_price=target_price,
        )
        self.positions[symbol] = pos
        return pos

    def get_position(self, symbol: str) -> Optional[PositionState]:
        """Get position state by symbol."""
        return self.positions.get(symbol)

    def remove_position(self, symbol: str) -> Optional[PositionState]:
        """Remove a closed position."""
        return self.positions.pop(symbol, None)

    def calculate_ratchet_stop(
        self,
        current_stop: float,
        highest_high: float,
        atr: float,
        entry_price: float,
        entry_atr: Optional[float] = None,
    ) -> float:
        """Compute ratcheted stop price (ratchets up, never down)."""
        ref_atr = entry_atr if (entry_atr is not None and entry_atr > 0) else atr
        mult = self.config.chandelier_mult if self.config.use_chandelier else self.config.trail_mult
        chandelier_stop = calculate_chandelier_stop(highest_high, atr, mult)

        # Monotonic ratchet: stop never decreases
        new_stop = max(current_stop, chandelier_stop)

        # Breakeven ratchet: move stop to entry if profit reaches threshold
        if (
            self.config.move_stop_to_breakeven_at > 0
            and ref_atr > 0
            and highest_high >= entry_price + self.config.move_stop_to_breakeven_at * ref_atr
        ):
            new_stop = max(new_stop, entry_price)

        # Safety bound: stop should not exceed highest high
        new_stop = min(new_stop, highest_high)
        return new_stop

    def check_exit(
        self,
        current_price: float,
        atr: float,
        high: Optional[float] = None,
        low: Optional[float] = None,
        bars_held: int = 0,
        entry_price: Optional[float] = None,
        highest_high: Optional[float] = None,
        current_stop: Optional[float] = None,
        entry_atr: Optional[float] = None,
        target_price: Optional[float] = None,
    ) -> ExitSignal:
        """Evaluate exit conditions for a position statelessly.

        Supports positional parameters `(price, atr, high, low, bars, entry)`
        matching module documentation.
        """
        if entry_price is None or entry_price <= 0:
            entry_price = current_price

        ref_atr = entry_atr if (entry_atr is not None and entry_atr > 0) else atr
        init_stop = calculate_initial_stop(entry_price, ref_atr, self.config.initial_stop_mult)

        curr_stop = current_stop if current_stop is not None else init_stop
        hi_val = high if high is not None else current_price
        lo_val = low if low is not None else current_price

        hh = max(
            entry_price,
            hi_val,
            highest_high if highest_high is not None else entry_price,
        )

        ratcheted_stop = self.calculate_ratchet_stop(
            current_stop=curr_stop,
            highest_high=hh,
            atr=atr,
            entry_price=entry_price,
            entry_atr=entry_atr,
        )

        # 1. Target hit
        if target_price is not None and target_price > 0:
            if hi_val >= target_price or current_price >= target_price:
                return ExitSignal(
                    should_exit=True,
                    exit_fraction=1.0,
                    reason=ExitReason.TARGET_HIT,
                    stop_price=ratcheted_stop,
                    message=f"Target {target_price:.2f} reached",
                )

        # 2. Stop loss / trailing stop hit
        if lo_val < ratcheted_stop or current_price < ratcheted_stop:
            reason = (
                ExitReason.CHANDELIER_EXIT
                if ratcheted_stop > init_stop
                else ExitReason.STOP_LOSS
            )
            return ExitSignal(
                should_exit=True,
                exit_fraction=1.0,
                reason=reason,
                stop_price=ratcheted_stop,
                message=f"Stop hit at {ratcheted_stop:.2f} ({reason.value})",
            )

        # 3. Volatility expansion emergency exit
        if (
            ref_atr > 0
            and self.config.vol_expansion_threshold > 0
            and (atr / ref_atr) >= self.config.vol_expansion_threshold
            and current_price < entry_price
        ):
            return ExitSignal(
                should_exit=True,
                exit_fraction=1.0,
                reason=ExitReason.VOLATILITY_EXPANSION,
                stop_price=ratcheted_stop,
                message=f"ATR expanded {atr / ref_atr:.2f}x while in loss",
            )

        # 4. Time exit (max holding days reached)
        if self.config.max_hold_days > 0 and bars_held >= self.config.max_hold_days:
            return ExitSignal(
                should_exit=True,
                exit_fraction=1.0,
                reason=ExitReason.TIME_EXIT,
                stop_price=ratcheted_stop,
                message=f"Max hold period of {self.config.max_hold_days} bars reached",
            )

        return ExitSignal(
            should_exit=False,
            exit_fraction=0.0,
            reason=ExitReason.NONE,
            stop_price=ratcheted_stop,
            message="Hold position",
        )

    def update_and_check(
        self,
        symbol: str,
        current_price: float,
        high: float,
        low: float,
        atr: float,
    ) -> ExitSignal:
        """Update tracked position state and evaluate exit conditions."""
        pos = self.positions.get(symbol)
        if pos is None:
            return ExitSignal(
                should_exit=False,
                reason=ExitReason.NONE,
                message=f"Symbol {symbol} not tracked",
            )

        pos.bars_held += 1
        pos.highest_high = max(pos.highest_high, high, current_price)

        signal = self.check_exit(
            current_price=current_price,
            atr=atr,
            high=high,
            low=low,
            bars_held=pos.bars_held,
            entry_price=pos.entry_price,
            highest_high=pos.highest_high,
            current_stop=pos.current_stop,
            entry_atr=pos.entry_atr,
            target_price=pos.target_price,
        )

        pos.current_stop = signal.stop_price
        if (
            not pos.breakeven_triggered
            and pos.highest_high >= pos.entry_price + self.config.move_stop_to_breakeven_at * pos.entry_atr
        ):
            pos.breakeven_triggered = True

        return signal
