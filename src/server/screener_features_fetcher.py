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

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class ScreenerFeaturesFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class ScreenerFeaturesFetcherBaseFetcher(BaseFetcher[ScreenerFeaturesFetcherSchema]):
    fetcher_name = 'ScreenerFeaturesFetcher'
    domain = 'general'
    schema = ScreenerFeaturesFetcherSchema
    min_interval_sec = 0.5


import re
import time
import datetime
from collections import defaultdict
from db_compat import connect
from as_of import logical_trading_date
import sys

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

def load_screener_meta(con, as_of: str | None = None) -> dict:
    """
    Returns dict: screener_id -> {sentiment, inferred_category, bayesian_score,
                                   alpha_20d, tier, screener_name}

    bayesian_score is the WEIGHT used to build screener_momentum_score, so it must be the
    score as it stood on `as_of` -- screener_performance_v2 holds a single full-sample value
    whose use on a historical row leaks future performance into the feature. Reads the newest
    screener_performance_history snapshot <= as_of, and only falls back to the current
    full-sample score when no PIT snapshot exists yet (bootstrap).
    """
    # Source-scoped (2026-08-06 fix, closes the gap this comment used to flag): screener_
    # performance_history's PK was migrated to (source, screener_id, as_of_date) on 2026-08-05
    # (same cross-provider scan_id collision class as the 2026-08-04 screener_master fix -- MC
    # and ETnow independently issue overlapping small-integer scan_ids, confirmed live), and its
    # writer (screener_performance.py's phase_f_pit) now populates that column. pit[] is keyed
    # by (source, screener_id) to match -- source here is screener_performance_history's own
    # stored value, which mirrors screener_appearances' lowercase convention
    # ('moneycontrol'/'etnow'/'trendlyne'/'et_marketstats'), so it's looked up below via
    # src.lower() against screener_master's mixed-case source, same bridge `meta`'s own key
    # already uses.
    pit = {}
    if as_of:
        try:
            for source, sid, score, tier, alpha in con.execute("""
                SELECT DISTINCT ON (source, screener_id) source, screener_id, bayesian_score, tier, alpha_20d
                FROM screener_performance_history
                WHERE as_of_date <= ?
                ORDER BY source, screener_id, as_of_date DESC
            """, (as_of,)).fetchall():
                pit[(source, sid)] = (score, tier, alpha)
        except Exception as e:
            print(f"[ScreenerFeatures] PIT scores unavailable ({e}); "
                  f"falling back to full-sample bayesian_score", file=sys.stderr)

    # sm.source is required on both joins: MC and ETnow independently hand out overlapping
    # small-integer scan_ids (see the 2026-08-04 screener_master memory) -- an unscoped join
    # against screener_performance_v2 could pick up a different provider's win-rate stats for
    # the same numeric scan_id, and an unscoped join against trendlyne_screeners could label an
    # MC/ETnow screener with an unrelated Trendlyne screener's name.
    rows = con.execute("""
        SELECT sm.scan_id,
               sm.source,
               sm.inferred_sentiment,
               sm.inferred_category,
               COALESCE(spv.bayesian_score, 0.40) AS bayesian_score,
               spv.alpha_20d,
               COALESCE(spv.tier, 'Unranked')    AS tier,
               COALESCE(ts.screener_name, sm.name, sm.scan_id) AS screener_name
        FROM screener_master sm
        LEFT JOIN screener_performance_v2 spv ON spv.screener_id = sm.scan_id AND spv.source = sm.source
        LEFT JOIN trendlyne_screeners ts       ON ts.screener_id = sm.scan_id AND sm.source = 'Trendlyne'
    """).fetchall()

    # meta is keyed by (source.lower(), scan_id) -- lowercased because screener_appearances.source
    # (the table compute_features' caller ultimately reads scan_ids from) uses lowercase
    # ('moneycontrol') while screener_master.source does not ('MoneyControl'/'ETnow'/'Trendlyne')
    # -- a pre-existing casing mismatch between the two tables, bridged here rather than by
    # normalizing either table's actual stored values.
    meta = {}
    for row in rows:
        sid, src = row[0], row[1]
        p = pit.get((src.lower(), sid))
        meta[(src.lower(), sid)] = {
            "sentiment":  row[2] or "neutral",
            "category":   row[3] or "other",
            "bayesian":   float(p[0]) if p and p[0] is not None else float(row[4] or 0.40),
            "alpha_20d":  (float(p[2]) if p[2] is not None else None) if p
                          else (float(row[5]) if row[5] is not None else None),
            "tier":       (p[1] if p else None) or row[6],
            "name":       row[7] or row[0],
            "pit":        bool(p),
        }
    if as_of:
        n_pit = sum(1 for m in meta.values() if m.get("pit"))
        print(f"[ScreenerFeatures] as_of={as_of}: {n_pit}/{len(meta)} screeners "
              f"using point-in-time bayesian_score")
    return meta


def ensure_snapshot_schema(con) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS screener_membership_snapshot (
            as_of_date  TEXT NOT NULL,
            symbol      TEXT NOT NULL,
            screener_id TEXT NOT NULL,
            PRIMARY KEY (as_of_date, symbol, screener_id)
        )
    """)
    con.execute("""CREATE INDEX IF NOT EXISTS idx_sms_date
                   ON screener_membership_snapshot (as_of_date)""")
    con.commit()


def snapshot_membership(con, as_of: str, appearances: dict) -> int:
    """Record the EXACT membership set used to build today's features.

    screener_appearances is mutated in place -- exited_date is backfilled when a symbol
    leaves, and new appearance rows arrive continuously -- so reconstructing "who was in
    which screener on date D" from it later does NOT reproduce what the job actually saw.
    Measured 2026-07-31: rebuilding screener_momentum_score for 2026-07-20 with the
    production compute_features() gave corr 0.672 / 2.1% exact match against the stored
    values, with the stored mean ~3x the rebuilt one. The precise divergence mechanism was
    NOT isolated -- so rather than guess at it, this makes the question moot: the inputs are
    written down immutably at the moment they are used, and every future feature value is
    exactly reproducible by construction.

    ~42k rows/day at current screener coverage.
    """
    ensure_snapshot_schema(con)
    n = 0
    for symbol, ids in appearances.items():
        # ids is now [(source, screener_id), ...] -- this table has no source column (a
        # separate, undone follow-up, see load_screener_meta's pit[] comment above), so only
        # screener_id is recorded here; set() dedupes on the full tuple, which is correct since
        # the same scan_id from two different sources is two distinct memberships.
        for src, sid in set(ids):
            con.execute(
                "INSERT INTO screener_membership_snapshot (as_of_date, symbol, screener_id) "
                "VALUES (?,?,?) ON CONFLICT (as_of_date, symbol, screener_id) DO NOTHING",
                (as_of, symbol, sid))
            n += 1
    con.commit()
    return n


def load_today_appearances(con, as_of: str) -> dict:
    """
    Returns dict: symbol -> [(source, screener_id), ...] that are active (appeared_date <= as_of,
    exited_date IS NULL or future). Uses the most-recent 3-day window so same-day re-syncs are
    captured. source is required alongside screener_id (not screener_id alone) so compute_features
    can look up the right provider's screener_master row when scan_ids collide across providers
    (see the 2026-08-04 screener_master memory) -- screener_appearances.source is already
    lowercase, matching load_screener_meta's meta dict keys.
    """
    cutoff = (datetime.date.fromisoformat(as_of) - datetime.timedelta(days=3)).isoformat()
    rows = con.execute("""
        SELECT symbol, screener_id, source
        FROM screener_appearances
        WHERE appeared_date >= ?
          AND (exited_date IS NULL OR exited_date >= ?)
    """, (cutoff, as_of)).fetchall()

    result = defaultdict(list)
    for sym, sid, src in rows:
        result[sym].append((src, sid))
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

    # screener_ids is [(source, screener_id), ...] -- source is required to disambiguate
    # scan_ids that collide across providers (see load_today_appearances/load_screener_meta).
    for src, sid in screener_ids:
        m = meta.get((src, sid))
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
    # date = ? guard (2026-07-19) instead of MAX(date) -- see bse_event_classifier.py's
    # run_daily docstring for why matching the latest row isn't the same as matching today.
    # logical_trading_date(), not date.today() (2026-08-01) -- this is the largest single
    # engine weight in unified_ranker; ml-daily-ops's step chain regularly finishes after
    # midnight IST, so a raw wall-clock date silently targeted a day with no grid row yet.
    today = logical_trading_date()
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
                WHERE symbol = ? AND date = ?
            """, (
                feats["screener_bull_count"],
                feats["screener_bear_count"],
                feats["screener_cat_breadth"],
                feats["screener_tier1_count"],
                feats["screener_momentum_score"],
                float(streak),
                feats["screener_name_signal"],
                feats["screener_alpha_score"],
                symbol, today,
            ))
            updated += 1
        except Exception as e:
            print(f"  [WARN] {symbol}: {e}", file=sys.stderr)
    return updated


# ── Main ─────────────────────────────────────────────────────────────────────

def run():
    con = connect()
    try:
        ensure_schema(con)
        # logical_trading_date(), not date.today() -- keeps the membership snapshot/appearances
        # window consistent with stamp_features()'s own write target above.
        as_of = logical_trading_date()

        print(f"[ScreenerFeatures] Loading screener metadata...")
        meta = load_screener_meta(con, as_of)
        print(f"[ScreenerFeatures] {len(meta)} screeners loaded")

        print(f"[ScreenerFeatures] Loading today's appearances (window: {as_of})...")
        appearances = load_today_appearances(con, as_of)
        print(f"[ScreenerFeatures] {len(appearances)} symbols active in screeners")

        # Immutable record of the inputs, written BEFORE the features are computed from them.
        try:
            n_snap = snapshot_membership(con, as_of, appearances)
            print(f"[ScreenerFeatures] snapshotted {n_snap} (symbol, screener) memberships "
                  f"for {as_of}")
        except Exception as e:
            print(f"[ScreenerFeatures] membership snapshot failed: {e}", file=sys.stderr)

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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
