#!/usr/bin/env python3
"""
Live Screener Backtester
========================
Backtests custom combinations of NiftyTrader live screener filters using
resolved historical outcomes (returns over 1d, 3d, 5d) and compares vs Nifty 50.
Stores runs in `backtesting_runs` table so they are visible in UI dashboards.
"""

import os
import sys
import json
import argparse
import datetime
import pandas as pd
import numpy as np
from db_compat import connect, read_df, execute

NIFTY_BENCHMARK = "NIFTY50"

def run_backtest(filters: list[str], horizon: str = '3d', initial_capital: float = 1000000.0, max_positions: int = 10, start_date: str = None, end_date: str = None, save_db: bool = True):
    print(f"[LiveScreenerBacktester] Starting backtest for filters: {filters}")
    print(f"  Horizon: {horizon} | Initial Capital: Rs. {initial_capital:,.2f} | Max Positions: {max_positions}")
    
    if not filters:
        print("[Error] No filters provided for backtest.")
        return
        
    horizon_days_map = {'1d': 1, '3d': 3, '5d': 5}
    horizon_days = horizon_days_map.get(horizon, 3)
    return_col = f"return_{horizon}"
    
    # 1. Fetch live screener outcomes for the specified filters
    placeholders = ",".join(["?"] * len(filters))
    q = f"""
        SELECT symbol, appeared_at, entry_price, return_1d, return_3d, return_5d, filter_key
        FROM live_screener_outcomes
        WHERE filter_key IN ({placeholders})
    """
    df = read_df(q, tuple(filters))
    
    if df.empty:
        print("[LiveScreenerBacktester] No historical outcome records found for these filters.")
        return
        
    # Group by (appeared_at, symbol) to ensure we require ALL of the specified filters to be active
    grouped = df.groupby(['appeared_at', 'symbol'])
    signals = []
    
    for (appeared_at, symbol), g in grouped:
        # Check start/end bounds if specified
        if start_date and appeared_at < start_date:
            continue
        if end_date and appeared_at > end_date:
            continue
            
        unique_filters = g['filter_key'].unique()
        if len(unique_filters) == len(filters):
            # Take the first entry
            first_row = g.iloc[0]
            signals.append({
                'symbol': symbol,
                'appeared_at': appeared_at,
                'entry_price': first_row['entry_price'],
                'return_val': first_row[return_col]
            })
            
    if not signals:
        print("[LiveScreenerBacktester] No dates found where ALL of the selected filters matched simultaneously.")
        return
        
    signals_df = pd.DataFrame(signals)
    signals_df = signals_df.sort_values('appeared_at')
    print(f"[LiveScreenerBacktester] Generated {len(signals_df)} entry signals.")
    
    # 2. Replay chronological timeline
    unique_dates = sorted(signals_df['appeared_at'].unique())
    
    cash = initial_capital
    portfolio_value = initial_capital
    open_positions = [] # list of dicts: {'symbol', 'entry_date', 'entry_price', 'shares', 'capital', 'return_val', 'days_left'}
    trade_log = []
    daily_equity = {}
    
    # Track daily equity for all active dates
    # (Pre-fill with initial capital)
    start_dt = datetime.datetime.strptime(unique_dates[0], "%Y-%m-%d") if unique_dates else datetime.datetime.now()
    end_dt = datetime.datetime.strptime(unique_dates[-1], "%Y-%m-%d") if unique_dates else datetime.datetime.now()
    end_dt += datetime.timedelta(days=horizon_days + 2)
    
    all_dates = [ (start_dt + datetime.timedelta(days=x)).strftime("%Y-%m-%d") for x in range((end_dt - start_dt).days + 1) ]
    
    # We will step day-by-day
    for date_str in all_dates:
        # A. Process exits for positions whose days_left has reached 0
        exited = []
        for pos in open_positions:
            pos['days_left'] -= 1
            if pos['days_left'] <= 0:
                ret_pct = pos['return_val'] if pos['return_val'] is not None else 0.0
                proceeds = pos['capital'] * (1.0 + ret_pct / 100.0)
                pnl = proceeds - pos['capital']
                cash += proceeds
                
                trade_log.append({
                    'symbol': pos['symbol'],
                    'entry_date': pos['entry_date'],
                    'exit_date': date_str,
                    'entry_price': round(pos['entry_price'], 2),
                    'exit_price': round(pos['entry_price'] * (1.0 + ret_pct / 100.0), 2),
                    'return_pct': round(ret_pct, 4),
                    'pnl': round(pnl, 2),
                    'outcome': 'WIN' if ret_pct > 0 else 'LOSS' if ret_pct < 0 else 'NEUTRAL',
                    'holding_days': horizon_days
                })
                exited.append(pos)
                
        # Remove exited positions
        for pos in exited:
            open_positions.remove(pos)
            
        # B. Process new entries for this day
        today_signals = signals_df[signals_df['appeared_at'] == date_str]
        for _, sig in today_signals.iterrows():
            sym = sig['symbol']
            
            # Skip if already open or portfolio is full
            if len(open_positions) >= max_positions:
                break
            if any(p['symbol'] == sym for p in open_positions):
                continue
                
            # Determine size
            pos_size = initial_capital / max_positions
            if cash < pos_size:
                pos_size = cash
                
            if pos_size < 1000: # negligible position size
                continue
                
            cash -= pos_size
            shares = pos_size / sig['entry_price'] if sig['entry_price'] > 0 else 0
            
            open_positions.append({
                'symbol': sym,
                'entry_date': date_str,
                'entry_price': sig['entry_price'],
                'shares': shares,
                'capital': pos_size,
                'return_val': sig['return_val'],
                'days_left': horizon_days
            })
            
        # C. Calculate end-of-day equity
        open_value = sum(p['capital'] for p in open_positions)
        daily_equity[date_str] = cash + open_value
        
    # Calculate returns statistics
    equity_series = pd.Series(daily_equity)
    final_equity = equity_series.iloc[-1]
    total_ret = (final_equity - initial_capital) / initial_capital * 100.0
    
    # Sharpe & Sortino Calculations
    daily_rets = equity_series.pct_change().dropna()
    rf_daily = 0.065 / 365 # 6.5% risk free rate
    excess_rets = daily_rets - rf_daily
    
    sharpe = 0.0
    if len(excess_rets) > 1 and daily_rets.std() > 0:
        sharpe = (excess_rets.mean() / daily_rets.std()) * np.sqrt(252)
        
    sortino = 0.0
    downside_std = daily_rets[daily_rets < 0].std()
    if len(excess_rets) > 1 and downside_std > 0:
        sortino = (excess_rets.mean() / downside_std) * np.sqrt(252)
        
    # Drawdown
    cum_max = equity_series.cummax()
    drawdowns = (equity_series - cum_max) / cum_max * 100.0
    max_dd = drawdowns.min()
    
    # Calculate benchmark (Nifty 50) return
    nifty_ret = 0.0
    try:
        nifty_q = f"""
            SELECT date, close FROM stock_ohlcv
            WHERE symbol = '{NIFTY_BENCHMARK}' AND date BETWEEN ? AND ?
            ORDER BY date
        """
        nifty_df = read_df(nifty_q, (unique_dates[0], unique_dates[-1]))
        if not nifty_df.empty:
            nifty_start = nifty_df['close'].iloc[0]
            nifty_end = nifty_df['close'].iloc[-1]
            nifty_ret = (nifty_end - nifty_start) / nifty_start * 100.0
    except Exception as e:
        print(f"  [Benchmark] Failed to load Nifty benchmarking: {e}")
        
    alpha = total_ret - nifty_ret
    
    # Win rate
    wins = [t for t in trade_log if t['return_pct'] > 0]
    win_rate = len(wins) / len(trade_log) if trade_log else 0.0
    avg_trade_ret = np.mean([t['return_pct'] for t in trade_log]) if trade_log else 0.0
    
    print("\n[Backtest Results]")
    print(f"  Total Return: {total_ret:.2f}% (Benchmark Nifty: {nifty_ret:.2f}%)")
    print(f"  Alpha: {alpha:.2f}%")
    print(f"  Win Rate: {win_rate*100:.2f}% | Total Trades: {len(trade_log)}")
    print(f"  Sharpe: {sharpe:.2f} | Sortino: {sortino:.2f} | Max Drawdown: {max_dd:.2f}%")
    
    if save_db:
        # Persist to backtesting_runs
        config = {
            'filters': filters,
            'horizon': horizon,
            'max_positions': max_positions,
            'initial_capital': initial_capital,
            'start': unique_dates[0],
            'end': unique_dates[-1],
            'symbols_count': len(signals_df['symbol'].unique())
        }
        
        # Calculate profit factor safely
        gross_profits = sum([t['pnl'] for t in trade_log if t['pnl'] > 0])
        gross_losses = abs(sum([t['pnl'] for t in trade_log if t['pnl'] < 0]))
        pf = float(gross_profits / gross_losses) if gross_losses > 0 else 1.0

        stats = {
            'total_trades': int(len(trade_log)),
            'win_rate': float(round(win_rate, 4)),
            'total_return_pct': float(round(total_ret, 4)),
            'cagr_pct': float(round(total_ret, 4)),
            'sharpe_ratio': float(round(sharpe, 4)),
            'sortino_ratio': float(round(sortino, 4)),
            'calmar_ratio': float(round(abs(total_ret / max_dd), 4)) if max_dd != 0 else 0.0,
            'max_drawdown_pct': float(round(max_dd, 4)),
            'nifty_return_pct': float(round(nifty_ret, 4)),
            'alpha_pct': float(round(alpha, 4)),
            'avg_return_pct': float(round(avg_trade_ret, 4)),
            'profit_factor': float(round(pf, 4)),
            'avg_holding_days': float(horizon_days),
            'monthly_returns': {}
        }
        
        # Build equity curve weekly
        eq_curve_clean = {k: float(v) for k, v in daily_equity.items()}
        
        execute("""
            INSERT INTO backtesting_runs
                (run_name, strategy_config_json, start_date, end_date,
                 symbols_count, total_trades, win_rate, total_return_pct,
                 cagr_pct, sharpe_ratio, calmar_ratio, sortino_ratio,
                 max_drawdown_pct, nifty_return_pct, alpha_pct,
                 avg_trade_return_pct, profit_factor, avg_holding_days,
                 monthly_returns_json, equity_curve_json, trade_log_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            f"live_screener_{'_'.join(filters[:2])}",
            json.dumps(config),
            unique_dates[0],
            unique_dates[-1],
            int(config['symbols_count']),
            int(stats['total_trades']),
            float(stats['win_rate']),
            float(stats['total_return_pct']),
            float(stats['cagr_pct']),
            float(stats['sharpe_ratio']),
            float(stats['calmar_ratio']),
            float(stats['sortino_ratio']),
            float(stats['max_drawdown_pct']),
            float(stats['nifty_return_pct']),
            float(stats['alpha_pct']),
            float(stats['avg_return_pct']),
            float(stats['profit_factor']),
            float(stats['avg_holding_days']),
            "{}",
            json.dumps(eq_curve_clean),
            json.dumps(trade_log[-500:])
        ))
        print("[LiveScreenerBacktester] Saved backtest run to backtesting_runs table.")

def show_recommendations():
    conn = connect()
    row = conn.execute("SELECT value FROM app_settings WHERE key = 'live_screener_optimal_combinations'").fetchone()
    conn.close()
    if row:
        data = json.loads(row[0])
        print("\n=== OPTIMAL MULTI-FILTER COMBINATIONS (From Decision Tree Optimization) ===")
        for idx, comb in enumerate(data.get('optimal_combinations', [])[:5]):
            print(f" {idx+1}. Filters: {comb['filters']} | Avg Return: {comb['avg_return']}% | Win Rate: {comb['win_rate']*100:.1f}% | Samples: {comb['sample_count']}")
        print("\n=== TOP SINGLE FILTERS ===")
        for idx, single in enumerate(data.get('single_filter_rankings', [])[:5]):
            print(f" {idx+1}. Filter: {single['filter']} | Avg Return: {single['avg_return']}% | Win Rate: {single['win_rate']*100:.1f}% | Samples: {single['sample_count']}")
    else:
        print("[LiveScreenerBacktester] No recommendations found. Run live_screener_optimizer.py first.")

def auto_backtest_top(n: int = 5, horizon: str = '3d', initial_capital: float = 1000000.0, max_positions: int = 10):
    """Reads top N combinations from app_settings and runs a backtest for each one."""
    conn = connect()
    row = conn.execute("SELECT value FROM app_settings WHERE key = 'live_screener_optimal_combinations'").fetchone()
    conn.close()
    if not row:
        print("[AutoBacktest] No optimal combinations found. Run live_screener_optimizer.py first.")
        return

    data = json.loads(row[0])
    combos = data.get('optimal_combinations', [])[:n]
    singles = data.get('single_filter_rankings', [])[:n]

    print(f"[AutoBacktest] Running {len(combos)} multi-filter + {len(singles)} single-filter backtests...")

    for combo in combos:
        filters = combo['filters']
        print(f"\n[AutoBacktest] Multi-filter: {filters}")
        try:
            run_backtest(filters, horizon, initial_capital, max_positions)
        except Exception as e:
            print(f"  [AutoBacktest] Failed: {e}")

    for single in singles:
        f = single['filter']
        print(f"\n[AutoBacktest] Single filter: {f}")
        try:
            run_backtest([f], horizon, initial_capital, max_positions)
        except Exception as e:
            print(f"  [AutoBacktest] Failed: {e}")

    print(f"\n[AutoBacktest] Completed. Results available in backtesting_runs table (run_name LIKE 'live_screener_%').")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Backtest custom NiftyTrader live screener combinations.")
    parser.add_argument('--filters', type=str, help="Comma-separated NiftyTrader filter keys.")
    parser.add_argument('--horizon', type=str, choices=['1d', '3d', '5d'], default='3d', help="Holding period horizon.")
    parser.add_argument('--capital', type=float, default=1000000.0, help="Initial portfolio capital.")
    parser.add_argument('--max-positions', type=int, default=10, help="Maximum open concurrent positions.")
    parser.add_argument('--start', type=str, help="Start date (YYYY-MM-DD).")
    parser.add_argument('--end', type=str, help="End date (YYYY-MM-DD).")
    parser.add_argument('--recommend', action='store_true', help="Show recommended combinations from optimizer.")
    parser.add_argument('--auto-backtest-top', type=int, metavar='N', help="Auto-backtest top N combos from optimizer.")
    
    args = parser.parse_args()
    
    if args.recommend:
        show_recommendations()
    elif args.auto_backtest_top:
        auto_backtest_top(args.auto_backtest_top, args.horizon, args.capital, args.max_positions)
    elif args.filters:
        filters_list = [f.strip() for f in args.filters.split(',')]
        run_backtest(filters_list, args.horizon, args.capital, args.max_positions, args.start, args.end)
    else:
        parser.print_help()
