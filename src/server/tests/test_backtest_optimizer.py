import sys, os, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def test_find_best_config_returns_highest_sharpe():
    from backtest_optimizer import find_best_config

    results = [
        {'config': {'min_score': 3, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         'stats':  {'sharpe_ratio': 0.8, 'win_rate': 0.52, 'max_drawdown_pct': -15.0, 'total_trades': 50}},
        {'config': {'min_score': 5, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         'stats':  {'sharpe_ratio': 1.2, 'win_rate': 0.58, 'max_drawdown_pct': -12.0, 'total_trades': 30}},
        {'config': {'min_score': 7, 'horizon_days': 10, 'stop_loss_pct': 5, 'max_positions': 10},
         'stats':  {'sharpe_ratio': 0.5, 'win_rate': 0.60, 'max_drawdown_pct': -8.0, 'total_trades': 15}},
    ]
    best = find_best_config(results)
    assert best['config']['min_score'] == 5
    assert best['stats']['sharpe_ratio'] == 1.2

def test_find_best_config_respects_constraints():
    from backtest_optimizer import find_best_config

    results = [
        # High Sharpe but fails win_rate constraint
        {'config': {'min_score': 3, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         'stats':  {'sharpe_ratio': 2.0, 'win_rate': 0.30, 'max_drawdown_pct': -15.0, 'total_trades': 100}},
        # Lower Sharpe but passes all constraints
        {'config': {'min_score': 5, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         'stats':  {'sharpe_ratio': 1.1, 'win_rate': 0.50, 'max_drawdown_pct': -20.0, 'total_trades': 40}},
    ]
    best = find_best_config(results)
    assert best['config']['min_score'] == 5, "Should skip result failing win_rate constraint"

def test_find_best_config_none_if_all_fail_constraints():
    from backtest_optimizer import find_best_config

    results = [
        {'config': {'min_score': 3},
         'stats':  {'sharpe_ratio': 1.5, 'win_rate': 0.20, 'max_drawdown_pct': -15.0, 'total_trades': 5}},
    ]
    best = find_best_config(results)
    assert best is None

def test_should_update_returns_true_on_improvement():
    from backtest_optimizer import should_update

    assert should_update(current_sharpe=1.0, new_sharpe=1.1) is True   # 10% better
    assert should_update(current_sharpe=1.0, new_sharpe=1.04) is False  # only 4%
    assert should_update(current_sharpe=0.0, new_sharpe=0.5) is True   # baseline 0


class _FakeConn:
    """Minimal ConnWrapper stub for the one MIN(date) query _effective_window_days issues.
    Never touches a live DB -- these tests target the pure clamping function directly, not
    run_grid_search (which imports and constructs a real Backtester further down and must
    not be invoked from a unit test)."""
    def __init__(self, min_date):
        self._min_date = min_date

    def execute(self, sql, params=()):
        assert "MIN(date)" in sql and "technical_signals" in sql
        return self

    def fetchone(self):
        return (self._min_date,) if self._min_date else None


def test_NEGATIVE_CONTROL_window_clamps_to_real_history_depth(capsys):
    """Reproduces the live incident (2026-08-15): technical_signals' real depth was 91 days
    (MIN(date)=2026-05-16), but window_days defaulted to 365 with no clamp. Every one of 300
    live grid combinations returned 'No signals found' on every run this script ever made --
    not a constraint-calibration problem, CONSTRAINT_WIN_RATE/CONSTRAINT_MAX_DRAWDOWN were
    never even reached; the search window itself never touched a real row. Fails against the
    pre-fix code (which returned the unclamped 365 unchanged), passes once clamping is in
    place -- confirmed by reverting _effective_window_days to `return requested_days`
    unconditionally and re-running this test, which then fails."""
    import backtest_optimizer as bo
    today = datetime.date(2026, 8, 15)
    ninety_one_days_ago = (today - datetime.timedelta(days=91)).isoformat()

    conn = _FakeConn(ninety_one_days_ago)
    effective = bo._effective_window_days(conn, requested_days=365, today=today)
    out = capsys.readouterr().out

    assert effective == 91, f"expected the clamped 91d, got {effective}"
    assert "technical_signals only has" in out and "91d" in out, (
        "must log the clamp, not silently shrink the window -- this is what would have "
        "surfaced the bug immediately instead of it running unnoticed for the script's life"
    )


def test_window_shorter_than_available_history_is_left_unclamped(capsys):
    """The common case once real history exceeds the request: no clamping, no log noise."""
    import backtest_optimizer as bo
    today = datetime.date(2026, 8, 15)
    a_year_ago = (today - datetime.timedelta(days=400)).isoformat()

    conn = _FakeConn(a_year_ago)
    effective = bo._effective_window_days(conn, requested_days=365, today=today)
    out = capsys.readouterr().out

    assert effective == 365
    assert out == ""


def test_no_history_at_all_falls_back_to_requested_days(capsys):
    """MIN(date) returns NULL (table empty / signal_score never populated) -- must fall back
    to the requested value rather than raising or clamping to a bogus 0. The caller's
    MIN_WINDOW_DAYS gate is what actually rejects this case (see next test)."""
    import backtest_optimizer as bo
    conn = _FakeConn(None)
    effective = bo._effective_window_days(conn, requested_days=365, today=datetime.date(2026, 8, 15))
    assert effective == 365
    assert capsys.readouterr().out == ""


def test_available_history_shorter_than_min_window_skips_cleanly(monkeypatch, capsys):
    """run_grid_search's own gate: if clamped history is thinner than MIN_WINDOW_DAYS
    (train+holdout can't both hold a meaningful sample), it must return None and say why --
    without ever reaching the Backtester import a few lines later. Monkeypatches
    _effective_window_days directly so this stays a fast unit test regardless of what the
    live DB currently contains."""
    import backtest_optimizer as bo
    monkeypatch.setattr(bo, "_effective_window_days", lambda conn, requested_days, today=None: 10)

    result = bo.run_grid_search(conn=object(), window_days=365, dry_run=True)
    out = capsys.readouterr().out

    assert result is None
    assert "too little" in out.lower()
