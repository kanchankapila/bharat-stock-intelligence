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

NIFTY_SYMBOL = "NIFTY50"
K_PRIOR_STARTUP = 8        # Bayesian prior when <90 days of screener history
K_PRIOR_MATURE  = 20       # Bayesian prior when history is established (>90 days)
MIN_SIGNALS_FOR_TIER = 5   # below this = Unranked


def get_trading_days_after(conn: ConnWrapper, symbol: str, start_date: str, n: int):
    """Return (price, actual_date) n trading days after start_date from stock_ohlcv."""
    rows = conn.execute("""
        SELECT close, date FROM stock_ohlcv
        WHERE symbol = ? AND date > ?
        ORDER BY date ASC
        LIMIT ?
    """, (symbol, start_date, n + 5)).fetchall()
    if len(rows) < n:
        return None, None
    return rows[n - 1][0], rows[n - 1][1]


def get_price_on_or_after(conn: ConnWrapper, symbol: str, date: str):
    """Return close price on date or next available trading day."""
    row = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol = ? AND date >= ?
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
    """Fill return columns for screener_appearances rows where any short-horizon return is NULL."""
    print("[PhaseB] Filling screener_appearances returns from stock_ohlcv...")

    today = datetime.date.today()
    # Use the shortest horizon (5 trading days ≈ 7 calendar days) as the gating cutoff.
    # Longer horizons (10d, 20d) will be NULL for recent rows and filled on later runs.
    cutoff_5d = (today - datetime.timedelta(days=7)).isoformat()

    pending = conn.execute("""
        SELECT screener_id, symbol, appeared_date
        FROM screener_appearances
        WHERE return_5d IS NULL
          AND appeared_date <= ?
    """, (cutoff_5d,)).fetchall()

    if not pending:
        print("[PhaseB] Nothing to fill.")
        return 0

    print(f"[PhaseB] Filling returns for {len(pending)} appearances...")
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


def phase_c_bayesian(conn: ConnWrapper, proxy_outcomes: dict) -> int:
    """Compute Bayesian scores + tiers. Write to screener_performance_v2."""
    print("[PhaseC] Computing Bayesian scores + tiers...")

    all_screeners = conn.execute("SELECT scan_id, source FROM screener_master").fetchall()

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

    for screener_id, source in all_screeners:
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

        for row in app_rows:
            r5, r10, r20, r60, r120, nifty20, _ = row
            if r20 is not None:
                ret20_list.append(float(r20))
                nifty20_list.append(float(nifty20) if nifty20 is not None else None)
            if r5  is not None: ret5_list.append(float(r5))
            if r10 is not None: ret10_list.append(float(r10))
            if r60 is not None: ret60_list.append(float(r60))
            if r120 is not None: ret120_list.append(float(r120))

        # Add proxy (20d only, no nifty benchmark available)
        for ret_pct, _ in proxy:
            ret20_list.append(ret_pct)
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
            ON CONFLICT(screener_id) DO UPDATE SET
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

    conn.execute("""
        UPDATE screener_master
        SET tier = (
            SELECT tier FROM screener_performance_v2
            WHERE screener_performance_v2.screener_id = screener_master.scan_id
        )
        WHERE EXISTS (
            SELECT 1 FROM screener_performance_v2
            WHERE screener_id = screener_master.scan_id
        )
    """)

    print("[PhaseD] Syncing win_rate_* to screener_reliability...")

    conn.execute("""
        UPDATE screener_reliability
        SET win_rate_5d   = spv.wr_5d,
            win_rate_10d  = spv.wr_10d,
            win_rate_20d  = spv.wr_20d,
            win_rate_60d  = spv.wr_60d,
            win_rate_120d = spv.wr_120d
        FROM screener_performance_v2 spv
        WHERE screener_reliability.scan_id = spv.screener_id
    """)

    conn.commit()
    print("[PhaseD] Sync complete.")


# -- Phase E: Update screener_catalog confidence from bayesian_score -----------

def phase_e_update_confidence(conn: ConnWrapper) -> None:
    """Drive screener_catalog.confidence from the computed bayesian_score."""
    print("[PhaseE] Updating screener_catalog confidence from bayesian_score...")

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
          AND spv.bayesian_score IS NOT NULL
    """)
    conn.commit()

    changed = conn.execute("""
        SELECT COUNT(*) FROM screener_catalog sc
        JOIN screener_performance_v2 spv ON spv.screener_id = sc.screener_id
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS screener_performance_history (
            screener_id     TEXT NOT NULL,
            as_of_date      TEXT NOT NULL,
            bayesian_score  REAL,
            tier            TEXT,
            wr_20d          REAL,
            alpha_20d       REAL,
            resolved_count  INTEGER,
            computed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (screener_id, as_of_date)
        )
    """)
    conn.execute("""CREATE INDEX IF NOT EXISTS idx_sph_asof
                    ON screener_performance_history (as_of_date)""")
    conn.commit()


def compute_pit_scores(conn: ConnWrapper, as_of: str) -> dict:
    """bayesian_score per screener using ONLY appearances resolved strictly before as_of."""
    cutoff = (datetime.date.fromisoformat(as_of)
              - datetime.timedelta(days=RESOLUTION_LAG_DAYS)).isoformat()

    rows = conn.execute("""
        SELECT screener_id, return_20d, nifty_ret_20d
        FROM screener_appearances
        WHERE outcome_20d IN ('WIN','LOSS','NEUTRAL')
          AND return_20d IS NOT NULL
          AND appeared_date::text < ?
    """, (cutoff,)).fetchall()

    by_screener = defaultdict(list)
    for sid, r20, nifty20 in rows:
        by_screener[sid].append((float(r20), float(nifty20) if nifty20 is not None else None))

    # global prior from screeners with enough resolved history AS OF this date
    wrs = [_wr_from_list([r for r, _ in v]) for v in by_screener.values() if len(v) >= 10]
    wrs = [w for w in wrs if w is not None]
    global_mean_wr = float(statistics.mean(wrs)) if wrs else 0.52
    K_PRIOR = K_PRIOR_STARTUP if len(by_screener) < 50 else K_PRIOR_MATURE

    out = {}
    for sid, vals in by_screener.items():
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
        out[sid] = {'bayesian_score': composite, 'tier': tier, 'wr_20d': round(wr, 4),
                    'alpha_20d': m.get('alpha'), 'resolved_count': n}
    return out


def phase_f_pit(conn: ConnWrapper, as_of: str) -> int:
    ensure_pit_schema(conn)
    scores = compute_pit_scores(conn, as_of)
    for sid, s in scores.items():
        conn.execute("""
            INSERT INTO screener_performance_history
              (screener_id, as_of_date, bayesian_score, tier, wr_20d, alpha_20d, resolved_count)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(screener_id, as_of_date) DO UPDATE SET
              bayesian_score=excluded.bayesian_score, tier=excluded.tier,
              wr_20d=excluded.wr_20d, alpha_20d=excluded.alpha_20d,
              resolved_count=excluded.resolved_count, computed_at=CURRENT_TIMESTAMP
        """, (sid, as_of, s['bayesian_score'], s['tier'], s['wr_20d'],
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
        phase_f_pit(conn, datetime.date.today().isoformat())
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
    ap.add_argument('--end', default=datetime.date.today().isoformat())
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
