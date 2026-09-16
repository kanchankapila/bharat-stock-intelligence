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


# ── Multi-fold promotion (2026-08-17 redesign) ──────────────────────────────────────

def test_split_holdout_folds_falls_back_to_one_fold_when_too_short():
    from backtest_optimizer import _split_holdout_folds
    folds = _split_holdout_folds("2026-08-01", "2026-08-10", max_folds=5, min_fold_days=15)
    assert folds == [("2026-08-01", "2026-08-10")]


def test_split_holdout_folds_splits_into_multiple_contiguous_windows():
    from backtest_optimizer import _split_holdout_folds
    # 60 days, min_fold_days=15 -> 4 folds of 15 days each.
    folds = _split_holdout_folds("2026-01-01", "2026-03-02", max_folds=5, min_fold_days=15)
    assert len(folds) == 4
    # Contiguous: each fold's end is the next fold's start, no gaps or overlaps.
    for i in range(len(folds) - 1):
        assert folds[i][1] == folds[i + 1][0]
    assert folds[0][0] == "2026-01-01"
    assert folds[-1][1] == "2026-03-02"


def test_split_holdout_folds_caps_at_max_folds():
    from backtest_optimizer import _split_holdout_folds
    # 300 days at min_fold_days=15 would be 20 folds -- capped to max_folds=5.
    folds = _split_holdout_folds("2026-01-01", "2026-10-28", max_folds=5, min_fold_days=15)
    assert len(folds) == 5


def test_should_update_multi_fold_NEGATIVE_CONTROL_reproduces_the_measured_incident():
    """Live-measured 2026-08-17 (docs/audit-findings.md AF-29): the SAME fixed config's Sharpe
    across 3 real rolling windows came back -0.5454, -0.1714, +1.6833 -- a single point estimate
    (the old should_update(current_sharpe, new_sharpe)) would have promoted or rejected based
    entirely on WHICH of these three windows happened to be "the" holdout, sign-flipping the
    verdict depending on window luck alone. This reproduces exactly that swing against a fixed
    champion and confirms the majority-fold vote gives ONE stable answer instead of three
    different ones depending on which single window had been picked."""
    from backtest_optimizer import should_update_multi_fold

    # Champion measured at a flat 0.20 Sharpe on every one of the same 3 folds (a fixed,
    # unchanging incumbent -- the champion doesn't move, only the challenger's per-window
    # estimate does, exactly isolating the noise this fix targets).
    champion_sharpe = 0.20
    challenger_sharpes = [-0.5454, -0.1714, 1.6833]  # the real measured values

    fold_results = [
        {'fold': (f'w{i}', f'w{i}'), 'challenger_sharpe': s, 'challenger_trades': 30,
         'champion_sharpe': champion_sharpe, 'champion_trades': 30}
        for i, s in enumerate(challenger_sharpes)
    ]

    # Old single-window logic (should_update on ANY ONE of the 3) would give three DIFFERENT
    # verdicts depending purely on which window was chosen -- that instability is the bug.
    from backtest_optimizer import should_update
    single_window_verdicts = {should_update(champion_sharpe, s) for s in challenger_sharpes}
    assert len(single_window_verdicts) == 2, (
        "sanity check: the raw per-window verdicts must actually disagree with each other, "
        "or this test isn't reproducing the instability it claims to"
    )

    # Majority vote: only 1 of 3 folds beats champion*1.05=0.21 (the +1.6833 fold) -> NOT a
    # majority -> do not promote. One stable answer, not three different ones.
    promote, votes = should_update_multi_fold(fold_results)
    assert promote is False
    assert sum(1 for v in votes if v['counted'] and v['challenger_wins']) == 1
    assert sum(1 for v in votes if v['counted']) == 3


def test_should_update_multi_fold_promotes_on_a_genuine_majority():
    from backtest_optimizer import should_update_multi_fold
    fold_results = [
        {'fold': ('a', 'a'), 'challenger_sharpe': 0.30, 'challenger_trades': 20,
         'champion_sharpe': 0.20, 'champion_trades': 20},
        {'fold': ('b', 'b'), 'challenger_sharpe': 0.28, 'challenger_trades': 20,
         'champion_sharpe': 0.20, 'champion_trades': 20},
        {'fold': ('c', 'c'), 'challenger_sharpe': 0.10, 'challenger_trades': 20,
         'champion_sharpe': 0.20, 'champion_trades': 20},
    ]
    promote, votes = should_update_multi_fold(fold_results)
    assert promote is True  # 2 of 3 folds clear champion*1.05


def test_should_update_multi_fold_excludes_thin_folds_from_the_vote_not_as_losses():
    """A fold with too few trades must be SKIPPED, not counted as a loss -- otherwise a thin
    fold could silently veto a genuine majority just by having too little data to be meaningful."""
    from backtest_optimizer import should_update_multi_fold, MIN_FOLD_TRADES
    fold_results = [
        {'fold': ('a', 'a'), 'challenger_sharpe': 0.30, 'challenger_trades': 20,
         'champion_sharpe': 0.20, 'champion_trades': 20},
        {'fold': ('b', 'b'), 'challenger_sharpe': 0.30, 'challenger_trades': 20,
         'champion_sharpe': 0.20, 'champion_trades': 20},
        # Too few trades on this fold -- must not count against the challenger.
        {'fold': ('c', 'c'), 'challenger_sharpe': -5.0, 'challenger_trades': MIN_FOLD_TRADES - 1,
         'champion_sharpe': 0.20, 'champion_trades': 20},
    ]
    promote, votes = should_update_multi_fold(fold_results)
    assert promote is True
    counted = [v for v in votes if v['counted']]
    assert len(counted) == 2, "the thin fold must not be counted either way"


def test_should_update_multi_fold_no_counted_folds_fails_closed():
    from backtest_optimizer import should_update_multi_fold
    fold_results = [
        {'fold': ('a', 'a'), 'challenger_sharpe': 0.30, 'challenger_trades': 1,
         'champion_sharpe': 0.20, 'champion_trades': 1},
    ]
    promote, votes = should_update_multi_fold(fold_results)
    assert promote is False


def test_should_update_multi_fold_bootstrap_case_no_champion_yet():
    """No champion config exists (app_settings has never held optimal_sharpe -- the live state
    of this gate, confirmed 2026-08-17). A fold votes for the challenger on a positive Sharpe
    alone, mirroring should_update()'s existing current<=0 bootstrap rule."""
    from backtest_optimizer import should_update_multi_fold
    fold_results = [
        {'fold': ('a', 'a'), 'challenger_sharpe': 0.10, 'challenger_trades': 20,
         'champion_sharpe': None, 'champion_trades': 0},
        {'fold': ('b', 'b'), 'challenger_sharpe': 0.05, 'challenger_trades': 20,
         'champion_sharpe': None, 'champion_trades': 0},
        {'fold': ('c', 'c'), 'challenger_sharpe': -0.10, 'challenger_trades': 20,
         'champion_sharpe': None, 'champion_trades': 0},
    ]
    promote, votes = should_update_multi_fold(fold_results)
    assert promote is True  # 2 of 3 folds are positive


class _FakeConfigConn:
    """Stub for _get_current_config's app_settings lookups."""
    def __init__(self, values: dict):
        self._values = values

    def execute(self, sql, params=()):
        key = params[0] if params else None
        self._last = self._values.get(key)
        return self

    def fetchone(self):
        return (self._last,) if self._last is not None else None


def test_get_current_config_returns_none_when_bootstrap():
    from backtest_optimizer import _get_current_config
    conn = _FakeConfigConn({})  # nothing ever promoted
    assert _get_current_config(conn) is None


def test_get_current_config_returns_none_if_any_key_missing():
    from backtest_optimizer import _get_current_config
    conn = _FakeConfigConn({'optimal_min_score': '5', 'optimal_horizon_days': '15'})
    assert _get_current_config(conn) is None


def test_get_current_config_returns_full_config_when_all_keys_present():
    from backtest_optimizer import _get_current_config
    conn = _FakeConfigConn({
        'optimal_min_score': '5', 'optimal_horizon_days': '15',
        'optimal_stop_loss_pct': '7.0', 'optimal_max_positions': '15',
    })
    cfg = _get_current_config(conn)
    assert cfg == {'min_score': 5, 'horizon_days': 15, 'stop_loss_pct': 7.0, 'max_positions': 15}
