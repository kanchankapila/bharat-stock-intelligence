#!/usr/bin/env python3
"""
Screener performance engine.
Computes Bayesian win rates + tiers for all 1,521 screeners.

Phases:
  A - Bootstrap proxy: confluence_signals x signal_outcomes -> per-screener metrics
  B - Fill screener_appearances returns from stock_ohlcv
  C - Bayesian composite score + A/B/C/D tier assignment
  D - Sync tier back to screener_master + screener_reliability
"""

import json
import statistics
import datetime
from collections import defaultdict

from db_compat import connect, ConnWrapper
from as_of import logical_trading_date

NIFTY_SYMBOL = "NIFTY50"
K_PRIOR_STARTUP = 8        # Bayesian prior when <90 days of screener history
K_PRIOR_MATURE  = 20       # Bayesian prior when history is established (>90 days)
MIN_SIGNALS_FOR_TIER = 5   # below this = Unranked


def get_trading_days_after(conn: ConnWrapper, symbol: str, start_date: str, n: int):
    """Return (price, actual_date) n trading days after start_date from stock_ohlcv.

    Excludes is_suspect bars (2026-07-31 bad-bar quarantine — circuit-locked/impossible-move
    days) so a screener's measured return doesn't price off a known-bad print. Live-verified
    2026-08-04: 52% of |return_20d|>50% screener_appearances rows traced to an is_suspect bar
    in their window; skipping to the next clean bar is the same defensive pattern
    backtester.py/performance_tracker.py already use.
    """
    rows = conn.execute("""
        SELECT close, date FROM stock_ohlcv
        WHERE symbol = ? AND date > ? AND (is_suspect IS NULL OR is_suspect = 0)
        ORDER BY date ASC
        LIMIT ?
    """, (symbol, start_date, n + 5)).fetchall()
    if len(rows) < n:
        return None, None
    return rows[n - 1][0], rows[n - 1][1]


def get_price_on_or_after(conn: ConnWrapper, symbol: str, date: str):
    """Return close price on date or next available trading day, excluding is_suspect bars."""
    row = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol = ? AND date >= ? AND (is_suspect IS NULL OR is_suspect = 0)
        ORDER BY date ASC LIMIT 1
    """, (symbol, date)).fetchone()
    return row[0] if row else None


def compute_return(entry, exit_p):
    if entry is None or exit_p is None or entry == 0:
        return None
    return round((exit_p - entry) / entry * 100, 4)


# -- Phase A: Bootstrap proxy -------------------------------------------------

def phase_a_bootstrap(conn: ConnWrapper) -> dict:
    """
    Build screener_id -> [(return_pct, outcome)] mapping from:
      confluence_signals.screener_ids_json (which screeners were active for a symbol)
      signal_outcomes (what happened 20 days later)
    This is an approximation since we join on symbol without exact date alignment.
    """
    print("[PhaseA] Bootstrapping screener metrics from confluence_signals x signal_outcomes...")

    # Load resolved outcomes — prefer 5D (2,157 rows) since no 20D data exists yet.
    # signal_source='technical' (2026-08): horizon=5 is exclusively written by
    # outcome_resolver.py (confluence_outcome_tracker.py's own HORIZONS list never includes
    # 5), so this has always practically read technical-sourced rows despite the docstring
    # above framing it as a confluence-screener proxy -- made explicit rather than accidental.
    outcomes = conn.execute("""
        SELECT symbol, signal_date, return_pct, outcome
        FROM signal_outcomes
        WHERE outcome IN ('WIN', 'LOSS', 'NEUTRAL')
          AND return_pct IS NOT NULL
          AND signal_source = 'technical'
          AND (is_suspect IS NULL OR is_suspect = 0)
        ORDER BY horizon_days DESC, signal_date DESC
    """).fetchall()

    if not outcomes:
        print("[PhaseA] No resolved outcomes found. Skipping bootstrap.")
        return {}

    # Build symbol -> [(date, screener_ids)] from confluence_signals
    conf_rows = conn.execute("""
        SELECT symbol, screener_ids_json, computed_at
        FROM confluence_signals
        WHERE screener_ids_json IS NOT NULL
        ORDER BY symbol, computed_at DESC
    """).fetchall()

    conf_by_symbol = defaultdict(list)
    for sym, ids_json, computed_at in conf_rows:
        try:
            ids = json.loads(ids_json) if ids_json else []
            if ids:
                # computed_at is a timestamptz (datetime) on Postgres, a string on SQLite.
                conf_by_symbol[sym].append((str(computed_at)[:10], ids))
        except (json.JSONDecodeError, TypeError):
            pass

    # Attribute each outcome to screeners that were active for that symbol
    screener_outcomes = defaultdict(list)
    attributed = 0

    for symbol, signal_date, return_pct, outcome in outcomes:
        conf_entries = conf_by_symbol.get(symbol, [])
        if not conf_entries:
            continue

        # Find closest confluence entry at or before signal_date. No fallback to the most
        # recent entry when none qualifies — that entry can postdate signal_date and would
        # attribute an already-known outcome to a screener the symbol only joined afterward
        # (look-ahead bias into the Phase C Bayesian win-rate/tier computation).
        best_ids = None
        best_date = '0000-00-00'
        for conf_date, ids in conf_entries:
            if conf_date <= signal_date and conf_date > best_date:
                best_date = conf_date
                best_ids = ids

        if not best_ids:
            continue

        for screener_id in best_ids:
            screener_outcomes[screener_id].append((return_pct, outcome))
        attributed += 1

    total = len(screener_outcomes)
    total_signals = sum(len(v) for v in screener_outcomes.values())
    print(f"[PhaseA] {total} screeners, {total_signals} attributed outcomes, {attributed}/{len(outcomes)} signal_outcomes used")
    return dict(screener_outcomes)


# -- Phase B: Fill screener_appearances returns --------------------------------

def phase_b_fill_returns(conn: ConnWrapper) -> int:
    """Fill return columns for screener_appearances rows where any horizon return is NULL.

    BUG FOUND 2026-08-07 (dead-column sweep): the original WHERE clause gated purely on
    `return_5d IS NULL`, so a row was selected AT MOST ONCE -- whenever it first became old
    enough to fill return_5d (~7 calendar days after appearing). The comment directly above
    this fix ("Longer horizons will be NULL for recent rows and filled on later runs") states
    the intended design, but the actual predicate never re-selected a row after return_5d was
    set, so return_60d/return_120d (which need 60/120 *trading* days of forward price history
    -- far more than 7 calendar days) were always still None at that point and never revisited.
    Confirmed live: 671,072/671,072 screener_appearances rows had return_60d/return_120d NULL,
    100%, while return_5d/return_10d/return_20d were populated normally. Fixed by gating on
    EACH horizon independently -- a row is now re-selected as long as ANY of its 5 target
    columns is still NULL and enough calendar time has passed for THAT horizon specifically.
    """
    print("[PhaseB] Filling screener_appearances returns from stock_ohlcv...")

    today = datetime.date.today()
    # ~1.4 calendar days per trading day (5 trading days ≈ 7 calendar days, this file's own
    # existing ratio) + a margin for holiday clusters, applied to each horizon independently.
    cutoff_5d = (today - datetime.timedelta(days=7)).isoformat()
    cutoff_60d = (today - datetime.timedelta(days=95)).isoformat()
    cutoff_120d = (today - datetime.timedelta(days=185)).isoformat()

    # BUG FOUND 2026-08-09: the EACH-horizon fix above correctly widened the predicate, but
    # never excluded symbols with NO stock_ohlcv rows at all -- those can never be filled
    # (get_price_on_or_after always returns None) and were being re-selected and re-queried
    # on EVERY run, forever. Live-verified: 60,007 pending rows across 1,956 distinct symbols,
    # but 1,943/1,956 (99.3%) have zero OHLCV coverage -- this was the actual cause of
    # screener-performance's chronic 45min timeout, and because the old code only
    # conn.commit()'d once at the very end, a timeout-killed run lost 100% of its progress.
    #
    # A first attempt fixed this with `AND EXISTS (SELECT 1 FROM stock_ohlcv o WHERE
    # o.symbol = sa.symbol)` -- correct in principle, but a REAL production incident
    # (2026-08-09): stock_ohlcv is a compressed TimescaleDB hypertable, and Postgres's
    # planner satisfied that correlated EXISTS by materializing a HashAggregate over a
    # 40-million-row Append across every chunk (EXPLAIN showed full DecompressChunk scans
    # on every compressed chunk instead of any per-symbol pruning) -- crashed the backend
    # connection twice in a row with "server closed the connection unexpectedly", not a
    # timeout. `symbol` IS the hypertable's segmentby column, so a LITERAL per-symbol
    # equality lookup (`WHERE symbol = ?`) prunes to just that symbol's compressed segments
    # and stays cheap (~40ms even for a miss, live-measured) -- but wrapping the same
    # equality inside a correlated subquery/JOIN made the planner choose full decompression
    # instead. Fixed by doing the coverage check as N individual per-symbol lookups in
    # Python rather than one SQL join -- exactly the same defensive pattern this codebase
    # already uses elsewhere for this table (see CLAUDE.md's ohlcv_adjust.py notes: "update
    # by explicit (symbol, date) key in small batches" to avoid the identical decompression
    # trap). Kept the variable name "pending" -- it now means "pending AND fillable".
    candidates = conn.execute("""
        SELECT screener_id, symbol, appeared_date
        FROM screener_appearances
        WHERE (return_5d IS NULL AND appeared_date <= ?)
           OR (return_60d IS NULL AND appeared_date <= ?)
           OR (return_120d IS NULL AND appeared_date <= ?)
    """, (cutoff_5d, cutoff_60d, cutoff_120d)).fetchall()

    if not candidates:
        print("[PhaseB] Nothing to fill.")
        return 0

    distinct_symbols = {row[1] for row in candidates}
    covered = {
        sym for sym in distinct_symbols
        if conn.execute("SELECT 1 FROM stock_ohlcv WHERE symbol = ? LIMIT 1", (sym,)).fetchone()
    }
    pending = [row for row in candidates if row[1] in covered]

    if not pending:
        print(f"[PhaseB] {len(candidates)} candidates, 0 have OHLCV coverage. Nothing to fill.")
        return 0

    print(f"[PhaseB] {len(candidates)} candidates ({len(distinct_symbols)} symbols, "
          f"{len(covered)} with OHLCV coverage) -- filling {len(pending)} appearances...")
    filled = 0

    for screener_id, symbol, appeared_date in pending:
        # appeared_date is a timestamptz (datetime) on Postgres; use its date portion for
        # the OHLCV lookups but keep the original value for the UPDATE WHERE row match.
        lookup_date = str(appeared_date)[:10]
        entry_price = get_price_on_or_after(conn, symbol, lookup_date)
        if entry_price is None:
            continue

        returns = {}
        for n, col in [(5, 'return_5d'), (10, 'return_10d'), (20, 'return_20d'), (60, 'return_60d'), (120, 'return_120d')]:
            exit_price, _ = get_trading_days_after(conn, symbol, lookup_date, n)
            returns[col] = compute_return(entry_price, exit_price)

        nifty_exit, _ = get_trading_days_after(conn, NIFTY_SYMBOL, lookup_date, 20)
        nifty_entry = get_price_on_or_after(conn, NIFTY_SYMBOL, lookup_date)
        nifty_ret_20d = compute_return(nifty_entry, nifty_exit)

        r20 = returns.get('return_20d')
        if r20 is None:
            outcome_20d = 'PENDING'
        elif nifty_ret_20d is not None:
            diff = r20 - nifty_ret_20d
            outcome_20d = 'WIN' if diff > 0.5 else ('LOSS' if diff < -0.5 else 'NEUTRAL')
        else:
            outcome_20d = 'WIN' if r20 > 1.0 else ('LOSS' if r20 < -1.0 else 'NEUTRAL')

        conn.execute("""
            UPDATE screener_appearances
            SET return_5d=?, return_10d=?, return_20d=?, return_60d=?, return_120d=?,
                nifty_ret_20d=?, outcome_20d=?
            WHERE screener_id=? AND symbol=? AND appeared_date=?
        """, (
            returns['return_5d'], returns['return_10d'], returns['return_20d'],
            returns['return_60d'], returns['return_120d'],
            nifty_ret_20d, outcome_20d,
            screener_id, symbol, appeared_date
        ))
        filled += 1

        # Batched commit (2026-08-09, same bug session as the EXISTS fix above): the old
        # single commit() at the very end meant a timeout-killed run lost 100% of its
        # progress -- committing every 500 rows means a killed run keeps whatever it already
        # filled, so the backlog actually shrinks run over run instead of resetting to zero.
        if filled % 500 == 0:
            conn.commit()

    conn.commit()
    print(f"[PhaseB] Filled {filled} rows.")
    return filled


# -- Phase C: Bayesian composite + tier ---------------------------------------

def _wr_from_list(lst):
    if not lst:
        return None
    return round(sum(1 for r in lst if r > 0) / len(lst), 4)


def _metrics_from_list(returns, nifty_rets):
    """Compute win_rate, avg_return, sharpe, alpha, max_drawdown."""
    if not returns:
        return {}
    wins = sum(1 for r in returns if r > 0)
    win_rate = wins / len(returns)
    avg_ret = statistics.mean(returns)
    median_ret = statistics.median(returns)
    std_ret = statistics.stdev(returns) if len(returns) > 1 else 0.0
    sharpe = avg_ret / std_ret if std_ret > 0 else 0.0
    max_dd = min(returns)

    valid_nifty = [r for r in nifty_rets if r is not None]
    alpha = None
    if valid_nifty and len(valid_nifty) == len(returns):
        alphas = [r - n for r, n in zip(returns, valid_nifty)]
        alpha = round(statistics.mean(alphas), 4)

    return {
        'win_rate': round(win_rate, 4),
        'avg_ret': round(avg_ret, 4),
        'median_ret': round(median_ret, 4),
        'sharpe': round(sharpe, 4),
        'max_drawdown': round(max_dd, 4),
        'alpha': alpha,
    }


def _adaptive_k_prior(conn: ConnWrapper) -> float:
    """Return K_PRIOR based on how much screener history exists."""
    row = conn.execute("""
        SELECT MIN(appeared_date)::date FROM screener_appearances
    """).fetchone()
    if not row or not row[0]:
        return K_PRIOR_STARTUP
    oldest = str(row[0])[:10]
    days_of_history = (datetime.date.today() - datetime.date.fromisoformat(oldest)).days
    return K_PRIOR_STARTUP if days_of_history < 90 else K_PRIOR_MATURE


def _sign_for_sentiment(sentiment) -> float:
    """+1 measures 'did price rise' (correct for bullish/neutral/unclassified screeners,
    which is what this whole file measured before this fix). -1 measures 'did price fall
    relative to benchmark' for a CONFIRMED bearish tag only -- a bearish screener (Near 52
    Week Low, RSI Bearish, Red Flags) is doing its job when the stock subsequently
    underperforms, so a raw price-up=win metric was scoring every correctly-functioning
    bearish/distress screener as near-zero reliability (live-verified 2026-08-04: ~29% of
    the 1,669-screener catalog is bearish-tagged; 'RSI Bearish'/'Near 52 Week Low' etc all
    showed reliability_score==0 despite large negative avg_return -- the correct outcome for
    a bearish screener). 'neutral' is deliberately left at +1, not flipped -- it's not a
    directional claim to reverse, and this file has no evidence either way for that tag.
    """
    return -1.0 if sentiment == 'bearish' else 1.0


def phase_c_bayesian(conn: ConnWrapper, proxy_outcomes: dict) -> int:
    """Compute Bayesian scores + tiers. Write to screener_performance_v2."""
    print("[PhaseC] Computing Bayesian scores + tiers...")

    all_screeners = conn.execute(
        "SELECT scan_id, source, inferred_sentiment FROM screener_master"
    ).fetchall()

    # Compute global mean win rate from well-tested screeners
    qualified = conn.execute("""
        SELECT screener_id,
               COUNT(*) as n,
               AVG(CASE WHEN outcome_20d = 'WIN' THEN 1.0 ELSE 0.0 END) as wr
        FROM screener_appearances
        WHERE outcome_20d IN ('WIN','LOSS','NEUTRAL')
        GROUP BY screener_id
        HAVING COUNT(*) >= 10
    """).fetchall()

    if qualified:
        global_mean_wr = float(statistics.mean(float(r[2]) for r in qualified))
    else:
        global_mean_wr = 0.52

    K_PRIOR = _adaptive_k_prior(conn)
    print(f"[PhaseC] Global mean win rate: {global_mean_wr:.3f} ({len(qualified)} qualifying screeners), K_PRIOR={K_PRIOR}")

    updated = 0

    for screener_id, source, inferred_sentiment in all_screeners:
        sign = _sign_for_sentiment(inferred_sentiment)

        # Appearance-based returns
        app_rows = conn.execute("""
            SELECT return_5d, return_10d, return_20d, return_60d, return_120d,
                   nifty_ret_20d, outcome_20d
            FROM screener_appearances
            WHERE screener_id = ? AND outcome_20d IN ('WIN','LOSS','NEUTRAL')
        """, (screener_id,)).fetchall()

        proxy = proxy_outcomes.get(screener_id, [])

        total_appearances = conn.execute(
            "SELECT COUNT(*) FROM screener_appearances WHERE screener_id = ?",
            (screener_id,)
        ).fetchone()[0]

        ret20_list, nifty20_list = [], []
        ret5_list, ret10_list, ret60_list, ret120_list = [], [], [], []

        # sign applies only to the stock-return leg -- nifty20_list stays the raw benchmark
        # return, so alpha for a bearish screener reads as "outperformance vs. being long the
        # index," not a doubly-flipped number.
        for row in app_rows:
            r5, r10, r20, r60, r120, nifty20, _ = row
            if r20 is not None:
                ret20_list.append(sign * float(r20))
                nifty20_list.append(float(nifty20) if nifty20 is not None else None)
            if r5  is not None: ret5_list.append(sign * float(r5))
            if r10 is not None: ret10_list.append(sign * float(r10))
            if r60 is not None: ret60_list.append(sign * float(r60))
            if r120 is not None: ret120_list.append(sign * float(r120))

        # Add proxy (20d only, no nifty benchmark available)
        for ret_pct, _ in proxy:
            ret20_list.append(sign * ret_pct)
            nifty20_list.append(None)

        resolved_count = len(ret20_list)
        n = resolved_count
        wr_20d = float(_wr_from_list(ret20_list) or 0.0)

        # Bayesian shrinkage
        shrunk_wr = (n * wr_20d + K_PRIOR * global_mean_wr) / (n + K_PRIOR)

        m = _metrics_from_list(ret20_list, nifty20_list)
        alpha_20d    = m.get('alpha')
        sharpe_20d   = m.get('sharpe', 0.0)
        max_dd       = m.get('max_drawdown', 0.0)
        avg_ret_20d  = m.get('avg_ret')
        median_ret_20d = m.get('median_ret')

        # Nifty alpha for 60d
        alpha_60d = None
        if ret60_list:
            nifty60_rows = conn.execute("""
                SELECT nifty_ret_20d FROM screener_appearances
                WHERE screener_id = ? AND return_60d IS NOT NULL
            """, (screener_id,)).fetchall()
            if nifty60_rows and len(nifty60_rows) == len(ret60_list):
                alphas60 = [r - (n[0] or 0) for r, n in zip(ret60_list, nifty60_rows)]
                alpha_60d = round(statistics.mean(alphas60), 4)

        # Normalise to 0-1
        alpha_norm  = min(max(((alpha_20d or 0) + 5) / 15, 0.0), 1.0)
        sharpe_norm = min(max((sharpe_20d or 0) / 3.0, 0.0), 1.0)
        dd_norm     = 1.0 - min(abs(max_dd or 0) / 20.0, 1.0)

        composite = (0.40 * shrunk_wr +
                     0.30 * alpha_norm +
                     0.20 * sharpe_norm +
                     0.10 * dd_norm)
        bayesian_score = round(composite, 4)

        if n < MIN_SIGNALS_FOR_TIER:
            tier = 'Unranked'
        elif composite >= 0.70:
            tier = 'A'
        elif composite >= 0.55:
            tier = 'B'
        elif composite >= 0.40:
            tier = 'C'
        else:
            tier = 'D'

        data_source = 'appearances' if not proxy else ('mixed' if app_rows else 'proxy')

        conn.execute("""
            INSERT INTO screener_performance_v2
              (screener_id, source, total_appearances, resolved_count,
               wr_5d, wr_10d, wr_20d, wr_60d, wr_120d,
               avg_ret_5d, avg_ret_10d, avg_ret_20d, avg_ret_60d, avg_ret_120d,
               alpha_20d, alpha_60d, sharpe_20d, max_drawdown, median_ret_20d,
               bayesian_score, tier, data_source, last_computed)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(screener_id, source) DO UPDATE SET
              total_appearances=excluded.total_appearances,
              resolved_count=excluded.resolved_count,
              wr_5d=excluded.wr_5d, wr_10d=excluded.wr_10d, wr_20d=excluded.wr_20d,
              wr_60d=excluded.wr_60d, wr_120d=excluded.wr_120d,
              avg_ret_20d=excluded.avg_ret_20d, avg_ret_60d=excluded.avg_ret_60d,
              alpha_20d=excluded.alpha_20d, alpha_60d=excluded.alpha_60d,
              sharpe_20d=excluded.sharpe_20d, max_drawdown=excluded.max_drawdown,
              median_ret_20d=excluded.median_ret_20d,
              bayesian_score=excluded.bayesian_score, tier=excluded.tier,
              data_source=excluded.data_source, last_computed=CURRENT_TIMESTAMP
        """, (
            screener_id, source, total_appearances, resolved_count,
            _wr_from_list(ret5_list), _wr_from_list(ret10_list), _wr_from_list(ret20_list),
            _wr_from_list(ret60_list), _wr_from_list(ret120_list),
            statistics.mean(ret5_list) if ret5_list else None,
            statistics.mean(ret10_list) if ret10_list else None,
            avg_ret_20d,
            statistics.mean(ret60_list) if ret60_list else None,
            statistics.mean(ret120_list) if ret120_list else None,
            alpha_20d, alpha_60d, sharpe_20d, max_dd, median_ret_20d,
            bayesian_score, tier, data_source
        ))
        updated += 1

    conn.commit()
    print(f"[PhaseC] Upserted {updated} rows into screener_performance_v2")
    return updated


# -- Phase D: Sync back -------------------------------------------------------

def phase_d_sync_back(conn: ConnWrapper) -> None:
    """Sync tier to screener_master and win_rate_* columns to screener_reliability."""
    print("[PhaseD] Syncing tiers to screener_master...")

    # source is required in both subqueries: without it, a scan_id colliding across providers
    # (2026-08-04 screener_master memory) would either error ("more than one row returned by a
    # subquery used as an expression") once both providers have a screener_performance_v2 row,
    # or silently sync the wrong provider's tier.
    conn.execute("""
        UPDATE screener_master
        SET tier = (
            SELECT tier FROM screener_performance_v2
            WHERE screener_performance_v2.screener_id = screener_master.scan_id
              AND screener_performance_v2.source = screener_master.source
        )
        WHERE EXISTS (
            SELECT 1 FROM screener_performance_v2
            WHERE screener_id = screener_master.scan_id
              AND source = screener_master.source
        )
    """)

    print("[PhaseD] Syncing win_rate_* to screener_reliability...")

    # source-scoped join, matching the (source, scan_id) PK on both tables (2026-08-04
    # migration): without it, a colliding scan_id (2026-08-04 screener_master memory) joins
    # screener_reliability's one row against BOTH providers' screener_performance_v2 rows, and
    # Postgres's UPDATE...FROM applies whichever one happens to match last -- silently writing
    # one provider's win rates onto the other's screener_reliability row. screener_reliability.
    # source is lowercase ('trendlyne'), screener_performance_v2.source is capitalized
    # ('Trendlyne') -- same casing split documented elsewhere in this file/screener_signal_
    # generator.py, bridged with LOWER() rather than normalized at the source.
    conn.execute("""
        UPDATE screener_reliability
        SET win_rate_5d   = spv.wr_5d,
            win_rate_10d  = spv.wr_10d,
            win_rate_20d  = spv.wr_20d,
            win_rate_60d  = spv.wr_60d,
            win_rate_120d = spv.wr_120d
        FROM screener_performance_v2 spv
        WHERE screener_reliability.scan_id = spv.screener_id
          AND screener_reliability.source = LOWER(spv.source)
    """)

    conn.commit()
    print("[PhaseD] Sync complete.")


# -- Phase E: Update screener_catalog confidence from bayesian_score -----------

def phase_e_update_confidence(conn: ConnWrapper) -> None:
    """Drive screener_catalog.confidence from the computed bayesian_score."""
    print("[PhaseE] Updating screener_catalog confidence from bayesian_score...")

    # source-scoped join (2026-08-04, same fix as phase_d_sync_back above): unscoped, this
    # could apply one provider's bayesian_score-derived confidence onto a DIFFERENT provider's
    # screener_catalog row whenever their scan_ids collide (20 pairs confirmed live). LOWER()
    # bridges screener_catalog's historical mixed-case source values (both 'trendlyne' and
    # 'Trendlyne' rows exist, per screener_signal_generator.py's own comment on this).
    conn.execute("""
        UPDATE screener_catalog sc
        SET confidence = CASE
            WHEN spv.bayesian_score >= 0.55 THEN 0.85
            WHEN spv.bayesian_score >= 0.45 THEN 0.78
            WHEN spv.bayesian_score >= 0.35 THEN 0.72
            ELSE 0.60
        END
        FROM screener_performance_v2 spv
        WHERE sc.screener_id = spv.screener_id
          AND LOWER(sc.source) = LOWER(spv.source)
          AND spv.bayesian_score IS NOT NULL
    """)
    conn.commit()

    changed = conn.execute("""
        SELECT COUNT(*) FROM screener_catalog sc
        JOIN screener_performance_v2 spv
          ON spv.screener_id = sc.screener_id AND LOWER(sc.source) = LOWER(spv.source)
        WHERE spv.bayesian_score IS NOT NULL
    """).fetchone()[0]
    print(f"[PhaseE] Updated confidence for {changed} screeners in screener_catalog")


# -- Phase F: point-in-time bayesian_score ------------------------------------
#
# phase_c writes ONE current bayesian_score per screener, computed over every resolved
# appearance in the table. screener_features_fetcher.py then uses that score as the WEIGHT
# in screener_momentum_score, which lands in technical_signals and feeds ml_ensemble.py and
# unified_ranker.py's screener block. Applying a full-sample score to a historical feature
# row means the row embeds knowledge of how the screener performed AFTER that date.
#
# No purged CV / embargo / holdout can detect this: the leak sits inside the feature value
# and is identical in train and test. So the score has to be stored as a time series, and
# each feature row has to read the score as it stood on that row's own date.
#
# An appearance is treated as KNOWN on `as_of` only once its 20-trading-day outcome could
# have been observed — approximated as appeared_date + RESOLUTION_LAG_DAYS calendar days.

RESOLUTION_LAG_DAYS = 30   # 20 trading days, with slack for weekends/holidays


def ensure_pit_schema(conn: ConnWrapper) -> None:
    # source-scoped PK (2026-08-06 fix): a 2026-08-05 migration
    # (1786200000000_screener-performance-history-source-pk) already widened the LIVE table's
    # PK to (source, screener_id, as_of_date) -- MC/ETnow hand out overlapping scan_ids (see the
    # 2026-08-04 screener_master (source, scan_id) fix), and this table is no exception. This
    # CREATE TABLE IF NOT EXISTS is a no-op against an already-migrated live DB, but must match
    # it for a fresh/reset DB -- the old 2-column definition here silently drifted out of sync
    # with the live schema for a day, during which every write below crashed with
    # "no unique or exclusion constraint matching ON CONFLICT" (found via live job_heartbeat:
    # screener-performance had failed on every run since the migration landed).
    conn.execute("""
        CREATE TABLE IF NOT EXISTS screener_performance_history (
            source          TEXT NOT NULL,
            screener_id     TEXT NOT NULL,
            as_of_date      TEXT NOT NULL,
            bayesian_score  REAL,
            tier            TEXT,
            wr_20d          REAL,
            alpha_20d       REAL,
            resolved_count  INTEGER,
            computed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (source, screener_id, as_of_date)
        )
    """)
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_sph_asof
                    ON screener_performance_history (as_of_date)""")
    conn.commit()


def compute_pit_scores(conn: ConnWrapper, as_of: str) -> dict:
    """bayesian_score per (source, screener_id) using ONLY appearances resolved strictly
    before as_of. Source-scoped (2026-08-06) to match screener_appearances' own (source,
    screener_id) key and close the same cross-provider scan_id collision this table's PK
    migration already closed at the schema level -- MC/ETnow independently issue overlapping
    small-integer scan_ids (confirmed live: scan_id 173 is both ETnow's and MoneyControl's)."""
    cutoff = (datetime.date.fromisoformat(as_of)
              - datetime.timedelta(days=RESOLUTION_LAG_DAYS)).isoformat()

    # screener_appearances.source is lowercase ('moneycontrol'/'etnow'/'trendlyne'/
    # 'et_marketstats'); screener_master.source is not ('MoneyControl'/'ETnow'/'Trendlyne') --
    # same pre-existing casing mismatch load_screener_meta already bridges with LOWER(), applied
    # here too rather than normalizing either table's stored values.
    sentiment_by_key = {(r[1].lower(), r[0]): r[2] for r in
                         conn.execute("SELECT scan_id, source, inferred_sentiment "
                                      "FROM screener_master").fetchall()}

    rows = conn.execute("""
        SELECT screener_id, source, return_20d, nifty_ret_20d
        FROM screener_appearances
        WHERE outcome_20d IN ('WIN','LOSS','NEUTRAL')
          AND return_20d IS NOT NULL
          AND appeared_date::text < ?
    """, (cutoff,)).fetchall()

    by_screener = defaultdict(list)
    for sid, source, r20, nifty20 in rows:
        key = (source, sid)
        sign = _sign_for_sentiment(sentiment_by_key.get(key))
        by_screener[key].append((sign * float(r20), float(nifty20) if nifty20 is not None else None))

    # global prior from screeners with enough resolved history AS OF this date
    wrs = [_wr_from_list([r for r, _ in v]) for v in by_screener.values() if len(v) >= 10]
    wrs = [w for w in wrs if w is not None]
    global_mean_wr = float(statistics.mean(wrs)) if wrs else 0.52
    K_PRIOR = K_PRIOR_STARTUP if len(by_screener) < 50 else K_PRIOR_MATURE

    out = {}
    for key, vals in by_screener.items():
        rets = [r for r, _ in vals]
        niftys = [n for _, n in vals]
        n = len(rets)
        wr = float(_wr_from_list(rets) or 0.0)
        shrunk_wr = (n * wr + K_PRIOR * global_mean_wr) / (n + K_PRIOR)
        m = _metrics_from_list(rets, niftys)
        alpha_norm = min(max(((m.get('alpha') or 0) + 5) / 15, 0.0), 1.0)
        sharpe_norm = min(max((m.get('sharpe') or 0) / 3.0, 0.0), 1.0)
        dd_norm = 1.0 - min(abs(m.get('max_drawdown') or 0) / 20.0, 1.0)
        composite = round(0.40 * shrunk_wr + 0.30 * alpha_norm
                          + 0.20 * sharpe_norm + 0.10 * dd_norm, 4)
        if n < MIN_SIGNALS_FOR_TIER:
            tier = 'Unranked'
        elif composite >= 0.70: tier = 'A'
        elif composite >= 0.55: tier = 'B'
        elif composite >= 0.40: tier = 'C'
        else: tier = 'D'
        out[key] = {'bayesian_score': composite, 'tier': tier, 'wr_20d': round(wr, 4),
                    'alpha_20d': m.get('alpha'), 'resolved_count': n}
    return out


def phase_f_pit(conn: ConnWrapper, as_of: str) -> int:
    ensure_pit_schema(conn)
    scores = compute_pit_scores(conn, as_of)
    for (source, sid), s in scores.items():
        conn.execute("""
            INSERT INTO screener_performance_history
              (source, screener_id, as_of_date, bayesian_score, tier, wr_20d, alpha_20d, resolved_count)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(source, screener_id, as_of_date) DO UPDATE SET
              bayesian_score=excluded.bayesian_score, tier=excluded.tier,
              wr_20d=excluded.wr_20d, alpha_20d=excluded.alpha_20d,
              resolved_count=excluded.resolved_count, computed_at=CURRENT_TIMESTAMP
        """, (source, sid, as_of, s['bayesian_score'], s['tier'], s['wr_20d'],
              s['alpha_20d'], s['resolved_count']))
    conn.commit()
    print(f"[PhaseF] as_of={as_of}: wrote {len(scores)} point-in-time screener scores")
    return len(scores)


def backfill_pit(conn: ConnWrapper, start: str, end: str, step_days: int = 7) -> None:
    """Walk history writing a PIT score snapshot every step_days. Weekly is enough --
    readers pick the latest snapshot <= their date."""
    ensure_pit_schema(conn)
    d = datetime.date.fromisoformat(start)
    end_d = datetime.date.fromisoformat(end)
    total = 0
    while d <= end_d:
        total += phase_f_pit(conn, d.isoformat())
        d += datetime.timedelta(days=step_days)
    print(f"[PhaseF] backfill complete: {total} rows across {start}..{end}")


# -- Entry point --------------------------------------------------------------

def run():
    conn = connect()
    try:
        proxy = phase_a_bootstrap(conn)
        phase_b_fill_returns(conn)
        phase_c_bayesian(conn, proxy)
        phase_d_sync_back(conn)
        phase_e_update_confidence(conn)
        # logical_trading_date(), not date.today() (2026-08-06) -- this job is scheduled at
        # 21:00 UTC = 02:30 IST, i.e. always AFTER midnight relative to the trading day it
        # summarizes. A raw date.today() call here would permanently stamp every PIT snapshot
        # one calendar day ahead of the data it actually reflects. See as_of.logical_trading_date's
        # docstring for the wider incident (insider_features.py/bse_event_classifier.py, 2026-08-01).
        phase_f_pit(conn, logical_trading_date())
        print("[ScreenerPerf] All phases complete.")

        # Print quick summary
        n = conn.execute("SELECT COUNT(*) FROM screener_performance_v2").fetchone()[0]
        tiers = conn.execute("SELECT tier, COUNT(*) FROM screener_performance_v2 GROUP BY tier ORDER BY tier").fetchall()
        print(f"[ScreenerPerf] {n} screeners in screener_performance_v2")
        print(f"[ScreenerPerf] Tier distribution: {dict(tiers)}")
    finally:
        conn.close()


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--backfill-pit', action='store_true',
                    help='backfill point-in-time screener scores over a date range')
    ap.add_argument('--start', default='2026-04-01')
    ap.add_argument('--end', default=logical_trading_date())
    ap.add_argument('--step-days', type=int, default=7)
    args = ap.parse_args()
    if args.backfill_pit:
        c = connect()
        try:
            backfill_pit(c, args.start, args.end, args.step_days)
        finally:
            c.close()
    else:
        run()
