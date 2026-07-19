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
  - Commission: 25 bps round-trip by default (configurable via --commission)
  - Slippage: 10 bps default (configurable via --slippage)

Writes results to backtesting_runs table.

Requirements:
    pip install pandas numpy

Run:  python backtester.py
      python backtester.py --start 2023-01-01 --end 2024-12-31
      python backtester.py --horizon 15 --min-score 5 --initial-capital 1000000
      python backtester.py --strategies momentum,value,quality
"""

import os, json, math, datetime, argparse
import numpy as np
import pandas as pd

from db_compat import connect, read_df

NIFTY_SYMBOLS  = ('NIFTY50', 'NIFTY', '^NSEI')
INITIAL_CAPITAL = 1_000_000   # ₹10L default
MAX_KELLY_FRAC = 0.25

def _kelly_fraction(win_prob: float | None, target: float | None, entry: float, stop: float | None) -> float | None:
    """Fractional Kelly size as fraction of capital. Returns None → fall back to equal-weight."""
    if win_prob is None or not (0.01 < win_prob < 0.99):
        return None
    if target is None or stop is None or entry <= 0 or stop >= entry:
        return None
    b = (target - entry) / (entry - stop)
    if b <= 0:
        return None
    p, q = win_prob, 1.0 - win_prob
    f = (p * b - q) / b
    return min(max(f, 0.0), MAX_KELLY_FRAC)


class Backtester:
    def __init__(self):
        self.conn = connect()

    def close(self):
        self.conn.close()

    # ───────────────────────────────────────────────────────────
    def load_signals(
        self,
        start: str, end: str,
        min_score: int = 3,
        horizon_days: int = 15,
    ) -> pd.DataFrame:
        q = """
            SELECT ts.symbol, ts.date AS signal_date, ts.signal_score,
                   ts.cmp AS entry_price_ref, ts.stop_loss, ts.targets, ts.signals_json,
                   ts.nifty_regime, ts.adx, ts.win_probability, ts.calibrated_win_probability
            FROM technical_signals ts
            WHERE ts.date BETWEEN ? AND ?
              AND ts.signal_score >= ?
            ORDER BY ts.date ASC
        """
        df = read_df(q, (start, end, min_score))
        df['signal_date']    = pd.to_datetime(df['signal_date'])
        df['horizon_days']   = horizon_days
        df['entry_price_ref'] = pd.to_numeric(df['entry_price_ref'], errors='coerce')

        # Robust string cleaning/parsing for stop_loss and targets
        def parse_price_str(val):
            if pd.isna(val) or val is None:
                return None
            val_str = str(val).replace(',', '').strip()
            import re
            m = re.search(r'₹\s*([\d\.]+)', val_str)
            if m:
                return float(m.group(1))
            m2 = re.search(r'([\d\.]+)', val_str)
            if m2:
                return float(m2.group(1))
            return None

        df['stop_loss'] = df['stop_loss'].apply(parse_price_str)
        df['target_price'] = df['targets'].apply(parse_price_str)
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
        df = read_df(q)
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
        df = read_df(q)
        if df.empty:
            return pd.Series(dtype=float)
        df['date']  = pd.to_datetime(df['date'])
        df['close'] = pd.to_numeric(df['close'], errors='coerce')
        df = df.dropna().sort_values('date').drop_duplicates('date').set_index('date')
        return df['close']

    def compute_atr_from_df(self, df: pd.DataFrame, signal_date: pd.Timestamp, window: int = 14) -> float:
        """Calculate Wilders ATR(14) from historical stock dataframe up to signal_date."""
        prior_df = df[df['date'] <= signal_date]
        if len(prior_df) < window + 1:
            return 0.0
        prior_df = prior_df.tail(window + 1)
        
        highs = prior_df['high'].values
        lows = prior_df['low'].values
        closes = prior_df['close'].values
        
        trs = []
        prev_close = closes[0]
        for i in range(1, len(prior_df)):
            h = float(highs[i])
            l = float(lows[i])
            c = float(closes[i])
            prev_c = float(prev_close)
            tr = max(h - l, abs(h - prev_c), abs(l - prev_c))
            trs.append(tr)
            prev_close = c
            
        return sum(trs) / len(trs) if trs else 0.0

    # ──────────────────────────────────────────────────────────────────────────
    # Trade simulation
    # ──────────────────────────────────────────────────────────────────────────

    def simulate_trades(
        self,
        signals: pd.DataFrame,
        ohlcv_dict: dict[str, pd.DataFrame],
        max_positions: int = 20,
        initial_capital: float = INITIAL_CAPITAL,
        slippage_bps: float = 15,
        stop_loss_pct: float = 7.0,
        commission_bps: float = 40,
    ) -> tuple[list[dict], pd.Series]:
        # commission_bps=40 covers realistic Indian round-trip friction:
        #   STT buy+sell = 20 bps, Stamp duty ≈ 2 bps, GST on fees ≈ 3 bps,
        #   SEBI charges + brokerage ≈ 15 bps. Total: ~40 bps.
        # slippage_bps=15 covers typical market-impact on liquid NSE equities.
        """
        Simulate trades from signals.  Returns (trade_log, equity_curve_daily).
        equity_curve_daily: pd.Series indexed by date.
        """
        surveillance = self._load_surveillance_symbols()
        if surveillance:
            before = len(signals)
            signals = signals[~signals['symbol'].isin(surveillance)].reset_index(drop=True)
            dropped = before - len(signals)
            if dropped:
                print(f"[Backtester] Filtered {dropped} ASM/GSM signals")

        trade_log: list[dict] = []
        # Position state: symbol -> {entry_date, entry_price, stop_loss, target_price, horizon_days, ...}
        open_positions: dict[str, dict] = {}
        all_dates = sorted(
            pd.to_datetime(list({
                d for df in ohlcv_dict.values() for d in df['date'].tolist()
            }))
        )
        if not all_dates:
            return [], pd.Series(dtype=float)

        # Pre-fetch all dividends for symbols in the backtest to avoid DB queries in the loop
        symbols_list = list(ohlcv_dict.keys())
        dividends_dict = {}  # (symbol, date_str) -> amount
        if symbols_list:
            try:
                chunk_size = 500
                for i in range(0, len(symbols_list), chunk_size):
                    chunk = symbols_list[i:i+chunk_size]
                    placeholders = ",".join(["?"] * len(chunk))
                    q_divs = f"""
                        SELECT symbol, ex_date, amount FROM corporate_actions
                        WHERE symbol IN ({placeholders}) AND action_type = 'DIVIDEND'
                    """
                    rows_div = self.conn.execute(q_divs, chunk).fetchall()
                    for r in rows_div:
                        sym_d, ex_d, amt = r['symbol'], r['ex_date'], float(r['amount'] or 0.0)
                        dividends_dict[(sym_d, ex_d)] = amt
            except Exception as e:
                print(f"[Backtest] Dividend pre-fetch error: {e}")
                try:
                    self.conn.rollback()  # clear aborted-transaction state so save_run() can proceed
                except Exception:
                    pass

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

            # Charge MTF interest on debit cash balance (12% p.a.)
            if cash < 0:
                daily_charge = abs(cash) * (0.12 / 365.0)
                cash -= daily_charge

            # Check dividend payouts for open positions on this day
            date_str = date.strftime('%Y-%m-%d')
            for sym in list(open_positions.keys()):
                pos = open_positions[sym]
                if (sym, date_str) in dividends_dict:
                    div_amt = dividends_dict[(sym, date_str)]
                    payout = div_amt * pos['shares']
                    cash += payout
                    pos['total_cost'] -= payout  # reduce cost basis of trade
                    print(f"  [Dividend] {date_str}: {sym} paid Rs.{div_amt} per share (Total: Rs.{payout:,.2f})")

            # ── check and update open positions day-by-day ──────────────
            for sym in list(open_positions.keys()):
                pos = open_positions[sym]
                days_held = (date - pos['entry_date']).days
                if sym not in ohlcv_dict:
                    continue
                day_ohlcv = ohlcv_dict[sym][ohlcv_dict[sym]['date'] == date]
                if day_ohlcv.empty:
                    continue

                open_price  = float(day_ohlcv['open'].iloc[0])
                high_price  = float(day_ohlcv['high'].iloc[0])
                low_price   = float(day_ohlcv['low'].iloc[0])
                close_price = float(day_ohlcv['close'].iloc[0])

                # Calculate dynamic Chandelier trailing stop (using ATR at entry)
                eff_stop = pos['stop_loss']
                if pos['atr'] and pos['atr'] > 0 and pos['stop_loss'] is not None:
                    # trailing stop is highest-high-since-entry - 3*ATR, bounded by initial stop loss floor
                    eff_stop = max(pos['stop_loss'], pos['highest_high'] - 3.0 * pos['atr'])
                elif pos['atr'] and pos['atr'] > 0:
                    eff_stop = pos['highest_high'] - 3.0 * pos['atr']

                # ── Circuit-lock check: on lower-circuit days the stock is
                #    frozen (open=high=low=close) — cannot exit at SL price.
                #    Defer the SL to the next liquid trading day.
                is_lower_circuit = (
                    abs(open_price - day_ohlcv['high'].iloc[0]) < 0.01
                    and abs(open_price - low_price) < 0.01
                    and float(day_ohlcv['volume'].iloc[0]) == 0
                )

                # 1. Trailing Stop / Stop-Loss check (adverse move first)
                if eff_stop is not None and low_price <= eff_stop and not is_lower_circuit:
                    exit_price = min(open_price, eff_stop) if open_price < eff_stop else eff_stop
                    exit_comm = exit_price * pos['shares'] * commission_bps / 10_000
                    net_proceeds = exit_price * pos['shares'] - exit_comm
                    
                    # P&L combines any partial scale-out proceeds already booked
                    total_proceeds = pos['partial_proceeds'] + net_proceeds
                    pnl = total_proceeds - pos['total_cost']
                    ret_pct = pnl / pos['total_cost'] * 100
                    cash += net_proceeds

                    # Outcome classification matching resolver logic
                    if eff_stop == pos['stop_loss'] and not pos['partial_taken']:
                        outcome = 'STOP_LOSS'
                    else:
                        outcome = 'WIN' if ret_pct > 1.0 else 'LOSS' if ret_pct < -1.0 else 'NEUTRAL'

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
                        'holding_days': days_held,
                        'shares':       pos['initial_shares'],
                        'regime':       pos.get('regime'),
                    })
                    del open_positions[sym]
                    continue

                # 2. Target check / partial profit scale-out (50% target book)
                if pos['target_price'] is not None and not pos['partial_taken'] and high_price >= pos['target_price']:
                    pos['partial_taken'] = True
                    sold_shares = pos['shares'] * 0.5
                    target_proceeds = sold_shares * pos['target_price']
                    target_comm = target_proceeds * commission_bps / 10_000
                    net_target_proceeds = target_proceeds - target_comm
                    
                    cash += net_target_proceeds
                    pos['shares'] -= sold_shares
                    pos['partial_proceeds'] = net_target_proceeds

                # 3. Horizon exit check (exit remaining shares at time close)
                if days_held >= pos['horizon_days']:
                    exit_price = close_price
                    exit_comm = exit_price * pos['shares'] * commission_bps / 10_000
                    net_proceeds = exit_price * pos['shares'] - exit_comm
                    
                    total_proceeds = pos['partial_proceeds'] + net_proceeds
                    pnl = total_proceeds - pos['total_cost']
                    ret_pct = pnl / pos['total_cost'] * 100
                    cash += net_proceeds

                    outcome = 'WIN' if ret_pct > 1.0 else 'LOSS' if ret_pct < -1.0 else 'NEUTRAL'
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
                        'holding_days': days_held,
                        'shares':       pos['initial_shares'],
                        'regime':       pos.get('regime'),
                    })
                    del open_positions[sym]
                    continue

                # 4. Update highest high since entry for trailing stop calculation
                pos['highest_high'] = max(pos['highest_high'], high_price)

            # ── Open new positions from today's signals ───────────────────────
            today_sigs = signals_by_date.get(d, [])
            for row in today_sigs:
                sym = row['symbol']
                if sym in open_positions or len(open_positions) >= max_positions:
                    continue
                if sym not in ohlcv_dict:
                    continue
                # Entry: next trading day's open (look ahead 1 day)
                next_days = ohlcv_dict[sym][ohlcv_dict[sym]['date'] > date].head(1)
                if next_days.empty:
                    continue

                next_row = next_days.iloc[0]
                raw_entry = float(next_row['open'])

                # ── Upper-circuit detection: stock is locked limit-up
                #    (open=high=low=close, or zero volume) — no sellers, skip entry.
                is_upper_circuit = (
                    abs(raw_entry - float(next_row['high'])) < 0.01
                    and abs(raw_entry - float(next_row['low'])) < 0.01
                    and float(next_row.get('volume', 1)) == 0
                )
                if is_upper_circuit:
                    continue

                if pd.isna(raw_entry) or raw_entry <= 0:
                    continue

                # A/B instrumentation (2026-07-18, regime-conditional-gating follow-up): read
                # calibrated_win_probability with a raw fallback, matching the COALESCE pattern
                # already used by scoring_engine.py/unified_ranker._get_win_probabilities — Kelly
                # sizing here was the one place still reading raw win_probability unconditionally.
                _cal = row.get('calibrated_win_probability') if hasattr(row, 'get') else getattr(row, 'calibrated_win_probability', None)
                _raw = row.get('win_probability') if hasattr(row, 'get') else getattr(row, 'win_probability', None)
                win_prob_val = float(_cal) if _cal is not None and pd.notna(_cal) else float(_raw or 0)
                sl_price = float(row['stop_loss']) if pd.notna(row['stop_loss']) else None
                target_p = float(row['target_price']) if pd.notna(row['target_price']) else None
                kelly_f = _kelly_fraction(win_prob_val or None, target_p, raw_entry, sl_price)
                if kelly_f is not None and kelly_f > 0:
                    position_capital = capital * kelly_f
                else:
                    position_capital = initial_capital / max_positions
                position_capital = min(position_capital, cash * 0.95)  # cannot exceed available cash
                if position_capital < 1000:
                    continue
                
                # 1. Estimate shares using raw entry and base slippage first
                est_shares = math.floor(position_capital / (raw_entry * slippage))
                if est_shares < 1:
                    continue
                
                # 2. Apply volume liquidity cap (max 2% participation of the day's volume)
                day_volume = float(next_row.get('volume', 0.0))
                if day_volume > 0:
                    max_allowed_shares = int(day_volume * 0.02)
                    if est_shares > max_allowed_shares:
                        est_shares = max_allowed_shares
                        if est_shares < 1:
                            continue
                
                shares = est_shares
                
                # 3. Compute dynamic slippage based on volume participation (market impact)
                market_participation = 0.0
                if day_volume > 0:
                    market_participation = shares / day_volume
                
                dynamic_slippage_bps = max(slippage_bps, min(150.0, slippage_bps + 30.0 * (market_participation * 100.0)))
                dynamic_slippage = 1.0 + dynamic_slippage_bps / 10_000
                entry_price = raw_entry * dynamic_slippage

                entry_comm = shares * entry_price * commission_bps / 10_000
                total_cost = shares * entry_price + entry_comm
                cash -= total_cost

                sl = float(row['stop_loss']) if pd.notna(row['stop_loss']) else entry_price * (1 - stop_loss_pct / 100)
                tp = float(row['target_price']) if pd.notna(row['target_price']) else None
                atr = self.compute_atr_from_df(ohlcv_dict[sym], date)

                open_positions[sym] = {
                    'entry_date':   date,
                    'entry_price':  entry_price,
                    'stop_loss':    sl,
                    'target_price': tp,
                    'horizon_days': int(row['horizon_days']),
                    'initial_shares': shares,
                    'shares':       shares,
                    'signal_score': int(row['signal_score']),
                    'total_cost':   total_cost,
                    'atr':          atr,
                    'highest_high': entry_price,
                    'partial_taken': False,
                    'partial_proceeds': 0.0,
                    'regime':       row.get('nifty_regime') if hasattr(row, 'get') else getattr(row, 'nifty_regime', None),
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

    def _load_surveillance_symbols(self) -> set:
        """Symbols under NSE surveillance (ASM/GSM) -- many GSM stages (and T2T-segment ASM
        stocks) settle delivery-only, so a signal there doesn't behave like the rest of the
        backtest universe. Was pointed at a table (asm_gsm_stocks) that doesn't exist on this
        database, so this silently returned an empty set on every call -- run() below has been
        filtering nothing for however long that's been the case. nse_stocks.is_asm/gsm_stage
        are the live, actively-synced surveillance flags (same source intraday_ranker.py's
        equivalent filter uses)."""
        try:
            rows = self.conn.execute(
                "SELECT symbol FROM nse_stocks WHERE is_asm=1 OR gsm_stage>0"
            ).fetchall()
            return {r[0] if isinstance(r, (list, tuple)) else r['symbol'] for r in rows}
        except Exception as e:
            print(f"[Backtester] surveillance filter failed, continuing unfiltered: {str(e)[:120]}")
            return set()

    # Search bounds for the IS parameter optimizer. (min_score, stop_loss_pct, horizon_days)
    DEFAULT_WF_BOUNDS = {
        'min_score':     (2, 6),
        'stop_loss_pct': (3.0, 12.0),
        'horizon_days':  (5, 30),
    }
    MIN_TRADES_FOR_VALID_FOLD = 5

    def _wf_fold_bounds(self, start: str, end: str, mode: str, n_folds: int,
                         is_days: int, oos_days: int, step_days: int):
        """Compute (is_start, is_end, oos_start, oos_end) date tuples for each fold."""
        import datetime as _dt
        s = _dt.date.fromisoformat(start)
        e = _dt.date.fromisoformat(end)
        folds = []
        if mode == 'anchored':
            total_days = (e - s).days
            fold_days  = total_days // n_folds
            for i in range(n_folds):
                fold_start = s + _dt.timedelta(days=i * fold_days)
                fold_end   = fold_start + _dt.timedelta(days=fold_days) if i < n_folds - 1 else e
                oos_start  = fold_start + _dt.timedelta(days=int(fold_days * 0.75))
                folds.append((fold_start, oos_start, oos_start, fold_end))
        elif mode == 'rolling':
            is_start = s
            while True:
                is_end    = is_start + _dt.timedelta(days=is_days)
                oos_start = is_end
                oos_end   = oos_start + _dt.timedelta(days=oos_days)
                if oos_end > e:
                    break
                folds.append((is_start, is_end, oos_start, oos_end))
                is_start = is_start + _dt.timedelta(days=step_days)
        else:
            raise ValueError(f"Unknown walk-forward mode: {mode!r} (expected 'anchored' or 'rolling')")
        return folds

    def _wf_objective(self, params, raw_signals: pd.DataFrame, ohlcv_dict: dict,
                       objective: str, max_positions: int, initial_capital: float,
                       commission_bps: float) -> float:
        """DE minimises this — returns negative Sharpe/Sortino on the IS slice only.
        raw_signals/ohlcv_dict are pre-loaded ONCE per fold and reused across every DE
        candidate; only the in-memory score filter and horizon_days column change per
        candidate, so this never re-hits the DB inside the search loop.
        """
        min_score_c, stop_loss_pct_c, horizon_days_c = params
        cand = raw_signals[raw_signals['signal_score'] >= round(min_score_c)].copy()
        if cand.empty:
            return 10.0  # worst score (DE minimises) — no candidate signals
        cand['horizon_days'] = int(round(horizon_days_c))

        trade_log, equity = self.simulate_trades(
            cand, ohlcv_dict,
            max_positions=max_positions,
            initial_capital=initial_capital,
            slippage_bps=15,  # execution cost is not a decision parameter — held fixed
            stop_loss_pct=float(stop_loss_pct_c),
            commission_bps=commission_bps,
        )
        if len(trade_log) < self.MIN_TRADES_FOR_VALID_FOLD or equity.empty:
            return 10.0

        stats = self.compute_stats(trade_log, equity, pd.Series(dtype=float), initial_capital)
        key = 'sortino_ratio' if objective == 'sortino' else 'sharpe_ratio'
        score = stats.get(key)
        if score is None or not np.isfinite(score):
            return 10.0
        return -float(score)

    def run_walk_forward(
        self,
        start: str,
        end: str,
        mode: str = 'rolling',
        n_folds: int = 4,               # only used by mode='anchored'
        is_days: int = 365,             # only used by mode='rolling'
        oos_days: int = 90,
        step_days: int = 90,
        optimize: bool = True,
        objective: str = 'sharpe',      # 'sharpe' | 'sortino'
        param_bounds: dict | None = None,
        min_score: int = 3,
        horizon_days: int = 15,
        stop_loss_pct: float = 7.0,
        max_positions: int = 20,
        initial_capital: float = INITIAL_CAPITAL,
        commission_bps: float = 40,
        slippage_bps: float = 15,
        max_de_iterations: int = 25,
        de_popsize: int = 8,
    ) -> dict:
        """
        Rolling/anchored walk-forward optimization. For each fold: optimize decision
        parameters (min_score, stop_loss_pct, horizon_days) with differential_evolution
        on the IN-SAMPLE slice only, then simulate the OUT-OF-SAMPLE slice once with the
        winning params. The IS optimizer never sees OOS data (separate DB loads per
        window), and OOS results are only ever scored with parameters chosen before that
        window was touched — this is what makes the reported metrics a genuine
        walk-forward result rather than an in-sample fit.
        """
        if optimize:
            try:
                from scipy.optimize import differential_evolution
            except ImportError:
                print("[WalkForward] scipy not installed. Run: pip install scipy")
                raise
        bounds_cfg = {**self.DEFAULT_WF_BOUNDS, **(param_bounds or {})}
        bounds = [bounds_cfg['min_score'], bounds_cfg['stop_loss_pct'], bounds_cfg['horizon_days']]

        folds = self._wf_fold_bounds(start, end, mode, n_folds, is_days, oos_days, step_days)
        if not folds:
            print("[WalkForward] No folds fit in the given date range/window sizes.")
            return {'folds': [], 'combined': {}}

        fold_results = []
        combined_trade_log: list[dict] = []
        combined_equity_parts: list[pd.Series] = []
        running_capital = initial_capital

        for i, (is_start, is_end, oos_start, oos_end) in enumerate(folds):
            fold_no = i + 1
            print(f"\n[WalkForward] Fold {fold_no}/{len(folds)}  "
                  f"IS {is_start}->{is_end}  OOS {oos_start}->{oos_end}")

            best_min_score, best_stop_loss, best_horizon = min_score, stop_loss_pct, horizon_days

            if optimize:
                # Load the loosest candidate universe once; DE filters in-memory per candidate.
                raw_is_signals = self.load_signals(
                    is_start.isoformat(), is_end.isoformat(),
                    min_score=int(bounds[0][0]), horizon_days=horizon_days,
                )
                if raw_is_signals.empty:
                    print("  No IS signals - using default params, skipping optimization.")
                else:
                    is_syms = raw_is_signals['symbol'].unique().tolist()
                    is_ohlcv = self.load_ohlcv(is_syms, is_start.isoformat(), is_end.isoformat())
                    is_ohlcv_dict = {sym: g.reset_index(drop=True) for sym, g in is_ohlcv.groupby('symbol')}

                    result = differential_evolution(
                        self._wf_objective,
                        bounds=bounds,
                        args=(raw_is_signals, is_ohlcv_dict, objective, max_positions,
                              initial_capital, commission_bps),
                        maxiter=max_de_iterations,
                        popsize=de_popsize,
                        seed=42,
                        tol=1e-6,
                        mutation=(0.5, 1.5),
                        recombination=0.7,
                        workers=1,  # DB connection isn't picklable across processes
                    )
                    best_min_score  = int(round(result.x[0]))
                    best_stop_loss  = float(result.x[1])
                    best_horizon    = int(round(result.x[2]))
                    print(f"  IS-optimal: min_score={best_min_score} "
                          f"stop_loss_pct={best_stop_loss:.2f} horizon_days={best_horizon} "
                          f"({objective}={-result.fun:.4f})")

            # ── OOS: simulate once with params chosen from IS only ──────────
            oos_signals = self.load_signals(oos_start.isoformat(), oos_end.isoformat(),
                                             best_min_score, best_horizon)
            if oos_signals.empty:
                print("  No OOS signals - skipping fold.")
                fold_results.append({
                    'fold': fold_no, 'is_start': is_start.isoformat(), 'is_end': is_end.isoformat(),
                    'oos_start': oos_start.isoformat(), 'oos_end': oos_end.isoformat(),
                    'best_params': {'min_score': best_min_score, 'stop_loss_pct': best_stop_loss,
                                     'horizon_days': best_horizon},
                    'oos_stats': {}, 'n_trades': 0,
                })
                continue

            oos_syms = oos_signals['symbol'].unique().tolist()
            extended_oos_end = (pd.to_datetime(oos_end) + pd.Timedelta(days=best_horizon + 10)).strftime('%Y-%m-%d')
            oos_ohlcv = self.load_ohlcv(oos_syms, oos_start.isoformat(), extended_oos_end)
            oos_ohlcv_dict = {sym: g.reset_index(drop=True) for sym, g in oos_ohlcv.groupby('symbol')}

            oos_trades, oos_equity = self.simulate_trades(
                oos_signals, oos_ohlcv_dict,
                max_positions=max_positions,
                initial_capital=running_capital,
                slippage_bps=slippage_bps,
                stop_loss_pct=best_stop_loss,
                commission_bps=commission_bps,
            )
            nifty_oos = self.load_nifty(oos_start.isoformat(), extended_oos_end)
            oos_stats = self.compute_stats(oos_trades, oos_equity, nifty_oos, running_capital)

            fold_results.append({
                'fold': fold_no,
                'is_start': is_start.isoformat(), 'is_end': is_end.isoformat(),
                'oos_start': oos_start.isoformat(), 'oos_end': oos_end.isoformat(),
                'best_params': {'min_score': best_min_score, 'stop_loss_pct': best_stop_loss,
                                 'horizon_days': best_horizon},
                'oos_stats': oos_stats,
                'n_trades': len(oos_trades),
            })
            print(f"  OOS: trades={len(oos_trades)}  "
                  f"win_rate={oos_stats.get('win_rate', 0)*100:.1f}%  "
                  f"sharpe={oos_stats.get('sharpe_ratio', 0):.2f}")

            combined_trade_log.extend(oos_trades)
            if not oos_equity.empty:
                combined_equity_parts.append(oos_equity)
                running_capital = float(oos_equity.iloc[-1])

        combined_equity = pd.concat(combined_equity_parts) if combined_equity_parts else pd.Series(dtype=float)
        combined_equity = combined_equity[~combined_equity.index.duplicated(keep='last')].sort_index()
        nifty_full = self.load_nifty(start, end)
        combined_stats = self.compute_stats(combined_trade_log, combined_equity, nifty_full, initial_capital) \
            if combined_trade_log else {}

        return {
            'mode': mode, 'objective': objective, 'folds': fold_results,
            'combined': combined_stats,
            'combined_trade_log': combined_trade_log,
            'combined_equity': combined_equity,
        }

    def run_walk_forward_and_save(
        self,
        start: str, end: str,
        mode: str = 'rolling',
        n_folds: int = 4,
        is_days: int = 365,
        oos_days: int = 90,
        step_days: int = 90,
        optimize: bool = True,
        objective: str = 'sharpe',
        min_score: int = 3,
        horizon_days: int = 15,
        stop_loss_pct: float = 7.0,
        max_positions: int = 20,
        initial_capital: float = INITIAL_CAPITAL,
        commission_bps: float = 40,
        slippage_bps: float = 15,
        run_name: str = "",
    ) -> dict:
        wf = self.run_walk_forward(
            start, end, mode=mode, n_folds=n_folds, is_days=is_days, oos_days=oos_days,
            step_days=step_days, optimize=optimize, objective=objective,
            min_score=min_score, horizon_days=horizon_days, stop_loss_pct=stop_loss_pct,
            max_positions=max_positions, initial_capital=initial_capital,
            commission_bps=commission_bps, slippage_bps=slippage_bps,
        )
        if not wf['folds'] or not wf['combined']:
            print("[WalkForward] No valid folds produced a combined result - nothing saved.")
            return wf

        symbols_count = len({t['symbol'] for t in wf['combined_trade_log']})
        config = {
            'start': start, 'end': end, 'mode': mode, 'objective': objective,
            'n_folds': n_folds, 'is_days': is_days, 'oos_days': oos_days, 'step_days': step_days,
            'optimize': optimize, 'symbols_count': symbols_count,
            'initial_capital': initial_capital,
            'commission_bps': commission_bps, 'slippage_bps': slippage_bps,
        }
        run_id = self.save_run(
            run_name or f"wf_{mode}_{start}_{end}_{objective}",
            config, wf['combined'], wf['combined_trade_log'], wf['combined_equity'],
            walk_forward_folds=wf['folds'],
        )
        return {'run_id': run_id, **wf}

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
            'total_return_pct':  round(float(total_ret), 4),
            'cagr_pct':          round(float(cagr), 4),
            'sharpe_ratio':      round(float(sharpe), 4),
            'sortino_ratio':     round(float(sortino), 4),
            'calmar_ratio':      round(float(calmar), 4),
            'max_drawdown_pct':  round(float(max_dd), 4),
            'profit_factor':     round(float(profit_factor), 4),
            'avg_return_pct':    round(float(rets.mean()), 4),
            'avg_holding_days':  round(float(avg_hold), 2),
            'nifty_return_pct':  round(float(nifty_ret), 4),
            'alpha_pct':         round(float(alpha), 4),
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
        walk_forward_folds: list[dict] | None = None,
    ) -> int:
        cur = self.conn.cursor()
        # Trim equity curve to 1 point per week to keep JSON small
        ec_weekly  = equity_curve.resample('W').last()
        ec_json    = json.dumps({str(d.date()): float(v) for d, v in ec_weekly.items()})
        # Trim trade log to last 500 trades
        tl_json = json.dumps(trade_log[-500:])
        wf_json = json.dumps(walk_forward_folds) if walk_forward_folds is not None else None

        cur.execute("""
            INSERT INTO backtesting_runs
                (run_name, strategy_config_json, start_date, end_date,
                 symbols_count, total_trades, win_rate, total_return_pct,
                 cagr_pct, sharpe_ratio, calmar_ratio, sortino_ratio,
                 max_drawdown_pct, nifty_return_pct, alpha_pct,
                 avg_trade_return_pct, profit_factor, avg_holding_days,
                 monthly_returns_json, equity_curve_json, trade_log_json,
                 walk_forward_folds_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            RETURNING id
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
            wf_json,
        ))
        run_id = cur.fetchone()[0]
        self.conn.commit()
        print(f"[Backtester] Saved run id={run_id} to backtesting_runs.")
        return run_id

    # ──────────────────────────────────────────────────────────────────────────
    # Main
    # ──────────────────────────────────────────────────────────────────────────

    def run(
        self,
        start: str,
        end: str,
        horizon_days: int = 15,
        min_score: int = 3,
        max_positions: int = 20,
        initial_capital: float = INITIAL_CAPITAL,
        run_name: str = "",
        slippage_bps: float = 15,
        stop_loss_pct: float = 7.0,
        commission_bps: float = 40,
    ) -> dict:
        print(f"[Backtester] {start} -> {end}  horizon={horizon_days}d  min_score={min_score}")

        signals = self.load_signals(start, end, min_score, horizon_days)
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
            print("[Backtester] No OHLCV data - cannot simulate.")
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
            commission_bps=commission_bps,
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
            'commission_bps': commission_bps,
        }

        print(f"\n{'='*60}")
        print(f" BACKTEST RESULTS  {start} -> {end}")
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

class BacktestRequest(BaseModel):
    start: str
    end: str
    horizon: int = 15
    min_score: int = 3
    max_pos: int = 20
    capital: float = INITIAL_CAPITAL
    slippage: float = 15
    stop_loss_pct: float = 7.0
    commission: float = 40
    name: str = ""

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
            stop_loss_pct=req.stop_loss_pct,
            commission_bps=req.commission,
        )
    finally:
        bt.close()


class WalkForwardRequest(BaseModel):
    start: str
    end: str
    mode: str = 'rolling'          # 'rolling' | 'anchored'
    n_folds: int = 4               # anchored mode only
    is_days: int = 365             # rolling mode only
    oos_days: int = 90
    step_days: int = 90
    optimize: bool = True
    objective: str = 'sharpe'      # 'sharpe' | 'sortino'
    min_score: int = 3
    horizon: int = 15
    stop_loss_pct: float = 7.0
    max_pos: int = 20
    capital: float = INITIAL_CAPITAL
    slippage: float = 15
    commission: float = 40
    name: str = ""

def run_walk_forward_optimize(req: WalkForwardRequest):
    bt = Backtester()
    try:
        return bt.run_walk_forward_and_save(
            start=req.start,
            end=req.end,
            mode=req.mode,
            n_folds=req.n_folds,
            is_days=req.is_days,
            oos_days=req.oos_days,
            step_days=req.step_days,
            optimize=req.optimize,
            objective=req.objective,
            min_score=req.min_score,
            horizon_days=req.horizon,
            stop_loss_pct=req.stop_loss_pct,
            max_positions=req.max_pos,
            initial_capital=req.capital,
            slippage_bps=req.slippage,
            commission_bps=req.commission,
            run_name=req.name,
        )
    finally:
        bt.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Historical Backtesting Engine")
    parser.add_argument("--start",    type=str, default="2023-01-01")
    parser.add_argument("--end",      type=str, default=datetime.date.today().isoformat())
    parser.add_argument("--horizon",  type=int, default=15)
    parser.add_argument("--min-score", type=int, default=3)
    parser.add_argument("--max-pos",  type=int, default=20)
    parser.add_argument("--capital",  type=float, default=INITIAL_CAPITAL)
    parser.add_argument("--slippage", type=float, default=15, help="Slippage in bps (default 15 = ~NSE market impact)")
    parser.add_argument("--commission", type=float, default=40, help="Round-trip commission in bps (default 40 = STT+stamp+GST+brokerage)")
    parser.add_argument("--name",     type=str, default="")
    parser.add_argument('--walk-forward', action='store_true')
    parser.add_argument('--optimize', action='store_true', help="Re-optimize params on each fold's IS window (default off = plain walk-forward evaluation with fixed params)")
    parser.add_argument('--wf-mode', type=str, default='rolling', choices=['rolling', 'anchored'])
    parser.add_argument('--folds', type=int, default=4, help="anchored mode only")
    parser.add_argument('--is-days', type=int, default=365, help="rolling mode only")
    parser.add_argument('--oos-days', type=int, default=90)
    parser.add_argument('--step-days', type=int, default=90)
    parser.add_argument('--wf-objective', type=str, default='sharpe', choices=['sharpe', 'sortino'])
    args = parser.parse_args()

    bt = Backtester()
    try:
        if args.walk_forward:
            result = bt.run_walk_forward_and_save(
                args.start, args.end,
                mode=args.wf_mode,
                n_folds=args.folds,
                is_days=args.is_days,
                oos_days=args.oos_days,
                step_days=args.step_days,
                optimize=args.optimize,
                objective=args.wf_objective,
                min_score=args.min_score,
                horizon_days=args.horizon,
                stop_loss_pct=7.0,
                initial_capital=args.capital,
                commission_bps=args.commission,
                slippage_bps=args.slippage,
            )
            print(f"\nWalk-forward complete: {len(result.get('folds', []))} folds, "
                  f"combined sharpe={result.get('combined', {}).get('sharpe_ratio', 'n/a')}")
        else:
            bt.run(
                start=args.start,
                end=args.end,
                horizon_days=args.horizon,
                min_score=args.min_score,
                max_positions=args.max_pos,
                initial_capital=args.capital,
                run_name=args.name,
                slippage_bps=args.slippage,
                commission_bps=args.commission,
            )
    finally:
        bt.close()
