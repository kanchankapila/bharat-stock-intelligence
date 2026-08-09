"""
Exit Labeler — path-based excursion labels for exit-policy learning
====================================================================
signal_outcomes records *whether* a signal won by the horizon. It cannot teach an EXIT
policy, because its only target is the horizon-close return — a name that ran +8% on day 2
and faded to +1% is labelled "+1% win", erasing the exit decision entirely.

This module replays the daily bars after each entry and records the excursion targets an
exit model actually needs:

  mfe_pct / mae_pct      — max favorable / adverse excursion over the holding window
  days_to_mfe / _mae     — when those extremes occurred (timing of the optimal exit)
  mfe_before_mae         — did the gain come before the pain? (trailing-stop viability)
  trail_exit_pct / _day  — return & day of a chandelier-trailed exit (highest-high − k·ATR)
  horizon_close_pct      — buy-and-hold-to-horizon baseline to beat

Writes signal_excursions(symbol, signal_date, horizon_days). Long-only, matching the
resolver's convention. ATR is measured from the 14 bars preceding entry (leak-free).

Run:  python exit_labeler.py
      python exit_labeler.py --horizon 15
      python exit_labeler.py --limit 500
"""

import argparse
import datetime

from db_compat import read_df, executemany, query_all, execute

CHANDELIER_ATR_MULT = 3.0   # trailing stop = highest-high-since-entry − 3×ATR (mirrors resolver)
ATR_WINDOW = 14

# Triple-barrier defaults: vol-scaled, asymmetric (reward:risk 2:1).
TB_K_UP   = 2.0     # upper barrier = +k_up · atr_pct
TB_K_DN   = 1.0     # lower barrier = −k_dn · atr_pct
# Cost band as a fraction of ATR rather than a fixed %; this keeps the neutral
# zone proportional to realized volatility (low-vol stocks had nearly all
# horizon returns inside the old fixed 0.4% band, starving the model of labels).
TB_COST_FRAC = 0.15  # neutral band = ±0.15 · atr_pct (≈0.3% at avg ATR 2%)


def triple_barrier_label(mfe_pct, mae_pct, mfe_before_mae, horizon_close_pct,
                         atr_pct, k_up: float = TB_K_UP, k_dn: float = TB_K_DN,
                         cost_frac: float = TB_COST_FRAC):
    """López de Prado triple-barrier label from precomputed excursions.

    Barriers are volatility-scaled and asymmetric: upper = +k_up·atr_pct,
    lower = −k_dn·atr_pct. Returns 1 (win), 0 (loss), or None (neutral / undecidable,
    excluded from training).

      - If both barriers are touched, `mfe_before_mae` decides which came first.
      - If only one is touched, it wins.
      - If neither is touched (time barrier) — or atr_pct is missing/≤0 so barriers are
        undefined — label by the net-of-cost sign of horizon_close_pct; inside the
        vol-scaled cost band it is NEUTRAL (None).
    """
    if horizon_close_pct is None:
        return None

    if atr_pct and atr_pct > 0:
        upper = k_up * atr_pct
        lower = -k_dn * atr_pct
        hit_up = mfe_pct is not None and mfe_pct >= upper
        hit_dn = mae_pct is not None and mae_pct <= lower
        if hit_up and hit_dn:
            return 1 if mfe_before_mae else 0
        if hit_up:
            return 1
        if hit_dn:
            return 0
        # neither barrier touched → fall through to the time-barrier rule
        cost_pct = cost_frac * atr_pct
    else:
        # No ATR available: fall back to a fixed 0.4% minimum cost band
        cost_pct = 0.4

    if abs(horizon_close_pct) < cost_pct:
        return None
    return 1 if horizon_close_pct > cost_pct else 0


def compute_atr(prior_bars: list, window: int = ATR_WINDOW) -> float:
    """Wilder-style ATR over the bars immediately preceding entry.
    `prior_bars`: list of (high, low, close) ascending. Returns a positive float, or 0.0 if
    fewer than 2 bars are available."""
    if len(prior_bars) < 2:
        return 0.0
    trs = []
    prev_close = prior_bars[0][2]
    for high, low, close in prior_bars[1:]:
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        trs.append(tr)
        prev_close = close
    if not trs:
        return 0.0
    tail = trs[-window:]
    return sum(tail) / len(tail)


def compute_excursions(entry: float, bars: list, atr: float,
                       chandelier_mult: float = CHANDELIER_ATR_MULT) -> dict:
    """Replay the holding window and return excursion + trailing-exit labels.

    `entry`: fill price. `bars`: list of (high, low, close) ascending, position open at entry.
    `atr`: ATR at entry for the chandelier stop. Day numbering is 1-based (day 1 = first bar
    after entry). Returns a dict of the signal_excursions value columns (entry-relative %)."""
    if entry <= 0 or not bars:
        return {}

    mfe_pct = mae_pct = 0.0
    days_to_mfe = days_to_mae = 0
    highest_high = entry
    trail_exit_pct = None
    trail_exit_day = None

    for i, (high, low, close) in enumerate(bars, start=1):
        up = (high - entry) / entry * 100.0
        dn = (low - entry) / entry * 100.0
        if up > mfe_pct:
            mfe_pct, days_to_mfe = up, i
        if dn < mae_pct:
            mae_pct, days_to_mae = dn, i

        # Chandelier trailing stop — only after ATR is known and the stop has been armed
        if atr > 0 and trail_exit_day is None:
            stop = highest_high - chandelier_mult * atr
            if low <= stop:
                exit_price = min(stop, high)            # gap-throughs fill at the stop, not below
                trail_exit_pct = (exit_price - entry) / entry * 100.0
                trail_exit_day = i
            highest_high = max(highest_high, high)

    horizon_close_pct = (bars[-1][2] - entry) / entry * 100.0
    if trail_exit_pct is None:
        trail_exit_pct = horizon_close_pct              # never stopped → held to horizon close

    mfe_before_mae = 1 if (days_to_mfe and (days_to_mae == 0 or days_to_mfe <= days_to_mae)) else 0
    atr_pct = round(atr / entry * 100.0, 4) if atr and atr > 0 else 0.0
    tb_label = triple_barrier_label(
        round(mfe_pct, 4), round(mae_pct, 4), mfe_before_mae,
        round(horizon_close_pct, 4), atr_pct,
    )

    return {
        "mfe_pct": round(mfe_pct, 4),
        "mae_pct": round(mae_pct, 4),
        "days_to_mfe": days_to_mfe,
        "days_to_mae": days_to_mae,
        "mfe_before_mae": mfe_before_mae,
        "trail_exit_pct": round(trail_exit_pct, 4),
        "trail_exit_day": trail_exit_day,
        "horizon_close_pct": round(horizon_close_pct, 4),
        "atr_pct": atr_pct,
        "tb_label": tb_label,
    }


def _entries(horizon: int | None, limit: int | None) -> list:
    # signal_source='technical' (2026-08): signal_excursions' key (symbol, signal_date,
    # horizon_days) has no source discriminator of its own -- now that signal_outcomes can
    # carry a technical- AND a confluence-sourced row for the same key, scoping here to
    # 'technical' keeps this at most one entry per key (matching every other ML consumer's
    # scope) rather than letting two entries with different entry_price collide on write.
    sql = (
        "SELECT o.symbol, o.signal_date, o.horizon_days, o.entry_price "
        "FROM signal_outcomes o "
        "WHERE o.entry_price IS NOT NULL AND o.signal_source = 'technical' "
        "AND NOT EXISTS ( "
        "  SELECT 1 FROM signal_excursions e "
        "  WHERE e.symbol = o.symbol "
        "    AND e.signal_date = o.signal_date "
        "    AND e.horizon_days = o.horizon_days "
        ")"
    )
    params = []
    if horizon is not None:
        sql += " AND o.horizon_days = ?"
        params.append(horizon)
    sql += " ORDER BY o.signal_date DESC"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return query_all(sql, tuple(params))


def _mark_delisted(candidate_symbols: list[str]) -> None:
    """Flip nse_stocks.status to DELISTED for symbols whose stock_ohlcv feed has genuinely
    stopped (latest bar >30 calendar days old), confirmed independently of any one signal's
    date so a temporary data gap around a single signal doesn't get misread as delisting.
    Historical rows (stock_ohlcv, signal_outcomes, signal_excursions) are never touched —
    only the nse_stocks status flag, so screens/search stop treating dead tickers as tradeable
    while training queries keep full access to their price history.
    """
    if not candidate_symbols:
        return
    placeholders = ",".join("?" for _ in candidate_symbols)
    stale_cutoff = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    confirmed = query_all(
        f"SELECT symbol, MAX(date) AS last_date FROM stock_ohlcv "
        f"WHERE symbol IN ({placeholders}) GROUP BY symbol "
        f"HAVING MAX(date) < ?",
        (*candidate_symbols, stale_cutoff),
    )
    if not confirmed:
        return
    to_delist = [r["symbol"] for r in confirmed]
    already = query_all(
        f"SELECT symbol FROM nse_stocks WHERE symbol IN ({','.join('?' for _ in to_delist)}) "
        f"AND status = 'DELISTED'",
        tuple(to_delist),
    )
    already_set = {r["symbol"] for r in already}
    newly = [s for s in to_delist if s not in already_set]
    if not newly:
        return
    for sym in newly:
        execute("UPDATE nse_stocks SET status = 'DELISTED' WHERE symbol = ?", (sym,))
    print(f"[EXIT] Marked {len(newly)} symbols DELISTED in nse_stocks "
          f"(no stock_ohlcv update since before {stale_cutoff}): {newly}")


def run(horizon: int | None = None, limit: int | None = None) -> int:
    """Compute excursion labels for signal_outcomes entries and upsert signal_excursions.
    Returns rows written."""
    entries = _entries(horizon, limit)
    if not entries:
        print("[EXIT] No entries to label.")
        return 0

    rows = []
    missing_ohlcv: list[str] = []
    stale_missing: list[str] = []   # zero forward bars AND the horizon window has long since
                                     # elapsed — likely delisted/suspended, not "too recent to label"
    today = datetime.date.today()
    for e in entries:
        symbol, signal_date, hd, entry = e["symbol"], e["signal_date"], e["horizon_days"], e["entry_price"]
        ohlcv = read_df(
            "SELECT date, high, low, close FROM stock_ohlcv "
            "WHERE symbol = ? AND date > ? AND COALESCE(is_suspect,0) = 0 "
            "ORDER BY date LIMIT ?",
            (symbol, signal_date, int(hd)),
        )
        if ohlcv.empty:
            missing_ohlcv.append(f"{symbol}@{signal_date}")
            # A generous 2.5x calendar-day buffer over the horizon (weekends/holidays) — if
            # that's elapsed with zero forward bars, the feed has stopped, not "not caught up
            # yet". This is the subset that actually drives survivorship bias; the rest are
            # simply too recent to label and will resolve on a later run.
            try:
                sig_dt = datetime.date.fromisoformat(str(signal_date)[:10])
                if (today - sig_dt).days > int(hd) * 2.5 + 10:
                    stale_missing.append(symbol)
            except ValueError:
                pass
            continue
        prior = read_df(
            "SELECT high, low, close FROM stock_ohlcv "
            "WHERE symbol = ? AND date <= ? AND COALESCE(is_suspect,0) = 0 "
            "ORDER BY date DESC LIMIT ?",
            (symbol, signal_date, ATR_WINDOW + 1),
        )
        atr = compute_atr(list(prior[["high", "low", "close"]].itertuples(index=False, name=None))[::-1])
        bars = list(ohlcv[["high", "low", "close"]].itertuples(index=False, name=None))
        exc = compute_excursions(float(entry), bars, atr)
        if not exc:
            continue
        rows.append((
            symbol, signal_date, int(hd), float(entry),
            exc["mfe_pct"], exc["mae_pct"], exc["days_to_mfe"], exc["days_to_mae"],
            exc["mfe_before_mae"], exc["trail_exit_pct"], exc["trail_exit_day"],
            exc["horizon_close_pct"], exc["atr_pct"], exc["tb_label"],
            datetime.datetime.now().isoformat(),
        ))

    if missing_ohlcv:
        too_recent = len(missing_ohlcv) - len(stale_missing)
        print(f"[EXIT] {len(missing_ohlcv)}/{len(entries)} entries skipped for zero forward "
              f"OHLCV coverage — {too_recent} too recent to label yet (will resolve on a "
              f"later run), {len(set(stale_missing))} likely delisted/suspended (feed stopped "
              f"long ago; permanently excluded from excursion labels — this subset is the real "
              f"survivorship-bias source). First 10 likely-delisted: {sorted(set(stale_missing))[:10]}")

        if stale_missing:
            _mark_delisted(sorted(set(stale_missing)))

    if not rows:
        print("[EXIT] No OHLCV coverage for the selected entries.")
        return 0

    n = executemany(
        """INSERT INTO signal_excursions
             (symbol, signal_date, horizon_days, entry_price,
              mfe_pct, mae_pct, days_to_mfe, days_to_mae, mfe_before_mae,
              trail_exit_pct, trail_exit_day, horizon_close_pct, atr_pct, tb_label, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol, signal_date, horizon_days) DO UPDATE SET
             entry_price       = excluded.entry_price,
             mfe_pct           = excluded.mfe_pct,
             mae_pct           = excluded.mae_pct,
             days_to_mfe       = excluded.days_to_mfe,
             days_to_mae       = excluded.days_to_mae,
             mfe_before_mae    = excluded.mfe_before_mae,
             trail_exit_pct    = excluded.trail_exit_pct,
             trail_exit_day    = excluded.trail_exit_day,
             horizon_close_pct = excluded.horizon_close_pct,
             atr_pct           = excluded.atr_pct,
             tb_label          = excluded.tb_label,
             computed_at       = excluded.computed_at""",
        rows,
    )
    print(f"[EXIT] Wrote {len(rows)} excursion labels to signal_excursions.")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Path-based exit labeler")
    parser.add_argument("--horizon", type=int, help="Only label this horizon (e.g. 5, 15)")
    parser.add_argument("--limit", type=int, help="Cap number of entries (newest first)")
    args = parser.parse_args()
    run(horizon=args.horizon, limit=args.limit)
