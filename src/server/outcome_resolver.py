"""
Outcome Resolver
================
Auto-labels technical_signals rows in signal_outcomes using stock_ohlcv.
Detects STOP_LOSS when intraday low crosses below stop_loss before horizon exit.

Run:  python outcome_resolver.py
      python outcome_resolver.py --horizon 5
      python outcome_resolver.py --dry-run
"""

import datetime, argparse, math, re

from db_compat import connect, ConnWrapper, query_all, query_one


def parse_horizon(time_horizon_str, default_days: int) -> int:
    """Parse '5 days', '15 days', 'intraday' etc. to integer days."""
    if not time_horizon_str:
        return default_days
    s = str(time_horizon_str).lower().strip()
    if 'intraday' in s or s == '1 day':
        return 1
    m = re.search(r'(\d+)', s)
    if m:
        return max(1, min(30, int(m.group(1))))
    return default_days

WIN_THRESHOLD  =  1.0   # Fallback thresholds
LOSS_THRESHOLD = -1.0

# Round-trip transaction cost (entry + exit), as a % of notional, for Indian delivery
# equity: STT ~0.2% + exchange/SEBI/stamp/GST ~0.05% + slippage ~0.05% ≈ 0.30%. A signal
# is only "right" if it clears costs — win rates measured gross silently mint break-even
# trades as wins, which then mis-train the learned signal weights. Mirrors backtester.py
# (25 bps commission + 10 bps slippage round trip).
ROUND_TRIP_COST_PCT = 0.30

# Data-error guard. A >100% move over a <=15-day horizon is a phantom, not a trade:
# an unadjusted corporate action or a sustained wrong-level series in the source feed
# that the single-bar is_suspect spike-guard can't catch (it only flags a bar that
# deviates from BOTH neighbours). A few dozen of these (max observed +26325%) dragged
# the learned per-source outcome averages from ~0% to +188%, poisoning reward_engine
# and strategy_optimizer weighting. The real distribution's p95 is under 8%, so this
# bound only ever trips on unambiguous data errors.
MAX_PLAUSIBLE_RETURN_PCT = 100.0


def is_plausible_return(return_pct: float | None) -> bool:
    """False for outcome returns that can only be a data error, never a real trade."""
    return return_pct is not None and abs(return_pct) <= MAX_PLAUSIBLE_RETURN_PCT


def _fetch_atr_pct(conn: ConnWrapper, symbol: str, as_of_date, window: int = 14) -> float:
    """Return ATR(14) as % of closing price on `as_of_date`, or 2.0 if unavailable."""
    if isinstance(as_of_date, str):
        as_of_d = datetime.date.fromisoformat(as_of_date[:10])
    else:
        as_of_d = as_of_date
    raw = conn.execute(
        "SELECT high, low, close FROM stock_ohlcv WHERE symbol=? AND date<=? ORDER BY date DESC LIMIT ?",
        (symbol, as_of_d, window + 1),
    ).fetchall()
    if len(raw) < window + 1:
        return 2.0
    bars = list(reversed(raw))
    trs = []
    for i in range(1, len(bars)):
        h, l, prev_c = float(bars[i][0]), float(bars[i][1]), float(bars[i-1][2])
        trs.append(max(h - l, abs(h - prev_c), abs(l - prev_c)))
    atr = sum(trs) / len(trs)
    last_close = float(bars[-1][2])
    return (atr / last_close * 100) if last_close > 0 else 2.0


def _dynamic_thresholds(atr_pct: float) -> tuple[float, float]:
    """Win = +0.5×ATR (min 1%), Loss = -0.5×ATR (min -1%)."""
    half = max(1.0, 0.5 * atr_pct)
    return half, -half


def net_return_pct(gross_return_pct: float, cost_pct: float = ROUND_TRIP_COST_PCT) -> float:
    """Gross % return minus round-trip transaction costs — what the strategy actually keeps."""
    return gross_return_pct - cost_pct


# ── Exit policy (#2) ────────────────────────────────────────────────────────────
# The old resolver exited every trade at the horizon CLOSE: a name that ran to +8% on
# day 2 and faded to +1% booked +1%. A disciplined desk books a partial at the target and
# trails the rest with a chandelier stop so winners run but gains are locked. simulate_exit
# replays the daily bars and applies that policy (long-only — matches the resolver's math).
SCALE_OUT_FRAC = 0.5        # book half the position at the target, trail the rest
CHANDELIER_ATR_MULT = 3.0   # trailing stop = highest-high-since-entry − 3×ATR


def simulate_exit(bars, entry, initial_stop, target, atr,
                  scale_frac: float = SCALE_OUT_FRAC,
                  chandelier_mult: float = CHANDELIER_ATR_MULT):
    """Bar-by-bar long-trade exit simulation over the holding window.

    `bars`: list of (date, high, low, close) ascending, position already open at `entry`.
    Returns (exit_date, exit_price, exit_reason, gross_return_pct) where the return blends
    a `scale_frac` partial booked at `target` with the remainder's exit. Net-of-cost is the
    caller's job. Policy:
      - Hard `initial_stop` always applies. Once price advances, a chandelier trailing stop
        (highest_high − mult×ATR) ratchets the stop up — never below the initial stop, and
        computed from bars *before* the current one (no intra-bar look-ahead).
      - First bar whose high ≥ `target` books `scale_frac` at the target; the rest trails.
      - Stop is tested before target within a bar (conservative: assume the adverse move
        first). `atr` ≤ 0 or `initial_stop` None disables the respective leg gracefully.
      - If nothing exits the remainder by the last bar, it exits at the last close (time).
    """
    if not bars:
        return None, None, 'PENDING', None

    highest = entry
    partial_taken = False
    partial_return = 0.0
    has_target = target is not None and target > entry

    for d, high, low, close in bars:
        # Effective stop for THIS bar uses only prior bars' highs (no look-ahead).
        eff_stop = initial_stop
        if atr and atr > 0 and initial_stop is not None:
            eff_stop = max(initial_stop, highest - chandelier_mult * atr)
        elif atr and atr > 0:
            eff_stop = highest - chandelier_mult * atr

        if eff_stop is not None and low <= eff_stop:
            reason = 'STOP_LOSS' if (initial_stop is not None and eff_stop == initial_stop) else 'TRAILING_STOP'
            leg = (eff_stop - entry) / entry * 100
            gross = scale_frac * partial_return + (1 - scale_frac) * leg if partial_taken else leg
            return d, eff_stop, reason, gross

        if has_target and not partial_taken and high >= target:
            partial_taken = True
            partial_return = (target - entry) / entry * 100

        highest = max(highest, high)

    last_d, _, _, last_close = bars[-1]
    leg = (last_close - entry) / entry * 100
    if partial_taken:
        return last_d, last_close, 'TIME_EXIT_PARTIAL', scale_frac * partial_return + (1 - scale_frac) * leg
    return last_d, last_close, 'TIME_EXIT', leg


def get_atr(conn: ConnWrapper, symbol: str, signal_date: str, window: int = 14) -> float:
    """Average True Range (absolute price units) from the `window`+1 bars up to signal_date.
    Drives the chandelier trailing stop; 0.0 (trailing disabled) when history is too short."""
    rows = conn.execute("""
        SELECT high, low, close FROM stock_ohlcv
        WHERE symbol = ? AND date <= ? AND COALESCE(is_suspect, 0) = 0
        ORDER BY date DESC LIMIT ?
    """, (symbol, signal_date, window + 1)).fetchall()
    if len(rows) < 2:
        return 0.0
    rows = rows[::-1]
    prev_close = float(rows[0][2])
    trs = []
    for h, l, c in rows[1:]:
        h, l, c = float(h), float(l), float(c)
        trs.append(max(h - l, abs(h - prev_close), abs(l - prev_close)))
        prev_close = c
    return sum(trs) / len(trs) if trs else 0.0


_SPLIT_RETURN_PCT = 25.0  # daily returns beyond ±25% are almost certainly stock splits/bonuses


def _clean_daily_returns(prices: list[float]) -> list[float]:
    """Compute daily % returns from a chronological price list, excluding split/bonus days.
    A split day shows as a ±25%+ move on unadjusted prices; including it inflates the
    volatility estimate, biasing the UP/DOWN outcome threshold upward."""
    rets = []
    for i in range(1, len(prices)):
        if prices[i - 1] <= 0:
            continue
        r = (prices[i] - prices[i - 1]) / prices[i - 1] * 100
        if abs(r) < _SPLIT_RETURN_PCT:
            rets.append(r)
    return rets


def get_volatility_threshold(conn: ConnWrapper, symbol: str, signal_date: str, horizon_days: int) -> float:
    """
    Calculates a dynamic threshold based on the stock's rolling daily standard deviation.
    Uses 20 trading days prior to signal_date. Scales threshold by sqrt(horizon_days).
    Split/bonus days (|return| > 25%) are excluded to avoid biasing the estimate.
    """
    rows = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol = ? AND date <= ? AND COALESCE(is_suspect, 0) = 0
        ORDER BY date DESC LIMIT 21
    """, (symbol, signal_date)).fetchall()

    if len(rows) < 10:
        # Fallback if insufficient history: 1.0% per day scaled by sqrt(time)
        return max(0.5, min(10.0, 1.0 * math.sqrt(horizon_days)))

    prices = [float(r[0]) for r in rows][::-1]
    returns = _clean_daily_returns(prices)

    if len(returns) < 5:
        return max(0.5, min(10.0, 1.0 * math.sqrt(horizon_days)))

    mean_ret = sum(returns) / len(returns)
    variance = sum((r - mean_ret) ** 2 for r in returns) / (len(returns) - 1)
    daily_vol = math.sqrt(variance) * 100

    # 1.0 Standard deviation move over the holding horizon
    threshold = daily_vol * math.sqrt(horizon_days)

    # Clamp between 0.5% and 15.0% to prevent extreme values
    return max(0.5, min(15.0, threshold))


def resolve_outcomes(
    conn: ConnWrapper,
    horizon_days: int = 1,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    PHASE 1 FIX: Resolve signal outcomes with proper time-of-day validation
    - Signals entered at next trading day's open
    - SL checked on intraday (low) before target (high)
    - Horizon exit checked at close on exit_date
    """
    today     = datetime.date.today()
    # Use a wider cutoff (30 days) to catch signals of any horizon
    cutoff    = (today - datetime.timedelta(days=horizon_days)).isoformat()

    # Signals old enough that horizon has passed, not yet resolved at THIS horizon.
    # Scoped to horizon_days so each horizon is selected independently — without this
    # the h1 pass would exclude signals from h5/h15 passes (starvation bug).
    # signal_source='technical' scoped explicitly (2026-08): the dedup guard used to match on
    # ANY row for (symbol, signal_date, horizon_days) regardless of who wrote it, so this
    # resolver would silently skip a horizon confluence_outcome_tracker.py had already claimed
    # (and vice versa) — see the signal_outcomes.signal_source migration for the full mechanism.
    pending = conn.execute("""
        SELECT ts.symbol, ts.date AS signal_date, ts.cmp AS entry_price,
               ts.signal_score, ts.signals_json,
               CAST(ts.stop_loss AS REAL) AS stop_loss,
               ts.time_horizon
         FROM technical_signals ts
         WHERE ts.date <= ?
           AND NOT EXISTS (
               SELECT 1 FROM signal_outcomes so2
               WHERE so2.symbol = ts.symbol
                 AND so2.signal_date = ts.date
                 AND so2.horizon_days = ?
                 AND so2.signal_source = 'technical'
                 AND so2.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
           )
         ORDER BY ts.date DESC
         LIMIT 2000
    """, (cutoff, horizon_days)).fetchall()

    cols = ['symbol', 'signal_date', 'entry_price', 'signal_score', 'signals_json', 'stop_loss', 'time_horizon']
    rows = [dict(zip(cols, r)) for r in pending]

    if not rows:
        print(f"[OutcomeResolver] No pending signals to resolve (horizon={horizon_days}d).")
        return {'processed': 0, 'resolved': 0}

    print(f"[OutcomeResolver] {len(rows)} signals pending resolution (phase1-fix).")
    resolved = 0

    upsert = """
        INSERT INTO signal_outcomes
            (symbol, signal_date, horizon_days, entry_price,
             check_date, exit_price, return_pct, outcome,
             signal_score, signals_json, computed_at,
             signal_source, label_definition)
        VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,'technical','path_barrier')
        ON CONFLICT(symbol, signal_date, horizon_days, signal_source) DO UPDATE SET
            check_date=excluded.check_date, exit_price=excluded.exit_price,
            return_pct=excluded.return_pct, outcome=excluded.outcome,
            computed_at=excluded.computed_at, label_definition=excluded.label_definition
    """

    for row in rows:
        sym          = row['symbol']
        signal_date  = row['signal_date']
        entry        = float(row['entry_price'] or 0)
        stop_loss    = row['stop_loss']
        sig_horizon  = parse_horizon(row.get('time_horizon'), horizon_days)

        # Skip if already resolved at this specific horizon (technical source only — see the
        # outer query's NOT EXISTS comment above for why signal_source is part of this check)
        if conn.execute(
            "SELECT 1 FROM signal_outcomes WHERE symbol=? AND signal_date=? AND horizon_days=? "
            "AND signal_source='technical' AND outcome != 'PENDING' LIMIT 1",
            (sym, signal_date, sig_horizon)
        ).fetchone():
            continue

        # PHASE 1 FIX: Entry at next trading day's open (also handles NULL cmp —
        # the next-day open overrides the original entry, so skip the null-entry
        # guard until AFTER we've attempted to get it from OHLCV).
        signal_date_obj = datetime.date.fromisoformat(signal_date)

        # Get actual next trading day and its open price from DB
        next_trading_day_row = conn.execute("""
            SELECT date, open FROM stock_ohlcv
            WHERE symbol = ? AND date > ? AND COALESCE(is_suspect, 0) = 0
            ORDER BY date ASC LIMIT 1
        """, (sym, signal_date)).fetchone()

        if next_trading_day_row:
            next_trading_day = next_trading_day_row[0]
            # Override original entry (or fill in if cmp was NULL) with next-day open
            entry = float(next_trading_day_row[1])
        else:
            next_trading_day = (signal_date_obj + datetime.timedelta(days=1)).isoformat()

        if not entry:
            continue

        exit_target_date = (signal_date_obj + datetime.timedelta(days=sig_horizon)).isoformat()

        outcome      = None
        exit_price   = None
        check_date   = None
        return_pct   = None

        # PHASE 1 FIX: Check SL on next trading day first (it has priority in intraday)
        if stop_loss and stop_loss > 0:
            sl_hit = conn.execute("""
                SELECT date, low, open FROM stock_ohlcv
                WHERE symbol = ? AND date >= ? AND date <= ?
                  AND low <= ? AND COALESCE(is_suspect, 0) = 0
                ORDER BY date ASC LIMIT 1
            """, (sym, next_trading_day, exit_target_date, stop_loss)).fetchone()

            if sl_hit:
                check_date = str(sl_hit[0])
                day_open   = float(sl_hit[2]) if sl_hit[2] else None
                # Gap-fill: if the day opened below the stop, we fill at open
                # (can't fill at stop on a gap-down). Otherwise fill at stop.
                if day_open and day_open < stop_loss:
                    exit_price = day_open
                else:
                    exit_price = float(stop_loss)
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                outcome    = 'STOP_LOSS'

        # If SL not hit, check exit at horizon date (using close price)
        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ? AND COALESCE(is_suspect, 0) = 0
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target_date)).fetchone()

            if exit_row:
                check_date = str(exit_row[0])
                exit_price = float(exit_row[1])
                return_pct = net_return_pct((exit_price - entry) / entry * 100)
                
                # Dynamic volatility-adjusted threshold
                threshold = get_volatility_threshold(conn, sym, signal_date, sig_horizon)
                outcome    = ('WIN'  if return_pct > threshold  else
                              'LOSS' if return_pct < -threshold else
                              'NEUTRAL')
            else:
                outcome    = 'PENDING'
                return_pct = None

        if dry_run:
            msg = f"  [DRY] {sym} {signal_date} h={sig_horizon}d (entry:{next_trading_day}) -> {outcome}"
            if return_pct is not None:
                msg += f" ({return_pct:.2f}%)"
            print(msg)
            continue

        conn.execute(upsert, (
            sym, signal_date, sig_horizon, entry,
            check_date, exit_price,
            round(return_pct, 4) if return_pct is not None else None,
            outcome,
            row['signal_score'], row['signals_json'],
        ))
        if outcome != 'PENDING':
            resolved += 1

    if not dry_run:
        conn.commit()

    print(f"[OutcomeResolver] Resolved {resolved}/{len(rows)} signals.")
    return {'processed': len(rows), 'resolved': resolved}


def resolve_unified_outcomes(
    conn: ConnWrapper,
    horizon_days: int = 1,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    Resolve outcomes for all signal sources (AI, Quant, Technical) from unified_signals.
    """
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=horizon_days)).isoformat()

    # NOTE: the dedup intentionally excludes only rows already RESOLVED at this horizon.
    # Rows previously written as PENDING (horizon not yet elapsed / OHLCV missing at the
    # time) MUST be re-selected so they get resolved once data is available. The previous
    # version matched any existing row regardless of outcome, which permanently stranded
    # PENDING signals (root cause of ~86% of AI signals never resolving).
    # Do NOT filter on status='COMPLETED': the per-horizon NOT EXISTS below is the correct
    # guard. Filtering on status caused h1 to mark signals COMPLETED, starving h5/h15 passes.
    pending = conn.execute("""
        SELECT us.id, us.symbol, us.signal_date, us.entry_price, us.stop_loss, us.signal_source,
               us.confidence_score, us.target_price
        FROM unified_signals us
        WHERE us.signal_date <= ?
          AND NOT EXISTS (
              SELECT 1 FROM unified_signal_outcomes uso
              WHERE uso.unified_signal_id = us.id
                AND uso.horizon_days = ?
                AND uso.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          )
        ORDER BY us.signal_date DESC
        LIMIT 2000
    """, (cutoff, horizon_days)).fetchall()

    cols = ['id', 'symbol', 'signal_date', 'entry_price', 'stop_loss', 'signal_source',
            'confidence_score', 'target_price']
    rows = [dict(zip(cols, r)) for r in pending]

    if not rows:
        print(f"[OutcomeResolver] No pending unified signals to resolve (horizon={horizon_days}d).")
        return {'processed': 0, 'resolved': 0}

    print(f"[OutcomeResolver] {len(rows)} unified signals pending resolution.")
    resolved = 0

    upsert = """
        INSERT INTO unified_signal_outcomes
            (unified_signal_id, signal_source, symbol, signal_date, horizon_days,
             entry_price, entry_time, check_date, exit_price, outcome, return_pct,
             exit_reason, computed_at)
        VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(unified_signal_id, horizon_days) DO UPDATE SET
            entry_price=excluded.entry_price,
            check_date=excluded.check_date, exit_price=excluded.exit_price,
            outcome=excluded.outcome, return_pct=excluded.return_pct,
            exit_reason=excluded.exit_reason, computed_at=excluded.computed_at
    """

    for row in rows:
        uid = row['id']
        sym = row['symbol']
        signal_date = str(row['signal_date'])
        entry = float(row['entry_price'] or 0)
        stop_loss = float(row['stop_loss']) if row['stop_loss'] else None
        source = row['signal_source']

        if not entry:
            continue

        signal_date_obj = datetime.date.fromisoformat(signal_date[:10])
        next_trading_day_row = conn.execute("""
            SELECT date, open FROM stock_ohlcv
            WHERE symbol = ? AND date > ? AND COALESCE(is_suspect, 0) = 0
            ORDER BY date ASC LIMIT 1
        """, (sym, signal_date[:10])).fetchone()
        
        if next_trading_day_row:
            next_trading_day = next_trading_day_row[0]
            # Override original entry with the realistic next-day open price
            entry = float(next_trading_day_row[1])
        else:
            next_trading_day = (signal_date_obj + datetime.timedelta(days=1)).isoformat()
            
        exit_target_date = (signal_date_obj + datetime.timedelta(days=horizon_days)).isoformat()

        # #2 exit policy: replay daily bars through target-capture / scale-out / chandelier
        # trailing / time exit instead of just booking the horizon close.
        target = float(row['target_price']) if row.get('target_price') else None
        atr = get_atr(conn, sym, signal_date[:10])
        bar_rows = conn.execute("""
            SELECT date, high, low, close FROM stock_ohlcv
            WHERE symbol = ? AND date >= ? AND date <= ? AND COALESCE(is_suspect, 0) = 0
            ORDER BY date ASC
        """, (sym, next_trading_day, exit_target_date)).fetchall()
        bars = [(str(b[0]), float(b[1]), float(b[2]), float(b[3])) for b in bar_rows]

        # Check if we can use intraday bars for path resolution.
        # NOTE: uses query_all() (its own isolated connection), not the shared `conn` — this
        # function commits once at the end of the whole row loop, so if this ran on `conn` a
        # failure here would (a) on Postgres, abort the shared transaction and poison every
        # later query on `conn` for the rest of the loop (this exact bug hit production:
        # InFailedSqlTransaction downstream in get_volatility_threshold for an unrelated
        # symbol), and (b) a bare conn.rollback() to recover would discard every already-
        # processed row's uncommitted UPSERT from earlier in this same loop.
        use_intra = False
        if next_trading_day and exit_target_date:
            try:
                start_d = datetime.date.fromisoformat(next_trading_day)
                end_d = datetime.date.fromisoformat(exit_target_date)
                _IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                session_start = datetime.datetime(start_d.year, start_d.month, start_d.day, 9, 15, tzinfo=_IST).isoformat()
                session_end   = datetime.datetime(end_d.year, end_d.month, end_d.day, 15, 30, tzinfo=_IST).isoformat()

                intra_rows = query_all("""
                    SELECT datetime, high, low, close FROM intraday_ohlcv
                    WHERE symbol = ? AND datetime >= ? AND datetime <= ? AND interval = '15m'
                    ORDER BY datetime ASC
                """, (sym, session_start, session_end))
                if len(intra_rows) >= 5:
                    bars = [(str(b[0]), float(b[1]), float(b[2]), float(b[3])) for b in intra_rows]
                    use_intra = True
            except Exception:
                pass

        # Query total dividend paid during holding period (isolated connection — see above).
        dividend_sum = 0.0
        if next_trading_day and exit_target_date:
            try:
                div_row = query_one("""
                    SELECT COALESCE(SUM(amount), 0.0) FROM corporate_actions
                    WHERE symbol = ? AND action_type = 'DIVIDEND'
                      AND ex_date >= ? AND ex_date <= ?
                """, (sym, next_trading_day, exit_target_date))
                if div_row:
                    dividend_sum = float(div_row[0])
            except Exception:
                pass

        outcome, exit_price, check_date, return_pct, exit_reason = None, None, None, None, None

        if not bars:
            outcome = 'PENDING'
        else:
            initial_stop = stop_loss if (stop_loss and stop_loss > 0) else None
            check_date, exit_price, exit_reason, gross = simulate_exit(
                bars, entry=entry, initial_stop=initial_stop, target=target, atr=atr)
            
            # Incorporate dividend returns if any paid during the trade
            if dividend_sum > 0:
                dividend_pct = (dividend_sum / entry) * 100
                gross += dividend_pct
                
            return_pct = net_return_pct(gross)
            if not is_plausible_return(return_pct):
                # Phantom move from a bad/unadjusted bar — neither a win nor a loss, and
                # the return itself is untrustworthy, so null it so it can't skew the
                # per-source averages reward_engine/strategy_optimizer learn from.
                outcome, exit_reason, return_pct = 'NEUTRAL', 'SUSPECT_DATA', None
            elif exit_reason == 'STOP_LOSS':
                outcome = 'STOP_LOSS'
            else:
                threshold = get_volatility_threshold(conn, sym, signal_date, horizon_days)
                outcome = ('WIN' if return_pct > threshold else
                           'LOSS' if return_pct < -threshold else
                           'NEUTRAL')

        if dry_run:
            msg = f"  [DRY] UNIFIED {sym} {signal_date} (entry:{next_trading_day}) -> {outcome}"
            if return_pct is not None: msg += f" ({return_pct:.2f}% via {exit_reason})"
            print(msg)
            continue

        conn.execute(upsert, (
            uid, source, sym, signal_date, horizon_days, entry,
            check_date, exit_price, outcome,
            round(return_pct, 4) if return_pct is not None else None,
            exit_reason,
        ))
        
        if outcome != 'PENDING':
            resolved += 1

    if not dry_run:
        conn.commit()

    print(f"[OutcomeResolver] Resolved {resolved}/{len(rows)} unified signals.")
    return {'processed': len(rows), 'resolved': resolved}


def resolve_dl_predictions(conn: ConnWrapper, dry_run: bool = False) -> dict[str, int]:
    """
    Grade deep_learning_predictions whose horizon has elapsed.
    Fills actual_ret_5d / actual_ret_15d and outcome_5d / outcome_15d ('UP'|'DOWN'|'FLAT')
    using realistic next-trading-day entry and horizon-close exit from stock_ohlcv.
    Nothing graded these before, so all rows sat NULL forever.
    """
    today = datetime.date.today()

    def _symbol_vol_threshold(sym: str, as_of: str) -> float:
        """Return a vol-scaled UP/DOWN threshold for a stock.
        Uses 20-day RMS of daily returns; split/bonus days excluded (|ret| > 25%);
        result capped between 0.3% and 2.0%."""
        rows = conn.execute(
            "SELECT close FROM stock_ohlcv WHERE symbol=? AND date <= ? "
            "AND COALESCE(is_suspect,0)=0 ORDER BY date DESC LIMIT 21",
            (sym, as_of),
        ).fetchall()
        closes = [float(r[0]) for r in rows if r[0]]
        if len(closes) < 5:
            return 0.5  # fallback
        # Reverse to chronological order for _clean_daily_returns
        daily_rets = _clean_daily_returns(list(reversed(closes)))
        if not daily_rets:
            return 0.5
        rms = (sum(r ** 2 for r in daily_rets) / len(daily_rets)) ** 0.5
        return max(0.3, min(2.0, rms * 0.5))

    # Precompute per-symbol vol thresholds to avoid one query per prediction row
    _vol_cache: dict[str, float] = {}

    def grade_for(col_ret: str, col_out: str, horizon: int) -> int:
        cutoff = (today - datetime.timedelta(days=horizon)).isoformat()
        pending = conn.execute(f"""
            SELECT id, symbol, prediction_date
            FROM deep_learning_predictions
            WHERE {col_out} IS NULL
              AND substr(prediction_date, 1, 10) <= ?
            ORDER BY prediction_date DESC
            LIMIT 5000
        """, (cutoff,)).fetchall()

        graded = 0
        for pid, sym, pred_date in pending:
            pd_str = str(pred_date)[:10]
            try:
                pd_obj = datetime.date.fromisoformat(pd_str)
            except ValueError:
                continue

            entry_row = conn.execute(
                "SELECT open FROM stock_ohlcv WHERE symbol=? AND date > ? AND COALESCE(is_suspect,0)=0 ORDER BY date ASC LIMIT 1",
                (sym, pd_str),
            ).fetchone()
            exit_target = (pd_obj + datetime.timedelta(days=horizon)).isoformat()
            exit_row = conn.execute(
                "SELECT close FROM stock_ohlcv WHERE symbol=? AND date >= ? AND COALESCE(is_suspect,0)=0 ORDER BY date ASC LIMIT 1",
                (sym, exit_target),
            ).fetchone()

            if not entry_row or not exit_row:
                continue  # leave NULL; will retry next run once OHLCV lands
            entry = float(entry_row[0] or 0)
            if entry <= 0:
                continue
            ret = (float(exit_row[0]) - entry) / entry * 100

            # Vol-scaled threshold: large-caps rarely move 0.5% in a day, small-caps move 3%+
            if sym not in _vol_cache:
                _vol_cache[sym] = _symbol_vol_threshold(sym, pd_str)
            threshold_pct = _vol_cache[sym]
            outcome = 'UP' if ret > threshold_pct else 'DOWN' if ret < -threshold_pct else 'FLAT'

            if dry_run:
                continue
            conn.execute(
                f"UPDATE deep_learning_predictions SET {col_ret}=?, {col_out}=? WHERE id=?",
                (round(ret, 4), outcome, pid),
            )
            graded += 1
        return graded

    g5 = grade_for('actual_ret_5d', 'outcome_5d', 5)
    g15 = grade_for('actual_ret_15d', 'outcome_15d', 15)
    if not dry_run:
        conn.commit()
    print(f"[OutcomeResolver] Graded DL predictions: 5d={g5}, 15d={g15}")
    return {'graded_5d': g5, 'graded_15d': g15}


def expire_stale_pending(conn: ConnWrapper, horizon_days: int, dry_run: bool = False) -> int:
    """Mark PENDING outcomes older than 2×horizon as NEUTRAL (stock/data unavailable).
    Covers signal_outcomes, unified_signal_outcomes and recommendation_log so no table
    accumulates permanently-stuck PENDING rows."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=horizon_days * 2)).isoformat()

    rows = conn.execute("""
        SELECT symbol, signal_date, horizon_days
        FROM signal_outcomes
        WHERE outcome = 'PENDING'
          AND horizon_days = ?
          AND signal_date < ?
    """, (horizon_days, cutoff)).fetchall()

    # unified + rec_log stale PENDING counts (for logging)
    uni_stale = conn.execute("""
        SELECT COUNT(*) FROM unified_signal_outcomes
        WHERE outcome = 'PENDING' AND horizon_days = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff)).fetchone()[0]
    rec_stale = conn.execute("""
        SELECT COUNT(*) FROM recommendation_log
        WHERE outcome = 'PENDING' AND COALESCE(horizon_days, 15) = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff)).fetchone()[0]

    if dry_run:
        print(f"[OutcomeResolver] Would expire {len(rows)} signal_outcomes, "
              f"{uni_stale} unified, {rec_stale} rec_log stale {horizon_days}D PENDING")
        return len(rows)

    conn.execute("""
        UPDATE signal_outcomes
        SET outcome = 'NEUTRAL', return_pct = 0.0, computed_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING' AND horizon_days = ? AND signal_date < ?
    """, (horizon_days, cutoff))
    conn.execute("""
        UPDATE unified_signal_outcomes
        SET outcome = 'NEUTRAL', return_pct = 0.0, computed_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING' AND horizon_days = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff))
    conn.execute("""
        UPDATE recommendation_log
        SET outcome = 'NEUTRAL', actual_return_pct = 0.0,
            status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP
        WHERE outcome = 'PENDING' AND COALESCE(horizon_days, 15) = ? AND substr(signal_date,1,10) < ?
    """, (horizon_days, cutoff))
    conn.commit()
    print(f"[OutcomeResolver] Expired stale {horizon_days}D PENDING -> NEUTRAL "
          f"(signal_outcomes={len(rows)}, unified={uni_stale}, rec_log={rec_stale})")
    return len(rows)


def resolve_recommendation_log(
    conn: ConnWrapper,
    horizon_days: int = 15,
    dry_run: bool = False,
) -> dict[str, int]:
    """Resolve recommendation_log.outcome by checking OHLCV data after the signal horizon."""
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=horizon_days)).isoformat()

    pending = conn.execute("""
        SELECT id, symbol, signal_date, entry_price, stop_loss, target_1,
               COALESCE(horizon_days, ?) AS rl_horizon
        FROM recommendation_log
        WHERE (outcome IS NULL OR outcome = 'PENDING')
          AND entry_price IS NOT NULL
          AND signal_date <= ?
        ORDER BY signal_date DESC
        LIMIT 2000
    """, (horizon_days, cutoff)).fetchall()

    cols = ['id', 'symbol', 'signal_date', 'entry_price', 'stop_loss', 'target_1', 'rl_horizon']
    rows = [dict(zip(cols, r)) for r in pending]

    if not rows:
        print("[OutcomeResolver] No pending recommendation_log entries to resolve.")
        return {'processed': 0, 'resolved': 0}

    print(f"[OutcomeResolver] {len(rows)} recommendation_log entries pending resolution.")
    resolved = 0

    for row in rows:
        rec_id = row['id']
        sym = row['symbol']
        signal_date = str(row['signal_date'])
        entry = float(row['entry_price'] or 0)
        stop_loss = float(row['stop_loss']) if row['stop_loss'] else None
        h = int(row['rl_horizon'] or horizon_days)

        if not entry:
            continue

        signal_date_str = signal_date[:10]
        signal_date_obj = datetime.date.fromisoformat(signal_date_str)

        next_row = conn.execute(
            "SELECT date FROM stock_ohlcv WHERE symbol = ? AND date > ? AND COALESCE(is_suspect,0)=0 ORDER BY date ASC LIMIT 1",
            (sym, signal_date_str)
        ).fetchone()
        next_trading_day = next_row[0] if next_row else (signal_date_obj + datetime.timedelta(days=1)).isoformat()
        exit_target_date = (signal_date_obj + datetime.timedelta(days=h)).isoformat()

        # #2 exit policy: target-capture / scale-out / chandelier trailing over the bar window
        # (entry stays the recommended price, unlike the next-day-open signal resolvers).
        target = float(row['target_1']) if row.get('target_1') else None
        atr = get_atr(conn, sym, signal_date_str)
        bar_rows = conn.execute("""
            SELECT date, high, low, close FROM stock_ohlcv
            WHERE symbol = ? AND date >= ? AND date <= ? AND COALESCE(is_suspect,0)=0
            ORDER BY date ASC
        """, (sym, next_trading_day, exit_target_date)).fetchall()
        bars = [(str(b[0]), float(b[1]), float(b[2]), float(b[3])) for b in bar_rows]

        # Check if we can use intraday bars for path resolution.
        # NOTE: uses query_all() (its own isolated connection), not the shared `conn` — this
        # function commits once at the end of the whole row loop, so if this ran on `conn` a
        # failure here would (a) on Postgres, abort the shared transaction and poison every
        # later query on `conn` for the rest of the loop (this exact bug hit production:
        # InFailedSqlTransaction downstream in get_volatility_threshold for an unrelated
        # symbol), and (b) a bare conn.rollback() to recover would discard every already-
        # processed row's uncommitted UPSERT from earlier in this same loop.
        use_intra = False
        if next_trading_day and exit_target_date:
            try:
                start_d = datetime.date.fromisoformat(next_trading_day)
                end_d = datetime.date.fromisoformat(exit_target_date)
                _IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
                session_start = datetime.datetime(start_d.year, start_d.month, start_d.day, 9, 15, tzinfo=_IST).isoformat()
                session_end   = datetime.datetime(end_d.year, end_d.month, end_d.day, 15, 30, tzinfo=_IST).isoformat()

                intra_rows = query_all("""
                    SELECT datetime, high, low, close FROM intraday_ohlcv
                    WHERE symbol = ? AND datetime >= ? AND datetime <= ? AND interval = '15m'
                    ORDER BY datetime ASC
                """, (sym, session_start, session_end))
                if len(intra_rows) >= 5:
                    bars = [(str(b[0]), float(b[1]), float(b[2]), float(b[3])) for b in intra_rows]
                    use_intra = True
            except Exception:
                pass

        # Query total dividend paid during holding period (isolated connection — see above).
        dividend_sum = 0.0
        if next_trading_day and exit_target_date:
            try:
                div_row = query_one("""
                    SELECT COALESCE(SUM(amount), 0.0) FROM corporate_actions
                    WHERE symbol = ? AND action_type = 'DIVIDEND'
                      AND ex_date >= ? AND ex_date <= ?
                """, (sym, next_trading_day, exit_target_date))
                if div_row:
                    dividend_sum = float(div_row[0])
            except Exception:
                pass

        outcome, exit_price, return_pct = None, None, None
        if not bars:
            outcome = 'PENDING'
        else:
            initial_stop = stop_loss if (stop_loss and stop_loss > 0) else None
            _, exit_price, exit_reason, gross = simulate_exit(
                bars, entry=entry, initial_stop=initial_stop, target=target, atr=atr)
            
            # Incorporate dividend returns if any paid during the trade
            if dividend_sum > 0:
                dividend_pct = (dividend_sum / entry) * 100
                gross += dividend_pct
                
            return_pct = net_return_pct(gross)
            if exit_reason == 'STOP_LOSS':
                outcome = 'LOSS'
            else:
                threshold = get_volatility_threshold(conn, sym, signal_date, h)
                outcome = ('WIN'  if return_pct > threshold  else
                           'LOSS' if return_pct < -threshold else
                           'NEUTRAL')

        if dry_run:
            msg = f"  [DRY] REC_LOG {sym} {signal_date} -> {outcome}"
            if return_pct is not None:
                msg += f" ({return_pct:.2f}%)"
            print(msg)
            continue

        conn.execute("""
            UPDATE recommendation_log
            SET outcome = ?,
                actual_exit_price = ?,
                actual_return_pct = ?,
                status = CASE WHEN ? != 'PENDING' THEN 'RESOLVED' ELSE status END,
                resolved_at = CASE WHEN ? != 'PENDING' THEN CURRENT_TIMESTAMP ELSE resolved_at END
            WHERE id = ?
        """, (outcome, exit_price,
              round(return_pct, 4) if return_pct is not None else None,
              outcome, outcome, rec_id))

        if outcome != 'PENDING':
            resolved += 1

    if not dry_run:
        conn.commit()

    print(f"[OutcomeResolver] Resolved {resolved}/{len(rows)} recommendation_log entries.")
    return {'processed': len(rows), 'resolved': resolved}


def run(horizon_days: int = 1, dry_run: bool = False):
    conn = connect()
    try:
        resolve_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_unified_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_recommendation_log(conn, horizon_days=horizon_days, dry_run=dry_run)
        resolve_dl_predictions(conn, dry_run=dry_run)
        expire_stale_pending(conn, horizon_days=horizon_days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--horizon',  type=int, default=1)
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()
    run(horizon_days=args.horizon, dry_run=args.dry_run)
