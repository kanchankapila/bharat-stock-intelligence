#!/usr/bin/env python3
"""
Screener Features Fetcher
=========================
Computes per-stock screener-derived ML features from screener_appearances +
screener_performance_v2 + screener_catalog and stamps them into technical_signals.

Features written (all into technical_signals):
  screener_bull_count     -- # bullish screeners flagging this stock today
  screener_bear_count     -- # bearish screeners flagging this stock today
  screener_cat_breadth    -- # distinct inferred_categories firing today (0-19)
  screener_tier1_count    -- # tier-A/B screeners (bayesian_score > 0.50)
  screener_momentum_score -- weighted bull count (weight = bayesian_score)
  screener_streak_days    -- max consecutive days in any single screener (from screener_history_log)
  screener_name_signal    -- 0/1/2 = bear/neutral/bull keyword from best screener name NLP
  screener_alpha_score    -- mean alpha_20d of all bullish screeners flagging this stock

Run daily after screener sync.
"""

import re
import time
import datetime
from collections import defaultdict
from db_compat import connect

# ── NLP keyword mappings for screener names ──────────────────────────────────

BULL_KEYWORDS = [
    "breakout", "bullish", "buy", "golden cross", "uptrend", "outperform",
    "momentum", "accumulate", "strong", "growth", "rising", "upgrade",
    "52.week.high", "all.time.high", "macd.bullish", "rsi.bullish",
    "above.*sma", "ema.*cross", "volume.*surge", "delivery.*up",
    "high.dvm", "dvm.high", "fundamental.*strong", "quality",
    "positive.turnaround", "earnings.beat", "analyst.upgrade",
    "insider.*buy", "fii.*buy", "promoter.*buy", "fresh.break",
    "support.*hold", "reversal", "double.bottom", "cup.handle",
    "ascending.triangle", "flag.pattern", "rs.leader",
]

BEAR_KEYWORDS = [
    "bearish", "sell", "breakdown", "death cross", "downtrend", "underperform",
    "overbought", "caution", "avoid", "declining", "weak", "falling",
    "low.dvm", "dvm.low", "momentum.trap", "value.trap", "wealth.destroy",
    "below.*sma", "macd.bearish", "rsi.bearish", "red.flag",
    "distribution", "negative.turnaround", "earnings.miss", "analyst.downgrade",
    "insider.*sell", "promoter.*sell",
]

def _name_to_signal(name: str) -> float:
    """Returns 2.0=bull, 1.0=neutral, 0.0=bear from screener name keywords."""
    t = name.lower()
    for pat in BEAR_KEYWORDS:
        # escape dots only when they are literal word separators (not inside regex like .*)
        safe = pat if any(c in pat for c in r"()*+?[]{}^$|\\") else re.escape(pat).replace(r"\.", r"[\s\-]?")
        if re.search(safe, t):
            return 0.0
    for pat in BULL_KEYWORDS:
        safe = pat if any(c in pat for c in r"()*+?[]{}^$|\\") else re.escape(pat).replace(r"\.", r"[\s\-]?")
        if re.search(safe, t):
            return 2.0
    return 1.0


# ── Schema ───────────────────────────────────────────────────────────────────

COLS = [
    "screener_bull_count    REAL",
    "screener_bear_count    REAL",
    "screener_cat_breadth   REAL",
    "screener_tier1_count   REAL",
    "screener_momentum_score REAL",
    "screener_streak_days   REAL",
    "screener_name_signal   REAL",
    "screener_alpha_score   REAL",
]

def ensure_schema(con):
    for col_def in COLS:
        col_name = col_def.split()[0]
        try:
            con.execute(f"ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS {col_def}")
            con.commit()
        except Exception:
            con.rollback()


# ── Data loading ─────────────────────────────────────────────────────────────

def load_screener_meta(con) -> dict:
    """
    Returns dict: screener_id -> {sentiment, inferred_category, bayesian_score,
                                   alpha_20d, tier, screener_name}
    """
    rows = con.execute("""
        SELECT sm.scan_id,
               sm.inferred_sentiment,
               sm.inferred_category,
               COALESCE(spv.bayesian_score, 0.40) AS bayesian_score,
               spv.alpha_20d,
               COALESCE(spv.tier, 'Unranked')    AS tier,
               COALESCE(ts.screener_name, sm.name, sm.scan_id) AS screener_name
        FROM screener_master sm
        LEFT JOIN screener_performance_v2 spv ON spv.screener_id = sm.scan_id
        LEFT JOIN trendlyne_screeners ts       ON ts.screener_id = sm.scan_id
    """).fetchall()

    meta = {}
    for row in rows:
        meta[row[0]] = {
            "sentiment":  row[1] or "neutral",
            "category":   row[2] or "other",
            "bayesian":   float(row[3] or 0.40),
            "alpha_20d":  float(row[4]) if row[4] is not None else None,
            "tier":       row[5],
            "name":       row[6] or row[0],
        }
    return meta


def load_today_appearances(con, as_of: str) -> dict:
    """
    Returns dict: symbol -> [screener_id, ...] that are active (appeared_date <= as_of, exited_date IS NULL or future).
    Uses the most-recent 3-day window so same-day re-syncs are captured.
    """
    cutoff = (datetime.date.fromisoformat(as_of) - datetime.timedelta(days=3)).isoformat()
    rows = con.execute("""
        SELECT symbol, screener_id
        FROM screener_appearances
        WHERE appeared_date >= ?
          AND (exited_date IS NULL OR exited_date >= ?)
    """, (cutoff, as_of)).fetchall()

    result = defaultdict(list)
    for sym, sid in rows:
        result[sym].append(sid)
    return result


def load_streaks(con) -> dict:
    """Returns symbol -> max_streak_days from screener_history_log."""
    rows = con.execute("""
        SELECT symbol,
               MAX(
                 CASE
                   WHEN exit_date IS NULL THEN
                     (CURRENT_DATE - entry_date::date)
                   ELSE
                     (exit_date::date - entry_date::date)
                 END
               ) AS max_streak
        FROM screener_history_log
        GROUP BY symbol
    """).fetchall()
    return {row[0]: int(row[1] or 0) for row in rows}


# ── Feature computation ───────────────────────────────────────────────────────

def compute_features(symbol: str, screener_ids: list, meta: dict) -> dict:
    bull_count = 0
    bear_count = 0
    categories = set()
    tier1_count = 0
    momentum = 0.0
    alpha_vals = []
    name_signals = []

    for sid in screener_ids:
        m = meta.get(sid)
        if not m:
            continue
        sentiment = m["sentiment"]
        bayes     = m["bayesian"]
        tier      = m["tier"]
        alpha     = m["alpha_20d"]
        name_sig  = _name_to_signal(m["name"])

        if sentiment == "bullish" or name_sig == 2.0:
            bull_count += 1
            momentum   += bayes
            if alpha is not None:
                alpha_vals.append(alpha)
        elif sentiment == "bearish" or name_sig == 0.0:
            bear_count += 1

        categories.add(m["category"])
        if tier in ("A", "B"):
            tier1_count += 1
        name_signals.append(name_sig)

    best_name_signal = max(name_signals) if name_signals else 1.0
    alpha_score = round(sum(alpha_vals) / len(alpha_vals), 4) if alpha_vals else None

    return {
        "screener_bull_count":     float(bull_count),
        "screener_bear_count":     float(bear_count),
        "screener_cat_breadth":    float(len(categories)),
        "screener_tier1_count":    float(tier1_count),
        "screener_momentum_score": round(momentum, 4),
        "screener_name_signal":    best_name_signal,
        "screener_alpha_score":    alpha_score,
    }


# ── Stamp into technical_signals ─────────────────────────────────────────────

def stamp_features(con, features_by_symbol: dict, streaks: dict):
    updated = 0
    for symbol, feats in features_by_symbol.items():
        streak = streaks.get(symbol, 0)
        try:
            con.execute("""
                UPDATE technical_signals
                SET screener_bull_count     = ?,
                    screener_bear_count     = ?,
                    screener_cat_breadth    = ?,
                    screener_tier1_count    = ?,
                    screener_momentum_score = ?,
                    screener_streak_days    = ?,
                    screener_name_signal    = ?,
                    screener_alpha_score    = ?
                WHERE symbol = ?
                  AND date = (SELECT MAX(date) FROM technical_signals t2
                              WHERE t2.symbol = technical_signals.symbol)
            """, (
                feats["screener_bull_count"],
                feats["screener_bear_count"],
                feats["screener_cat_breadth"],
                feats["screener_tier1_count"],
                feats["screener_momentum_score"],
                float(streak),
                feats["screener_name_signal"],
                feats["screener_alpha_score"],
                symbol,
            ))
            updated += 1
        except Exception as e:
            print(f"  [WARN] {symbol}: {e}")
    return updated


# ── Main ─────────────────────────────────────────────────────────────────────

def run():
    con = connect()
    try:
        ensure_schema(con)
        as_of = datetime.date.today().isoformat()

        print(f"[ScreenerFeatures] Loading screener metadata...")
        meta = load_screener_meta(con)
        print(f"[ScreenerFeatures] {len(meta)} screeners loaded")

        print(f"[ScreenerFeatures] Loading today's appearances (window: {as_of})...")
        appearances = load_today_appearances(con, as_of)
        print(f"[ScreenerFeatures] {len(appearances)} symbols active in screeners")

        print(f"[ScreenerFeatures] Loading streaks...")
        streaks = load_streaks(con)

        features_by_symbol = {}
        for symbol, screener_ids in appearances.items():
            features_by_symbol[symbol] = compute_features(symbol, screener_ids, meta)

        print(f"[ScreenerFeatures] Stamping features for {len(features_by_symbol)} symbols...")
        n = stamp_features(con, features_by_symbol, streaks)
        con.commit()
        print(f"[ScreenerFeatures] Done. {n} symbols updated in technical_signals.")

        # Quick stats
        bull_sum  = sum(f["screener_bull_count"] for f in features_by_symbol.values())
        bear_sum  = sum(f["screener_bear_count"] for f in features_by_symbol.values())
        top10 = sorted(features_by_symbol.items(),
                       key=lambda x: x[1]["screener_momentum_score"], reverse=True)[:10]
        print(f"[ScreenerFeatures] Market breadth: {int(bull_sum)} bull-flags / {int(bear_sum)} bear-flags")
        print(f"[ScreenerFeatures] Top 10 by momentum_score:")
        for sym, f in top10:
            print(f"  {sym}: momentum={f['screener_momentum_score']:.2f} "
                  f"bull={int(f['screener_bull_count'])} cat_breadth={int(f['screener_cat_breadth'])} "
                  f"streak={int(streaks.get(sym, 0))}d")

    finally:
        con.close()


if __name__ == "__main__":
    run()
