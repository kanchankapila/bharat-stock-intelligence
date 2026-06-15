"""
Historical Backtesting Engine
================================
Replays all historical technical_signals against actual OHLCV prices to simulate
portfolio performance.  Benchmarks vs Nifty 50 buy-and-hold.

Simulation rules:
  - Entry: next available open price after signal_date
  - Exit:  close price at signal_date + horizon_days (or stop-loss, whichever first)
  - Stop-loss: enforced if intraday low drops below SL level from the signal
  - Position sizing: equal-weight (1 / max_positions of portfolio capital)
  - Max simultaneous positions: 20 (configurable)
  - No short selling
  - No slippage model (conservative — add slippage_bps if needed)

Writes results to backtesting_runs table.

Requirements:
    pip install pandas numpy

Run:  python backtester.py
      python backtester.py --start 2023-01-01 --end 2024-12-31
      python backtester.py --horizon 15 --min-score 5 --initial-capital 1000000
      python backtester.py --strategies momentum,value,quality
"""

import os, json, math, datetime, argparse, sqlite3
import numpy as np
import pandas as pd

DB_PATH = os.path.join(os.getcwd(), os.environ.get('DATABASE_URL', 'database.sqlite'))

NIFTY_SYMBOLS  = ('NIFTY50', 'NIFTY', '^NSEI')
INITIAL_CAPITAL = 1_000_000   # ₹10L default

# ──────────────────────────────────────────────────────────────────────────
# PHASE 3.1: Indian Market Holidays (NSE/BSE closed)
# Updated for 2024-2025. Add new holidays annually.
# ──────────────────────────────────────────────────────────────────────────
NSE_MARKET_HOLIDAYS = {
    # 2024
    datetime.date(2024, 1, 26),   # Republic Day
    datetime.date(2024, 3, 8),    # Maha Shivaratri
    datetime.date(2024, 3, 25),   # Holi
    datetime.date(2024, 3, 29),   # Good Friday
    datetime.date(2024, 4, 11),   # Eid-ul-Fitr (tentative)
    datetime.date(2024, 4, 17),   # Ram Navami
    datetime.date(2024, 4, 21),   # Mahavir Jayanti
    datetime.date(2024, 5, 23),   # Buddha Purnima
    datetime.date(2024, 6, 17),   # Eid-ul-Adha (tentative)
    datetime.date(2024, 7, 17),   # Muharram
    datetime.date(2024, 8, 15),   # Independence Day
    datetime.date(2024, 8, 26),   # Janmashtami
    datetime.date(2024, 9, 16),   # Milad-un-Nabi
    datetime.date(2024, 10, 2),   # Gandhi Jayanti
    datetime.date(2024, 10, 12),  # Dussehra
    datetime.date(2024, 10, 31),  # Diwali
    datetime.date(2024, 11, 1),   # Diwali (Day 2)
    datetime.date(2024, 11, 15),  # Guru Nanak Jayanti
    datetime.date(2024, 12, 25),  # Christmas
    
    # 2025
    datetime.date(2025, 1, 26),   # Republic Day
    datetime.date(2025, 3, 14),   # Holi
    datetime.date(2025, 3, 21),   # Good Friday
    datetime.date(2025, 4, 11),   # Eid-ul-Fitr
    datetime.date(2025, 4, 18),   # Ram Navami
    datetime.date(2025, 4, 21),   # Mahavir Jayanti
    datetime.date(2025, 5, 23),   # Buddha Purnima
    datetime.date(2025, 6, 7),    # Eid-ul-Adha
    datetime.date(2025, 7, 7),    # Muharram
    datetime.date(2025, 8, 15),   # Independence Day
    datetime.date(2025, 8, 27),   # Janmashtami
    datetime.date(2025, 9, 5),    # Milad-un-Nabi
    datetime.date(2025, 10, 2),   # Gandhi Jayanti
    datetime.date(2025, 10, 1),   # Dussehra
    datetime.date(2025, 10, 20),  # Diwali
    datetime.date(2025, 10, 21),  # Diwali (Day 2)
    datetime.date(2025, 11, 15),  # Guru Nanak Jayanti
    datetime.date(2025, 12, 25),  # Christmas
}

def is_market_open(date: datetime.date) -> bool:
    """Check if market is open on given date (not weekend or holiday)"""
    # Sundays (6) and Saturdays (5) are weekends
    if date.weekday() >= 5:
        return False
    # Check if it's a market holiday
    if date in NSE_MARKET_HOLIDAYS:
        return False
    return True


class Backtester:
    def __init__(self, db_path: str = DB_PATH):
        self.conn = sqlite3.connect(db_path)

    def close(self):
        self.conn.close()

    # ──────────────────────────────────────────────────────────────────────────
    # Data loading
    # ──────────────────────────────────────────────────────────────────────────

    def load_signals(
        self,
        start: str, end: str,
        min_score: int = 3,
        horizon_days: int = 15,
        source: str = 'ALL',
    ) -> pd.DataFrame:
        if source == 'ALL':
            source_filter = "1=1"
        else:
            source_filter = f"us.signal_source = '{source}'"

        q = f"""
            SELECT us.symbol, us.signal_date, us.confidence_score AS signal_score,
                   us.entry_price AS entry_price_ref, us.stop_loss, us.reasoning AS signals_json,
                   'UNKNOWN' AS nifty_regime, 0 AS adx
            FROM unified_signals us
            WHERE us.signal_date BETWEEN ? AND ?
              AND us.confidence_score >= ?
              AND {source_filter}
              AND us.signal_type IN ('BUY', 'STRONG_BUY')
            ORDER BY us.signal_date ASC
        """
        df = pd.read_sql_query(q, self.conn, params=(start, end, min_score))
        df['signal_date']    = pd.to_datetime(df['signal_date'])
        df['horizon_days']   = horizon_days
        df['entry_price_ref'] = pd.to_numeric(df['entry_price_ref'], errors='coerce')
        df['stop_loss']       = pd.to_numeric(df['stop_loss'],        errors='coerce')
        return df

    def load_ohlcv(self, symbols: list[str], start: str, end: str) -> pd.DataFrame:
        if not symbols:
            return pd.DataFrame()
        sym_list = "','".join(symbols)
        q = f"""
            SELECT symbol, date, open, high, low, close, volume
            FROM stock_ohlcv
            WHERE symbol IN ('{sym_list}')
              AND date BETWEEN '{start}' AND '{end}'
            ORDER BY symbol, date
        """
        df = pd.read_sql_query(q, self.conn)
        df['date']  = pd.to_datetime(df['date'])
        for col in ['open', 'high', 'low', 'close']:
            df[col] = pd.to_numeric(df[col], errors='coerce')
        return df

    def load_nifty(self, start: str, end: str) -> pd.Series:
        sym_list = "','".join(NIFTY_SYMBOLS)
        q = f"""
            SELECT date, close FROM stock_ohlcv
            WHERE symbol IN ('{sym_list}')
              AND date BETWEEN '{start}' AND '{end}'
            ORDER BY date
        """
        df = pd.read_sql_query(q, self.conn)
        if df.empty:
            return pd.Series(dtype=float)
        df['date']  = pd.to_datetime(df['date'])
        df['close'] = pd.to_numeric(df['close'], errors='coerce')
        df = df.dropna().sort_values('date').drop_duplicates('date').set_index('date')
        return df['close']

    # ──────────────────────────────────────────────────────────────────────────
    # Trade simulation
    # ──────────────────────────────────────────────────────────────────────────

    def simulate_trades(
        self,
        signals: pd.DataFrame,
        ohlcv_dict: dict[str, pd.DataFrame],
        max_positions: int = 20,
        initial_capital: float = INITIAL_CAPITAL,
        slippage_bps: float = 10,
        stop_loss_pct: float = 7.0,
    ) -> tuple[list[dict], pd.Series]:
        """
        Simulate trades from signals.  Returns (trade_log, equity_curve_daily).
        equity_curve_daily: pd.Series indexed by date.
        
        PHASE 3.1: Respects market holidays and weekends.
        """
        trade_log: list[dict] = []
        # Position state: symbol -> {entry_date, entry_price, sl, horizon_days, shares}
        open_positions: dict[str, dict] = {}
        all_dates = sorted(
            pd.to_datetime(list({
                d for df in ohlcv_dict.values() for d in df['date'].tolist()
            }))
        )
        # PHASE 3.1: Filter out market holidays and weekends
        all_dates = [d for d in all_dates if is_market_open(d.date())]
        
        if not all_dates:
            return [], pd.Series(dtype=float)

        capital   = initial_capital
        cash      = capital
        portfolio_value = capital
        equity: dict = {}    # date → portfolio value

        slippage  = 1 + slippage_bps / 10_000  # buy slightly higher

        signals_by_date: dict = {}
        for _, row in signals.iterrows():
            d = row['signal_date'].date()
            signals_by_date.setdefault(d, []).append(row)

        for date in all_dates:
            d = date.date()

            # ── Close positions that have reached their horizon ──────────────
            for sym in list(open_positions.keys()):
                pos   = open_positions[sym]
                # PHASE 3.1: Count only trading days (market-open days) not calendar days
                trading_days_held = sum(
                    1 for check_date in all_dates 
                    if pos['entry_date'] <= check_date <= date
                )
                if trading_days_held < pos['horizon_days']:
                    continue
                if sym not in ohlcv_dict:
                    continue
                day_ohlcv = ohlcv_dict[sym][ohlcv_dict[sym]['date'] == date]
                if day_ohlcv.empty:
                    continue
                exit_price = float(day_ohlcv['close'].iloc[0])
                ret_pct    = (exit_price - pos['entry_price']) / pos['entry_price'] * 100
                pnl        = (exit_price - pos['entry_price']) * pos['shares']
                cash      += exit_price * pos['shares']
                outcome    = 'WIN' if ret_pct > 1.0 else 'LOSS' if ret_pct < -1.0 else 'NEUTRAL'
                trade_log.append({
                    'symbol':       sym,
                    'entry_date':   pos['entry_date'].isoformat(),
                    'exit_date':    date.isoformat(),
                    'entry_price':  round(pos['entry_price'], 2),
                    'exit_price':   round(exit_price, 2),
                    'return_pct':   round(ret_pct, 4),
                    'pnl':          round(pnl, 2),
                    'outcome':      outcome,
                    'signal_score': pos['signal_score'],
                    'holding_days': trading_days_held,
                })
                del open_positions[sym]

            # ── Stop-loss check (intraday low) ───────────────────────────────
            for sym in list(open_positions.keys()):
                pos = open_positions[sym]
                if not pos.get('stop_loss') or sym not in ohlcv_dict:
                    continue
                day_ohlcv = ohlcv_dict[sym][ohlcv_dict[sym]['date'] == date]
                if day_ohlcv.empty:
                    continue
                day_low = float(day_ohlcv['low'].iloc[0])
                if day_low <= pos['stop_loss']:
                    exit_price = pos['stop_loss']  # assume stops are honoured
                    ret_pct    = (exit_price - pos['entry_price']) / pos['entry_price'] * 100
                    pnl        = (exit_price - pos['entry_price']) * pos['shares']
                    cash      += exit_price * pos['shares']
                    # PHASE 3.1: Count only trading days for stop-loss trades
                    trading_days_held_sl = sum(
                        1 for check_date in all_dates 
                        if pos['entry_date'] <= check_date <= date
                    )
                    trade_log.append({
                        'symbol':       sym,
                        'entry_date':   pos['entry_date'].isoformat(),
                        'exit_date':    date.isoformat(),
                        'entry_price':  round(pos['entry_price'], 2),
                        'exit_price':   round(exit_price, 2),
                        'return_pct':   round(ret_pct, 4),
                        'pnl':          round(pnl, 2),
                        'outcome':      'STOP_LOSS',
                        'signal_score': pos['signal_score'],
                        'holding_days': trading_days_held_sl,
                    })
                    del open_positions[sym]

            # ── Open new positions from today's signals ───────────────────────
            today_sigs = signals_by_date.get(d, [])
            for row in today_sigs:
                sym = row['symbol']
                if sym in open_positions or len(open_positions) >= max_positions:
                    continue
                if sym not in ohlcv_dict:
                    continue
                
                # PHASE 1 FIX: Use next trading day's open price (not signal_date close)
                next_days = ohlcv_dict[sym][ohlcv_dict[sym]['date'] > date].head(1)
                if next_days.empty:
                    continue
                entry_date = pd.to_datetime(next_days['date'].iloc[0])
                entry_price = float(next_days['open'].iloc[0]) * slippage
                if pd.isna(entry_price) or entry_price <= 0:
                    continue

                # Position sizing logic
                use_kelly = False  # Phase 3 scaffold flag
                if use_kelly:
                    # Phase 3 Scaffold: Kelly Criterion
                    # f* = W - (1-W)/R, where W = win_rate, R = win/loss ratio
                    # TODO: Fetch dynamic win rate and W/L ratio per signal type from database
                    historical_win_rate = 0.55
                    historical_win_loss_ratio = 1.2
                    kelly_f = historical_win_rate - ((1 - historical_win_rate) / historical_win_loss_ratio)
                    kelly_f = max(0, min(kelly_f, 0.2)) # Cap at 20% max allocation
                    position_capital = capital * kelly_f  # fraction of total capital
                    position_capital = min(position_capital, cash) # Can't invest more than cash
                else:
                    # Equal-weight position size
                    position_capital = cash / max(max_positions - len(open_positions), 1)
                    
                position_capital = min(position_capital, capital * 0.1)  # max 10% per trade hard cap
                if position_capital < 1000:
                    continue
                shares = math.floor(position_capital / entry_price)
                if shares < 1:
                    continue

                cost = shares * entry_price
                cash -= cost

                # Use signal's stop_loss if provided, else calculate based on entry price
                sl = float(row['stop_loss']) if pd.notna(row['stop_loss']) else entry_price * (1 - stop_loss_pct / 100)
                open_positions[sym] = {
                    'entry_date':   entry_date,  # Actual entry date (next trading day), not signal_date
                    'entry_price':  entry_price,
                    'stop_loss':    sl,
                    'horizon_days': int(row['horizon_days']),
                    'shares':       shares,
                    'signal_score': int(row['signal_score']),
                }

            # ── Mark-to-market portfolio value ───────────────────────────────
            mtm = cash
            for sym, pos in open_positions.items():
                if sym in ohlcv_dict:
                    day_ohlcv = ohlcv_dict[sym][ohlcv_dict[sym]['date'] == date]
                    if not day_ohlcv.empty:
                        mtm += float(day_ohlcv['close'].iloc[0]) * pos['shares']
                    else:
                        mtm += pos['entry_price'] * pos['shares']  # last known
            equity[date] = round(mtm, 2)

        equity_series = pd.Series(equity)
        return trade_log, equity_series

    # ──────────────────────────────────────────────────────────────────────────
    # Performance statistics
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    def compute_stats(
        trade_log: list[dict],
        equity_curve: pd.Series,
        nifty_curve: pd.Series,
        initial_capital: float,
    ) -> dict:
        if not trade_log or equity_curve.empty:
            return {}

        trades = pd.DataFrame(trade_log)
        rets   = trades['return_pct']
        wins   = trades['return_pct'] > 1.0
        losses = trades['return_pct'] < -1.0

        # Total return
        final_value  = float(equity_curve.iloc[-1])
        total_ret    = (final_value - initial_capital) / initial_capital * 100

        # CAGR
        days_elapsed = (equity_curve.index[-1] - equity_curve.index[0]).days
        years        = max(days_elapsed / 365.25, 0.01)
        cagr         = ((final_value / initial_capital) ** (1 / years) - 1) * 100

        # Daily returns
        daily_rets = equity_curve.pct_change().dropna()
        sharpe     = (daily_rets.mean() / daily_rets.std() * math.sqrt(252)
                      if daily_rets.std() > 0 else 0.0)

        # Sortino (downside deviation only)
        neg_rets  = daily_rets[daily_rets < 0]
        sortino   = (daily_rets.mean() / neg_rets.std() * math.sqrt(252)
                     if len(neg_rets) > 1 and neg_rets.std() > 0 else 0.0)

        # Max drawdown
        peak    = equity_curve.cummax()
        drawdown = ((equity_curve - peak) / peak * 100)
        max_dd  = float(drawdown.min())

        # Calmar = CAGR / |Max DD|
        calmar = (cagr / abs(max_dd)) if abs(max_dd) > 0 else 0.0

        # Profit factor
        sum_wins   = rets[wins].sum()
        sum_losses = abs(rets[losses].sum())
        profit_factor = (sum_wins / sum_losses) if sum_losses > 0 else sum_wins

        # Nifty benchmark
        nifty_ret = 0.0
        if not nifty_curve.empty:
            # Align to equity_curve dates
            aligned_nifty = nifty_curve.reindex(equity_curve.index, method='ffill').dropna()
            if len(aligned_nifty) >= 2:
                nifty_ret = (aligned_nifty.iloc[-1] / aligned_nifty.iloc[0] - 1) * 100
        alpha = total_ret - nifty_ret

        # Monthly returns
        monthly = equity_curve.resample('ME').last().pct_change().dropna() * 100
        monthly_dict = {str(d.date())[:7]: round(float(v), 2)
                        for d, v in monthly.items()}

        # Avg holding period
        avg_hold = float(trades['holding_days'].mean()) if 'holding_days' in trades else 0.0

        return {
            'total_trades':      len(trade_log),
            'win_count':         int(wins.sum()),
            'loss_count':        int(losses.sum()),
            'win_rate':          round(float(wins.mean()), 4),
            'total_return_pct':  round(total_ret, 4),
            'cagr_pct':          round(cagr, 4),
            'sharpe_ratio':      round(float(sharpe), 4),
            'sortino_ratio':     round(float(sortino), 4),
            'calmar_ratio':      round(float(calmar), 4),
            'max_drawdown_pct':  round(max_dd, 4),
            'profit_factor':     round(float(profit_factor), 4),
            'avg_return_pct':    round(float(rets.mean()), 4),
            'avg_holding_days':  round(avg_hold, 2),
            'nifty_return_pct':  round(nifty_ret, 4),
            'alpha_pct':         round(alpha, 4),
            'monthly_returns':   monthly_dict,
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Persistence
    # ──────────────────────────────────────────────────────────────────────────

    def save_run(
        self,
        run_name: str,
        config: dict,
        stats: dict,
        trade_log: list[dict],
        equity_curve: pd.Series,
    ) -> int:
        cur = self.conn.cursor()
        # Trim equity curve to 1 point per week to keep JSON small
        ec_weekly  = equity_curve.resample('W').last()
        ec_json    = json.dumps({str(d.date()): float(v) for d, v in ec_weekly.items()})
        # Trim trade log to last 500 trades
        tl_json = json.dumps(trade_log[-500:])

        cur.execute("""
            INSERT INTO backtesting_runs
                (run_name, strategy_config_json, start_date, end_date,
                 symbols_count, total_trades, win_rate, total_return_pct,
                 cagr_pct, sharpe_ratio, calmar_ratio, sortino_ratio,
                 max_drawdown_pct, nifty_return_pct, alpha_pct,
                 avg_trade_return_pct, profit_factor, avg_holding_days,
                 monthly_returns_json, equity_curve_json, trade_log_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            run_name,
            json.dumps(config),
            config.get('start'),
            config.get('end'),
            config.get('symbols_count', 0),
            stats.get('total_trades', 0),
            stats.get('win_rate'),
            stats.get('total_return_pct'),
            stats.get('cagr_pct'),
            stats.get('sharpe_ratio'),
            stats.get('calmar_ratio'),
            stats.get('sortino_ratio'),
            stats.get('max_drawdown_pct'),
            stats.get('nifty_return_pct'),
            stats.get('alpha_pct'),
            stats.get('avg_return_pct'),
            stats.get('profit_factor'),
            stats.get('avg_holding_days'),
            json.dumps(stats.get('monthly_returns', {})),
            ec_json,
            tl_json,
        ))
        self.conn.commit()
        run_id = cur.lastrowid
        print(f"[Backtester] Saved run id={run_id} to backtesting_runs.")
        return run_id

    # ──────────────────────────────────────────────────────────────────────────
    # Main
    # ──────────────────────────────────────────────────────────────────────────

    def run(
        self,
        start: str, end: str,
        horizon_days: int = 15,
        min_score: int = 3,
        max_positions: int = 20,
        initial_capital: float = INITIAL_CAPITAL,
        slippage_bps: float = 10,
        run_name: str = "",
        source: str = 'ALL',
    ) -> dict:
        print(f"\n[Backtester] Running backtest {start} to {end} (Horizon: {horizon_days}d, Source: {source})")

        # 1. Load signals
        signals = self.load_signals(start, end, min_score, horizon_days, source)
        if signals.empty:
            print("[Backtester] No signals found for the given parameters.")
            return {}

        symbols = signals['symbol'].unique().tolist()
        print(f"[Backtester] {len(signals)} signals across {len(symbols)} symbols")

        # Extend end date for exit prices
        extended_end = (pd.to_datetime(end) + pd.Timedelta(days=horizon_days + 10)).strftime('%Y-%m-%d')
        print("[Backtester] Loading OHLCV data...")
        ohlcv_all = self.load_ohlcv(symbols, start, extended_end)

        if ohlcv_all.empty:
            print("[Backtester] No OHLCV data — cannot simulate.")
            return {}

        ohlcv_dict = {sym: grp.reset_index(drop=True) for sym, grp in ohlcv_all.groupby('symbol')}
        nifty_curve = self.load_nifty(start, extended_end)

        print("[Backtester] Simulating trades...")
        trade_log, equity_curve = self.simulate_trades(
            signals, ohlcv_dict,
            max_positions=max_positions,
            initial_capital=initial_capital,
            slippage_bps=slippage_bps,
            stop_loss_pct=stop_loss_pct,
        )

        if not trade_log:
            print("[Backtester] No trades executed.")
            return {}

        stats = self.compute_stats(trade_log, equity_curve, nifty_curve, initial_capital)
        config = {
            'start': start, 'end': end,
            'horizon_days': horizon_days, 'min_score': min_score,
            'max_positions': max_positions,
            'initial_capital': initial_capital,
            'symbols_count': len(symbols),
            'slippage_bps': slippage_bps,
        }

        print(f"\n{'='*60}")
        print(f" BACKTEST RESULTS  {start} → {end}")
        print(f"{'='*60}")
        for k, v in stats.items():
            if k not in ('monthly_returns',):
                print(f"  {k:<25} {v}")

        run_id = self.save_run(
            run_name or f"bt_{start}_{end}_h{horizon_days}_s{min_score}",
            config, stats, trade_log, equity_curve,
        )
        return {'run_id': run_id, **stats}


from pydantic import BaseModel
from typing import Optional

class BacktestRequest(BaseModel):
    start: str
    end: str
    horizon: int = 15
    min_score: int = 3
    max_pos: int = 20
    capital: float = 1_000_000
    slippage: float = 10
    name: str = ""
    source: str = "ALL"

def run_backtest(req: BacktestRequest):
    bt = Backtester()
    try:
        return bt.run(
            start=req.start,
            end=req.end,
            horizon_days=req.horizon,
            min_score=req.min_score,
            max_positions=req.max_pos,
            initial_capital=req.capital,
            run_name=req.name,
            slippage_bps=req.slippage,
            source=req.source,
        )
    finally:
        bt.close()
