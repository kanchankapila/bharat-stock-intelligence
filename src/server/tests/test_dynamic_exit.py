import sys
sys.path.insert(0, "src/server")

from dynamic_exit import (
    DynamicExitManager,
    ExitConfig,
    ExitReason,
    ExitSignal,
    calculate_chandelier_stop,
    calculate_initial_stop,
)


def test_basic_stop_calculations():
    # chandelier stop
    stop = calculate_chandelier_stop(highest_high=120.0, atr=5.0, multiplier=3.0)
    assert stop == 105.0

    # initial stop
    init_stop = calculate_initial_stop(entry_price=100.0, atr=4.0, multiplier=1.5)
    assert init_stop == 94.0


def test_stop_loss_trigger():
    config = ExitConfig(initial_stop_mult=1.0)
    manager = DynamicExitManager(config)

    # Entry at 100, ATR=5, initial stop = 95
    signal = manager.check_exit(
        current_price=94.0,
        atr=5.0,
        entry_price=100.0,
        bars_held=1,
    )
    assert signal.should_exit is True
    assert signal.reason == ExitReason.STOP_LOSS
    assert signal.exit_fraction == 1.0


def test_chandelier_trailing_ratchet():
    config = ExitConfig(chandelier_mult=2.0, use_chandelier=True, move_stop_to_breakeven_at=10.0)
    manager = DynamicExitManager(config)

    # Entry 100, ATR 5, HH 120 -> Chandelier stop = 120 - 2*5 = 110
    signal = manager.check_exit(
        current_price=115.0,
        atr=5.0,
        high=120.0,
        low=114.0,
        bars_held=3,
        entry_price=100.0,
        highest_high=120.0,
        current_stop=95.0,
    )
    assert signal.should_exit is False
    assert signal.stop_price == 110.0

    # Next bar: price drops to 109, below 110 chandelier stop
    signal_exit = manager.check_exit(
        current_price=109.0,
        atr=5.0,
        high=115.0,
        low=109.0,
        bars_held=4,
        entry_price=100.0,
        highest_high=120.0,
        current_stop=110.0,
    )
    assert signal_exit.should_exit is True
    assert signal_exit.reason == ExitReason.CHANDELIER_EXIT
    assert signal_exit.stop_price == 110.0


def test_breakeven_ratchet():
    config = ExitConfig(move_stop_to_breakeven_at=1.5, chandelier_mult=4.0)
    manager = DynamicExitManager(config)

    # Entry 100, ATR 4. Threshold for breakeven = 100 + 1.5 * 4 = 106.
    # HH = 107. Chandelier stop would be 107 - 4*4 = 91 (below entry).
    # But breakeven ratchet forces stop to entry (100.0).
    signal = manager.check_exit(
        current_price=106.5,
        atr=4.0,
        entry_price=100.0,
        highest_high=107.0,
        current_stop=96.0,
        entry_atr=4.0,
    )
    assert signal.should_exit is False
    assert signal.stop_price >= 100.0


def test_target_price_exit():
    manager = DynamicExitManager()
    signal = manager.check_exit(
        current_price=112.0,
        atr=3.0,
        entry_price=100.0,
        target_price=110.0,
        bars_held=2,
    )
    assert signal.should_exit is True
    assert signal.reason == ExitReason.TARGET_HIT


def test_time_exit():
    config = ExitConfig(max_hold_days=10)
    manager = DynamicExitManager(config)

    # Below max hold days: holding
    sig_hold = manager.check_exit(
        current_price=102.0,
        atr=2.0,
        entry_price=100.0,
        bars_held=9,
    )
    assert sig_hold.should_exit is False

    # Reaching max hold days: exit
    sig_exit = manager.check_exit(
        current_price=102.0,
        atr=2.0,
        entry_price=100.0,
        bars_held=10,
    )
    assert sig_exit.should_exit is True
    assert sig_exit.reason == ExitReason.TIME_EXIT


def test_volatility_expansion_exit():
    config = ExitConfig(vol_expansion_threshold=2.0)
    manager = DynamicExitManager(config)

    # Entry ATR 2.0, current ATR 4.5 (> 2.0x expansion), price 98 < entry 100
    signal = manager.check_exit(
        current_price=98.0,
        atr=4.5,
        entry_price=100.0,
        entry_atr=2.0,
        current_stop=90.0,
        bars_held=2,
    )
    assert signal.should_exit is True
    assert signal.reason == ExitReason.VOLATILITY_EXPANSION


def test_stateful_tracking():
    config = ExitConfig(chandelier_mult=2.0, max_hold_days=5)
    manager = DynamicExitManager(config)

    pos = manager.register_position(
        symbol="RELIANCE",
        entry_price=2500.0,
        entry_atr=50.0,
        target_price=2700.0,
    )
    assert pos.symbol == "RELIANCE"
    assert pos.current_stop == 2450.0  # 2500 - 1 * 50

    # Day 1: stock goes up to 2600
    sig1 = manager.update_and_check(
        symbol="RELIANCE",
        current_price=2580.0,
        high=2600.0,
        low=2500.0,
        atr=50.0,
    )
    assert sig1.should_exit is False
    assert pos.highest_high == 2600.0
    # Stop should ratchet to max(2450, 2600 - 2*50) = 2500 (breakeven!)
    assert pos.current_stop == 2500.0

    # Day 2: pullback to 2480 (below ratcheted stop 2500)
    sig2 = manager.update_and_check(
        symbol="RELIANCE",
        current_price=2480.0,
        high=2520.0,
        low=2480.0,
        atr=50.0,
    )
    assert sig2.should_exit is True
    assert sig2.reason == ExitReason.CHANDELIER_EXIT


if __name__ == "__main__":
    test_basic_stop_calculations()
    test_stop_loss_trigger()
    test_chandelier_trailing_ratchet()
    test_breakeven_ratchet()
    test_target_price_exit()
    test_time_exit()
    test_volatility_expansion_exit()
    test_stateful_tracking()
    print("All dynamic exit tests passed")
