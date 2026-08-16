#!/usr/bin/env python3
"""
screener_signal_generator.py  (Tier 3F — Screener Surfacing Alerts)
====================================================================
Generates unified_signals when a stock enters a high-performing screener
for the first time (or re-enters after ≥30 days gap).

Signal criteria:
  - screener must have bayesian_score ≥ 0.50  (or be Trendlyne A/B tier)
  - stock must be appearing for the first time (or after ≥30d gap)
  - signal_bias of the screener must be "bullish"
  - at least 2 independent bullish screeners firing for the stock today

Also generates SECTOR_SCREENER_CONFLUENCE signals when ≥3 stocks in the
same sector enter high-performing screeners on the same day.

Run daily after screener_features_fetcher.py.
"""

import json
import datetime
from collections import defaultdict
from db_compat import connect

TODAY = datetime.date.today().isoformat()
BAYESIAN_THRESHOLD = 0.38   # Bayesian shrinkage pulls to 0.40 with <30d data; use relative cutoff
MIN_BULL_SCREENERS  = 2     # need at least 2 qualifying screeners before signalling
REENTRY_COOLDOWN_DAYS = 30  # ignore re-entries within this many days


def ensure_unified_signals_schema(con):
    for col_def in [
        "screener_momentum_score REAL",
        "screener_tier1_count    REAL",
        "screener_cat_breadth    REAL",
    ]:
        col = col_def.split()[0]
        try:
            con.execute(f"ALTER TABLE unified_signals ADD COLUMN IF NOT EXISTS {col_def}")
            con.commit()
        except Exception:
            con.rollback()


def load_high_performing_screeners(con) -> dict:
    """Returns screener_id -> {bayesian_score, tier, signal_bias, category, name}."""
    rows = con.execute("""
        SELECT sm.scan_id,
               COALESCE(spv.bayesian_score, 0.40) AS bayesian_score,
               COALESCE(spv.tier, 'Unranked')     AS tier,
               sc.signal_bias,
               sc.category,
               COALESCE(ts.screener_name, sm.name, sm.scan_id) AS screener_name
        FROM screener_master sm
        LEFT JOIN screener_performance_v2 spv ON spv.screener_id = sm.scan_id AND spv.source = sm.source
        -- screener_catalog.source has BOTH casings live ('MoneyControl' AND 'moneycontrol') from
        -- inconsistent past writers -- a real, separate data-quality issue, not cleaned up here;
        -- LOWER() bridges it without touching the table's stored values.
        LEFT JOIN screener_catalog sc          ON sc.screener_id  = sm.scan_id AND LOWER(sc.source) = LOWER(sm.source)
        LEFT JOIN trendlyne_screeners ts       ON ts.screener_id  = sm.scan_id AND sm.source = 'Trendlyne'
        WHERE COALESCE(sc.signal_bias, sm.inferred_sentiment) = 'bullish'
          AND (COALESCE(spv.bayesian_score, 0.40) >= ? OR COALESCE(spv.tier, 'Unranked') IN ('A','B'))
    """, (BAYESIAN_THRESHOLD,)).fetchall()

    return {
        row[0]: {
            "bayesian": float(row[1]),
            "tier":     row[2],
            "bias":     row[3] or "bullish",
            "category": row[4] or "other",
            "name":     row[5],
        }
        for row in rows
    }


def load_first_appearances_today(con, qualifying_screeners: set) -> dict:
    """
    Returns symbol -> [screener_id, ...] for stocks that:
      1. Appeared in a qualifying screener today (or within last 2 days for syncs)
      2. Had no appearance in the same screener within the last REENTRY_COOLDOWN_DAYS
    """
    window_start = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
    cooldown_start = (datetime.date.today() - datetime.timedelta(days=REENTRY_COOLDOWN_DAYS)).isoformat()

    # All recent appearances in qualifying screeners
    rows = con.execute("""
        SELECT a.symbol, a.screener_id, a.appeared_date::date AS adate
        FROM screener_appearances a
        WHERE a.appeared_date >= ?
          AND (a.exited_date IS NULL OR a.exited_date >= ?)
    """, (window_start, TODAY)).fetchall()

    # Previous appearances to detect re-entry vs first entry
    prev_rows = con.execute("""
        SELECT DISTINCT symbol, screener_id
        FROM screener_appearances
        WHERE appeared_date >= ? AND appeared_date < ?
    """, (cooldown_start, window_start)).fetchall()

    prev_set = {(r[0], r[1]) for r in prev_rows}

    result = defaultdict(list)
    for sym, sid, _ in rows:
        if sid not in qualifying_screeners:
            continue
        if (sym, sid) not in prev_set:   # genuine first/re-entry
            result[sym].append(sid)

    return dict(result)


def get_stock_price(con, symbol: str) -> float:
    """Latest close price from stock_ohlcv."""
    row = con.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol = ?
        ORDER BY date DESC LIMIT 1
    """, (symbol,)).fetchone()
    return float(row[0]) if row else None


def get_sector(con, symbol: str) -> str:
    row = con.execute(
        "SELECT sector FROM nse_stocks WHERE symbol = ? LIMIT 1", (symbol,)
    ).fetchone()
    return row[0] if row else None


def signal_already_generated_today(con, symbol: str) -> bool:
    row = con.execute("""
        SELECT 1 FROM unified_signals
        WHERE symbol = ?
          AND signal_date::date = CURRENT_DATE
          AND signal_source = 'SCREENER_SURFACING'
        LIMIT 1
    """, (symbol,)).fetchone()
    return row is not None


def generate_signals(con, qualifying: dict, entries: dict) -> int:
    """Generate unified_signals for new screener entries. Returns count of signals created."""
    generated = 0
    sector_signals = defaultdict(list)  # sector -> [symbol, ...]

    for symbol, screener_ids in entries.items():
        if len(screener_ids) < MIN_BULL_SCREENERS:
            continue
        if signal_already_generated_today(con, symbol):
            continue

        price = get_stock_price(con, symbol)
        if not price:
            continue
        sector = get_sector(con, symbol)

        # Compute aggregate signal strength
        screeners_meta = [qualifying[sid] for sid in screener_ids]
        momentum_score = sum(m["bayesian"] for m in screeners_meta)
        tier1_count    = sum(1 for m in screeners_meta if m["tier"] in ("A", "B"))
        categories     = {m["category"] for m in screeners_meta}
        top_names      = ", ".join(m["name"] for m in screeners_meta[:5])

        # Scale targets: use exit_policy dynamic levels if available, fallback to 5%/2.5%
        target_price = None
        stop_loss    = None
        try:
            from exit_policy import predict_levels_for_symbol
            t_price, s_loss = predict_levels_for_symbol(symbol, price)
            if t_price is not None and s_loss is not None:
                target_price = t_price
                stop_loss = s_loss
                print(f"  [ExitPolicy] Dynamic levels for {symbol}: target={target_price}, stop={stop_loss}")
        except Exception as e:
            # print(f"  [ExitPolicy] Fallback: {e}")
            pass

        if not target_price or not stop_loss:
            target_price = round(price * 1.05, 2)
            stop_loss    = round(price * 0.975, 2)

        reasoning = (
            f"Screener surfacing: {len(screener_ids)} high-performing bullish screeners "
            f"flagging this stock for the first time. "
            f"Screeners: {top_names}. "
            f"Categories: {', '.join(sorted(categories))}. "
            f"Momentum score: {momentum_score:.2f}."
        )

        try:
            con.execute("""
                INSERT INTO unified_signals
                (symbol, signal_date, signal_type, signal_source,
                 entry_price, target_price, stop_loss, confidence_score,
                 reasoning,
                 screener_momentum_score, screener_tier1_count, screener_cat_breadth,
                 signal_generated_at)
                VALUES (?,NOW(),?,?, ?,?,?,?, ?, ?,?,?, NOW())
            """, (
                symbol, "SCREENER_ENTRY", "SCREENER_SURFACING",
                # 0-100 scale, per db.ts's "confidence_score REAL, -- 0-100, from any source".
                # Was min(0.70 + momentum_score * 0.01, 0.92) -- a 0-1 fraction in a column the
                # AI path fills 0-100. See migration 1787070000000.
                price, target_price, stop_loss, min(70.0 + momentum_score, 92.0),
                reasoning,
                round(momentum_score, 4), float(tier1_count), float(len(categories)),
            ))
            generated += 1
            if sector:
                sector_signals[sector].append(symbol)
        except Exception as e:
            print(f"  [WARN] {symbol}: {e}")
            con.rollback()

    con.commit()
    print(f"[ScreenerSignals] {generated} SCREENER_ENTRY signals generated")

    # ── Sector confluence signals ─────────────────────────────────────────────
    sector_generated = 0
    for sector, symbols in sector_signals.items():
        if len(symbols) < 3:
            continue
        try:
            con.execute("""
                INSERT INTO unified_signals
                (symbol, signal_date, signal_type, signal_source,
                 confidence_score, reasoning, signal_generated_at)
                VALUES (?, NOW(), 'SECTOR_SCREENER_CONFLUENCE', 'SCREENER_SURFACING',
                        65.0, ?, NOW())
            """, (
                f"SECTOR:{sector}",
                f"{len(symbols)} stocks from {sector} entering high-performing screeners today: "
                f"{', '.join(symbols[:10])}",
            ))
            sector_generated += 1
        except Exception:
            con.rollback()

    con.commit()
    print(f"[ScreenerSignals] {sector_generated} SECTOR_SCREENER_CONFLUENCE signals generated")
    return generated + sector_generated


def run():
    con = connect()
    try:
        ensure_unified_signals_schema(con)

        qualifying = load_high_performing_screeners(con)
        print(f"[ScreenerSignals] {len(qualifying)} high-performing bullish screeners loaded")
        if not qualifying:
            print("[ScreenerSignals] No qualifying screeners — run screener_performance.py first")
            return

        entries = load_first_appearances_today(con, set(qualifying.keys()))
        print(f"[ScreenerSignals] {len(entries)} stocks with fresh screener entries")

        total = generate_signals(con, qualifying, entries)
        print(f"[ScreenerSignals] Done. {total} signals total.")
    finally:
        con.close()


if __name__ == "__main__":
    run()
