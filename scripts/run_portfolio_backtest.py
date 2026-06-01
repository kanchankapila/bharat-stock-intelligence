#!/usr/bin/env python3
import argparse
import json
import os
import sys
from importlib import util


def load_backtester_module(path: str):
    spec = util.spec_from_file_location('backtester_mod', path)
    mod = util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    parser = argparse.ArgumentParser(description='Run backtest for a set of symbols')
    parser.add_argument('--symbols-file', type=str, required=True, help='JSON file with array of symbols')
    parser.add_argument('--start', type=str, default='2023-01-01')
    parser.add_argument('--end', type=str, default=None)
    parser.add_argument('--horizon', type=int, default=15)
    parser.add_argument('--min-score', type=int, default=0)
    parser.add_argument('--name', type=str, default='portfolio_backtest')
    args = parser.parse_args()

    if args.end is None:
        from datetime import date
        args.end = date.today().isoformat()

    symbols_path = os.path.abspath(args.symbols_file)
    if not os.path.exists(symbols_path):
        print(f"Symbols file not found: {symbols_path}")
        sys.exit(2)

    with open(symbols_path, 'rb') as f:
        raw = f.read()
    # decode using utf-8-sig to handle BOM variants
    symbols = json.loads(raw.decode('utf-8-sig'))
    if not isinstance(symbols, list) or not symbols:
        print('Symbols file must contain a non-empty JSON array of symbol strings')
        sys.exit(2)

    # locate backtester.py
    bt_path = os.path.join(os.getcwd(), 'src', 'server', 'backtester.py')
    if not os.path.exists(bt_path):
        bt_path = os.path.join(os.getcwd(), 'backend-python', 'app', 'backtester.py')
    if not os.path.exists(bt_path):
        print('Could not find backtester.py in expected locations.')
        sys.exit(2)

    mod = load_backtester_module(bt_path)
    Backtester = getattr(mod, 'Backtester')

    bt = Backtester()
    try:
        # load signals across the date range but filter to our portfolio symbols
        signals = bt.load_signals(args.start, args.end, min_score=args.min_score, horizon_days=args.horizon)
        # If no historical signals exist, construct synthetic entry signals at start date for the provided symbols
        if signals.empty:
            print('No historical signals found; creating synthetic entry signals at start date for provided symbols.')
            df = mod.pd.DataFrame([
                {'symbol': s, 'signal_date': mod.pd.to_datetime(args.start), 'signal_score': 5, 'cmp': None, 'stop_loss': None, 'signals_json': '{}', 'nifty_regime': None, 'adx': None, 'horizon_days': args.horizon}
                for s in symbols
            ])
            signals = df
        else:
            signals = signals[signals['symbol'].isin(symbols)]
            if signals.empty:
                print('No signals for provided symbols in the date range; creating synthetic entries at start date.')
                df = mod.pd.DataFrame([
                    {'symbol': s, 'signal_date': mod.pd.to_datetime(args.start), 'signal_score': 5, 'cmp': None, 'stop_loss': None, 'signals_json': '{}', 'nifty_regime': None, 'adx': None, 'horizon_days': args.horizon}
                    for s in symbols
                ])
                signals = df

        # load OHLCV only for our symbols
        extended_end = (mod.pd.to_datetime(args.end) + mod.pd.Timedelta(days=args.horizon + 10)).strftime('%Y-%m-%d')
        ohlcv_all = bt.load_ohlcv(symbols, args.start, extended_end)
        if ohlcv_all.empty:
            print('No OHLCV data for provided symbols.')
            return
        ohlcv_dict = {sym: grp.reset_index(drop=True) for sym, grp in ohlcv_all.groupby('symbol')}
        nifty_curve = bt.load_nifty(args.start, extended_end)

        trade_log, equity_curve = bt.simulate_trades(signals, ohlcv_dict, max_positions=20, initial_capital=mod.INITIAL_CAPITAL)
        if not trade_log:
            print('No trades executed for provided symbols.')
            return
        stats = bt.compute_stats(trade_log, equity_curve, nifty_curve, mod.INITIAL_CAPITAL)
        run_id = bt.save_run(args.name, {
            'start': args.start, 'end': args.end, 'horizon_days': args.horizon,
            'symbols_count': len(symbols)
        }, stats, trade_log, equity_curve)
        print('Backtest complete. run_id=', run_id)
        print(json.dumps(stats, indent=2))
    finally:
        bt.close()


if __name__ == '__main__':
    main()
