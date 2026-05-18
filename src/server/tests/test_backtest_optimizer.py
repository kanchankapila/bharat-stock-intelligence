import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def test_find_best_config_returns_highest_sharpe():
    from backtest_optimizer import find_best_config

    results = [
        ({'min_score': 3, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 0.8, 'win_rate': 0.52, 'max_drawdown_pct': -15.0, 'total_trades': 50}),
        ({'min_score': 5, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 1.2, 'win_rate': 0.58, 'max_drawdown_pct': -12.0, 'total_trades': 30}),
        ({'min_score': 7, 'horizon_days': 10, 'stop_loss_pct': 5, 'max_positions': 10},
         {'sharpe_ratio': 0.5, 'win_rate': 0.60, 'max_drawdown_pct': -8.0, 'total_trades': 15}),
    ]
    best = find_best_config(results)
    assert best['config']['min_score'] == 5
    assert best['stats']['sharpe_ratio'] == 1.2

def test_find_best_config_respects_constraints():
    from backtest_optimizer import find_best_config

    results = [
        # High Sharpe but fails win_rate constraint
        ({'min_score': 3, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 2.0, 'win_rate': 0.30, 'max_drawdown_pct': -15.0, 'total_trades': 100}),
        # Lower Sharpe but passes all constraints
        ({'min_score': 5, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 1.1, 'win_rate': 0.50, 'max_drawdown_pct': -20.0, 'total_trades': 40}),
    ]
    best = find_best_config(results)
    assert best['config']['min_score'] == 5, "Should skip result failing win_rate constraint"

def test_find_best_config_none_if_all_fail_constraints():
    from backtest_optimizer import find_best_config

    results = [
        ({'min_score': 3}, {'sharpe_ratio': 1.5, 'win_rate': 0.20,
                            'max_drawdown_pct': -15.0, 'total_trades': 5}),
    ]
    best = find_best_config(results)
    assert best is None

def test_should_update_returns_true_on_improvement():
    from backtest_optimizer import should_update

    assert should_update(current_sharpe=1.0, new_sharpe=1.1) is True   # 10% better
    assert should_update(current_sharpe=1.0, new_sharpe=1.04) is False  # only 4%
    assert should_update(current_sharpe=0.0, new_sharpe=0.5) is True   # baseline 0
