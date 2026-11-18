#!/usr/bin/env python3
"""
Data-integrity repairs from the 2026-07-30 bias audit
(docs/audit-2026-07-30/DATA_BIAS_AND_QUANT_STRATEGY_AUDIT.md [removed 2026-10-03; see git history]).

Each repair is idempotent and can be run independently:

  --bad-bars        flag physically-impossible stock_ohlcv bars (is_suspect)
  --adjustment      backfill the untagged adjustment_basis column
  --insider-dates   convert insider_trades.date from "22 May, 2026" to ISO
  --closed-sessions flag stock_ohlcv bars from days the exchange never opened (flat zero-volume
                    or a copy of the previous session), purge their feature_store/technical_signals rows
  --unlisted-symbols flag stock_ohlcv bars of the evidenced non-NSE symbols
  --holidays        populate market_holidays from observed trading gaps
  --news-link       build an indexed news_symbol_link table from symbols_json
  --labels          add label_definition/producer to signal_outcomes + flag implausible returns
  --feature-store-columns  add feature_store flow/fundamental columns feature_engineering writes
  --nan-recommendations  delete unified_recommendations rows with a non-finite unified_score
  --ghost-recommendations delete unified_recommendations rows for symbols with no price history
  --weekend-recommendations delete unified_recommendations snapshots dated to a closed day
  --zero-neutral-outcomes requeue stale synthetic 0% neutral outcomes with no exit price
  --delivery-trades NULL stock_delivery_data.trades where it duplicates delivery_qty
  --dl-performance-sentinels NULL the unit-test sentinel roc_auc/directional_accuracy pair
  --all             run everything

Run:  python data_integrity_repair.py --all [--dry-run]
"""
import argparse
import datetime
import os
import json
import re

from db_compat import connect, ConnWrapper
from sql_translate import use_postgres
from hypertable_safe_write import safe_keyed_update

# A bar is physically impossible if OHLC is internally inconsistent, or if it implies a
# 1-day move beyond what NSE circuit limits allow, with no corporate action to explain it.
# 25% leaves headroom over the 20% band for F&O names (no band) and for legitimate
# split/bonus adjustments that slipped past the corporate_actions join.
MAX_PLAUSIBLE_1D_MOVE = 0.25


def _log(msg):
    print(f"[DataRepair] {msg}", flush=True)


# ── 1. Bad-bar quarantine ────────────────────────────────────────────────────

def _find_bad_bars(conn: ConnWrapper) -> dict:
    """Return {(symbol, date): reason} for every physically-impossible bar."""
    found = {}
    checks = [
        ("ohlc_inconsistent",
         "close > high OR close < low OR open > high OR open < low OR high < low"),
        ("nonpositive_price",
         "close <= 0 OR open <= 0 OR high <= 0 OR low <= 0"),
    ]
    for reason, pred in checks:
        rows = conn.execute(
            f"SELECT symbol, date::text FROM stock_ohlcv WHERE ({pred})").fetchall()
        _log(f"  {reason}: {len(rows)} bars")
        for s, d in rows:
            found.setdefault((s, d), reason)

    # Impossible 1-day moves, excluding bars explained by a corporate action.
    rows = conn.execute("""
        WITH w AS (
            SELECT symbol, date, close,
                   LAG(close) OVER (PARTITION BY symbol ORDER BY date) AS prev_close
            FROM stock_ohlcv
        )
        SELECT w.symbol, w.date::text
        FROM w
        WHERE w.prev_close > 0
          AND abs(w.close / w.prev_close - 1.0) > ?
          AND NOT EXISTS (
              SELECT 1 FROM corporate_actions ca
              WHERE ca.symbol = w.symbol
                AND ca.ex_date::text BETWEEN (w.date::date - 3)::text AND (w.date::date + 3)::text
          )
    """, (MAX_PLAUSIBLE_1D_MOVE,)).fetchall()
    _log(f"  impossible_move: {len(rows)} bars (no corporate action within +/-3d)")
    for s, d in rows:
        found.setdefault((s, d), 'impossible_move')
    return found


def repair_bad_bars(conn: ConnWrapper, dry: bool) -> None:
    _log("bad bars: ensuring stock_ohlcv.is_suspect ...")
    conn.execute("ALTER TABLE stock_ohlcv ADD COLUMN IF NOT EXISTS is_suspect SMALLINT DEFAULT 0")
    conn.execute("ALTER TABLE stock_ohlcv ADD COLUMN IF NOT EXISTS suspect_reason TEXT")
    conn.commit()

    found = _find_bad_bars(conn)
    _log(f"  total impossible bars: {len(found)}")
    if not found or dry:
        return

    done = safe_keyed_update(
        conn,
        "UPDATE stock_ohlcv SET is_suspect=1, suspect_reason=? WHERE symbol=? AND date::text=?",
        [(reason, sym, dt) for (sym, dt), reason in found.items()],
        batch_size=50)
    _log(f"  flagged {done} bars")

    total = conn.execute("SELECT count(*) FROM stock_ohlcv WHERE is_suspect=1").fetchone()[0]
    by_reason = conn.execute(
        "SELECT suspect_reason, count(*) FROM stock_ohlcv WHERE is_suspect=1 "
        "GROUP BY 1 ORDER BY 2 DESC").fetchall()
    _log(f"  total flagged in table: {total}  {dict(by_reason)}")


# ── 2. adjustment_basis backfill ─────────────────────────────────────────────

def repair_adjustment_basis(conn: ConnWrapper, dry: bool) -> None:
    """Make the untagged 99.99% of stock_ohlcv interpretable WITHOUT rewriting 2.6M rows.

    Backfilling the column would force TimescaleDB to decompress 21 of 24 chunks to write a
    metadata tag -- a bad trade that permanently costs the compression. Instead: every
    currently-NULL row provably came from the mc_ohlcv_backfill path (split-adjusted, NOT
    dividend-adjusted), so we pin that as the column DEFAULT, record the convention in a
    column comment, and let readers resolve NULL via ohlcv_adjustment_basis().
    """
    _log("adjustment_basis: pinning the NULL convention ...")
    n = conn.execute("SELECT count(*) FROM stock_ohlcv WHERE adjustment_basis IS NULL").fetchone()[0]
    _log(f"  untagged (historical mc_ohlcv_backfill) rows: {n}")
    if dry:
        return
    conn.execute("ALTER TABLE stock_ohlcv ALTER COLUMN adjustment_basis SET DEFAULT 'split_only'")
    conn.execute("""COMMENT ON COLUMN stock_ohlcv.adjustment_basis IS
        'split_only | split_dividend | unadjusted. NULL means split_only: every NULL row
         predates tagging and came from mc_ohlcv_backfill.py, which is split-adjusted but
         not dividend-adjusted. Not backfilled in place because the table is a compressed
         hypertable. Resolve with ohlcv_adjustment_basis(adjustment_basis).'""")
    conn.execute("""
        CREATE OR REPLACE FUNCTION ohlcv_adjustment_basis(b TEXT) RETURNS TEXT
        AS $$ SELECT COALESCE(b, 'split_only') $$ LANGUAGE SQL IMMUTABLE
    """)
    conn.commit()
    dist = conn.execute(
        "SELECT ohlcv_adjustment_basis(adjustment_basis), count(*) "
        "FROM stock_ohlcv GROUP BY 1 ORDER BY 2 DESC").fetchall()
    _log(f"  resolved distribution: {dict(dist)}")


# ── 3. insider_trades date normalisation ─────────────────────────────────────

_MONTHS = {m: i for i, m in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 1)}


def parse_loose_date(s: str):
    """'22 May, 2026' / '22 May 2026' / '2026-05-22' -> date, else None."""
    if not s:
        return None
    s = str(s).strip()
    if re.match(r'^\d{4}-\d{2}-\d{2}', s):
        try:
            return datetime.date.fromisoformat(s[:10])
        except ValueError:
            return None
    m = re.match(r'^(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})', s)
    if m:
        d, mon, y = int(m.group(1)), _MONTHS.get(m.group(2).lower()), int(m.group(3))
        if mon:
            try:
                return datetime.date(y, mon, d)
            except ValueError:
                return None
    return None


def repair_insider_dates(conn: ConnWrapper, dry: bool) -> None:
    _log("insider_trades: normalising date to ISO ...")
    conn.execute("ALTER TABLE insider_trades ADD COLUMN IF NOT EXISTS date_iso TEXT")
    conn.commit()
    rows = conn.execute(
        "SELECT id, date FROM insider_trades WHERE date_iso IS NULL AND date IS NOT NULL").fetchall()
    _log(f"  rows to convert: {len(rows)}")
    ok = bad = 0
    updates = []
    for rid, raw in rows:
        d = parse_loose_date(raw)
        if d:
            updates.append((d.isoformat(), rid)); ok += 1
        else:
            bad += 1
    if updates and not dry:
        for i in range(0, len(updates), 1000):
            for iso, rid in updates[i:i + 1000]:
                conn.execute("UPDATE insider_trades SET date_iso=? WHERE id=?", (iso, rid))
            conn.commit()
    conn.execute("CREATE INDEX IF NOT EXISTS idx_insider_date_iso ON insider_trades (date_iso)")
    conn.commit()
    _log(f"  converted={ok} unparseable={bad}")


# ── 4. market_holidays ───────────────────────────────────────────────────────

def repair_holidays(conn: ConnWrapper, dry: bool) -> None:
    _log("market_holidays: deriving from observed trading gaps ...")
    # Table already exists with (date, exchange NOT NULL, description) -- match it rather
    # than inventing a second shape.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS market_holidays (
            date        TEXT NOT NULL,
            exchange    TEXT NOT NULL,
            description TEXT,
            PRIMARY KEY (date, exchange)
        )
    """)
    conn.commit()
    # A date counts as traded only if it has at least one bar NOT flagged as a fabricated
    # closed session. Without this exclusion the derivation is circular: a holiday on which
    # a live-quote refresh wrote flat zero-volume bars looks "traded" and can never be
    # recognised as a holiday again (AF-20260911-15).
    traded = {str(r[0])[:10] for r in
              conn.execute(
                  "SELECT DISTINCT date FROM stock_ohlcv "
                  "WHERE suspect_reason IS DISTINCT FROM ?",
                  (CLOSED_SESSION_REASON,)).fetchall()}
    if not traded:
        _log("  no OHLCV dates; skipping")
        return
    start = datetime.date.fromisoformat(min(traded))
    end = datetime.date.fromisoformat(max(traded))
    hols = []
    d = start
    while d <= end:
        if d.weekday() < 5 and d.isoformat() not in traded:
            hols.append(d.isoformat())
        d += datetime.timedelta(days=1)
    _log(f"  weekday non-trading dates found: {len(hols)} between {start} and {end}")
    if not dry:
        for h in hols:
            conn.execute(
                "INSERT INTO market_holidays (date, exchange, description) VALUES (?,?,?) "
                "ON CONFLICT(date, exchange) DO NOTHING",
                (h, 'NSE', 'derived: no trading observed in stock_ohlcv'))
        conn.commit()
    n = conn.execute("SELECT count(*) FROM market_holidays").fetchone()[0]
    _log(f"  market_holidays now has {n} rows")


# ── 5. news symbol linkage ───────────────────────────────────────────────────

def repair_news_link(conn: ConnWrapper, dry: bool) -> None:
    _log("news_symbol_link: normalising symbols_json ...")
    # news_sentiment_items.id is a TEXT content hash, not an integer. An earlier revision of
    # this script created news_id as BIGINT; CREATE TABLE IF NOT EXISTS would silently keep
    # the wrong type, so correct it explicitly.
    wrong = conn.execute("""
        SELECT data_type FROM information_schema.columns
        WHERE table_name='news_symbol_link' AND column_name='news_id'
          AND table_schema = current_schema()
    """).fetchone()
    if wrong and wrong[0] != 'text':
        _log(f"  news_id has type {wrong[0]}, expected text -- recreating table")
        if not dry:
            conn.execute("DROP TABLE news_symbol_link")
            conn.commit()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS news_symbol_link (
            news_id      TEXT NOT NULL,
            symbol       TEXT NOT NULL,
            published_at TIMESTAMPTZ,
            sentiment_score REAL,
            PRIMARY KEY (news_id, symbol)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nsl_symbol_pub ON news_symbol_link (symbol, published_at)")
    conn.commit()

    # Only link to symbols that exist in the master, so the table can be joined straight
    # onto the feature matrix. Tags like 'GLOBAL'/'NIFTY' pass a ticker-shaped regex but
    # are not tradeable instruments and would create phantom per-stock news features.
    known = {r[0] for r in conn.execute("SELECT symbol FROM nse_stocks").fetchall()}
    _log(f"  master symbols: {len(known)}")

    rows = conn.execute("""
        SELECT id, symbols_json, COALESCE(published_at, fetched_at), sentiment_score
        FROM news_sentiment_items
        WHERE symbols_json IS NOT NULL AND symbols_json NOT IN ('', '[]')
    """).fetchall()
    _log(f"  news items with symbols: {len(rows)}")
    pairs, skipped = [], 0
    for nid, sj, pub, score in rows:
        try:
            syms = json.loads(sj) if isinstance(sj, str) else sj
        except Exception:
            continue
        if not isinstance(syms, list):
            continue
        for s in syms:
            if not isinstance(s, str):
                continue
            u = s.strip().upper()
            if not re.match(r'^[A-Z][A-Z0-9&\-]{1,19}$', u):
                continue
            if u not in known:
                skipped += 1
                continue
            pairs.append((str(nid), u, pub, score))
    _log(f"  extracted {len(pairs)} (news, symbol) pairs; {skipped} non-master tags skipped")
    if pairs and not dry:
        for i in range(0, len(pairs), 1000):
            for p in pairs[i:i + 1000]:
                conn.execute(
                    "INSERT INTO news_symbol_link (news_id, symbol, published_at, sentiment_score) "
                    "VALUES (?,?,?,?) ON CONFLICT(news_id, symbol) DO NOTHING", p)
            conn.commit()
    n = conn.execute("SELECT count(*) FROM news_symbol_link").fetchone()[0]
    d = conn.execute("SELECT count(DISTINCT symbol) FROM news_symbol_link").fetchone()[0]
    _log(f"  news_symbol_link: {n} rows, {d} distinct symbols")


# ── 6. signal_outcomes label hygiene ─────────────────────────────────────────

# h3/7/14/30 were written with a fixed +/-2% terminal-return barrier; h1/5/15 with a
# path-based MFE/stop rule whose NEUTRAL band overlaps its own WIN/LOSS regions. Pooling
# them trains one model on two different questions.
TERMINAL_HORIZONS = (3, 7, 14, 30)
PATH_HORIZONS = (1, 5, 15)
MAX_PLAUSIBLE_RETURN_PCT = 100.0


def repair_labels(conn: ConnWrapper, dry: bool) -> None:
    _log("signal_outcomes: tagging label definitions ...")
    conn.execute("ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS label_definition TEXT")
    conn.execute("ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS is_suspect SMALLINT DEFAULT 0")
    conn.commit()
    if not dry:
        conn.execute(
            "UPDATE signal_outcomes SET label_definition='terminal_pct2' "
            "WHERE horizon_days IN (%s) AND label_definition IS NULL"
            % ",".join(str(h) for h in TERMINAL_HORIZONS))
        conn.execute(
            "UPDATE signal_outcomes SET label_definition='path_barrier' "
            "WHERE horizon_days IN (%s) AND label_definition IS NULL"
            % ",".join(str(h) for h in PATH_HORIZONS))
        conn.execute(
            "UPDATE signal_outcomes SET label_definition='unknown' WHERE label_definition IS NULL")
        conn.execute(
            "UPDATE signal_outcomes SET is_suspect=1 WHERE abs(return_pct) > ?",
            (MAX_PLAUSIBLE_RETURN_PCT,))
        # signal_source backfill (2026-08): inferred from label_definition, not a guess -- the
        # mechanism traced live (both writers' dedup guards used to match on ANY row for a key
        # regardless of source, so each horizon bucket was claimed by exactly one writer for its
        # entire history: label_definition='path_barrier' rows were always written by
        # outcome_resolver.py grading technical_signals; 'terminal_pct2' rows were always
        # written by confluence_outcome_tracker.py grading confluence_signals. Only rows already
        # written by the fixed writers (signal_source already set) are left untouched.
        conn.execute(
            "UPDATE signal_outcomes SET signal_source='technical' "
            "WHERE label_definition='path_barrier' AND signal_source='unknown'")
        conn.execute(
            "UPDATE signal_outcomes SET signal_source='confluence' "
            "WHERE label_definition='terminal_pct2' AND signal_source='unknown'")
        conn.commit()
    dist = conn.execute(
        "SELECT label_definition, count(*) FROM signal_outcomes GROUP BY 1 ORDER BY 2 DESC").fetchall()
    n_sus = conn.execute("SELECT count(*) FROM signal_outcomes WHERE is_suspect=1").fetchone()[0]
    src_dist = conn.execute(
        "SELECT signal_source, count(*) FROM signal_outcomes GROUP BY 1 ORDER BY 2 DESC").fetchall()
    _log(f"  label_definition: {dict(dist)}")
    _log(f"  signal_source: {dict(src_dist)}")
    _log(f"  implausible-return rows flagged: {n_sus}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_so_label ON signal_outcomes (label_definition)")
    conn.commit()


def repair_feature_store_columns(conn: ConnWrapper, dry: bool) -> None:
    """Schema catch-up: feature_store columns feature_engineering writes but live PG lacks.

    Found 2026-08-24 via the Gap #4 verification probe (_tmp_verify.py): the writer's
    upsert lists 94 columns, live table had 86 -- every process_symbol() run has been
    failing with UndefinedColumn since the Gap #4/#5 writer expansion landed, so
    feature_store stopped receiving ANY fresh rows (not just the new ones).

    Nine missing columns:
      iv_skew, insider_buy_pct_90d, block_deal_net_qty, call_wall_dist_pct,
      put_wall_dist_pct, near_expiry_gamma, sector_ret_5d, sector_ret_21d,
      price_to_book  (legacy `pb` predates the writer and has never received a row --
      0 non-null values table-wide -- so feature_engineering writes only
      price_to_book; dl_engine.FEATURE_COLS was repointed from `pb` to
      `price_to_book` on 2026-08-24 at the same list position, keeping checkpoint
      shape).
    Mirrored into db/schema.postgres.sql so bootstrap/DR restores match; bare
    ADD COLUMN is metadata-only here and safe under Timescale compression
    (.claude/commands/migration-safety-review.md). No data backfill: these are
    point-in-time measurements, NEVER_FILL doctrine applies.
    """
    _log("feature_store: adding missing flow/fundamental columns ...")
    stmts = [
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS iv_skew DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS insider_buy_pct_90d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS block_deal_net_qty DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS call_wall_dist_pct DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS put_wall_dist_pct DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS near_expiry_gamma DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS sector_ret_5d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS sector_ret_21d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS price_to_book DOUBLE PRECISION",
        # 2026-09-13: block-deal smart-money family (_merge_block_deals reads the
        # block_deals table of record; value_cr is already consumed by ml_ensemble).
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS block_deal_value_cr DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS block_deal_net_qty_5d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS block_deal_value_cr_5d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS analyst_buy_pct DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS analyst_target_mean DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS analyst_target_upside_pct DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS analyst_n DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS broker_recos_90d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS days_to_next_earnings DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS days_since_last_earnings DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS last_eps_surprise_pct DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS last_beat_score DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS earnings_in_5d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS delivery_z_20d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS delivery_pct_chg_5d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS delivery_qty_5d DOUBLE PRECISION",
        "ALTER TABLE feature_store ADD COLUMN IF NOT EXISTS nifty_pcr DOUBLE PRECISION",
    ]
    if not dry:
        for s in stmts:
            conn.execute(s)
        conn.commit()
    have = {
        r[0]
        for r in conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'feature_store'"
        ).fetchall()
    }
    want = [
        "iv_skew", "insider_buy_pct_90d", "block_deal_net_qty", "call_wall_dist_pct",
        "put_wall_dist_pct", "near_expiry_gamma", "sector_ret_5d", "sector_ret_21d",
        "price_to_book",
        "block_deal_value_cr", "block_deal_net_qty_5d", "block_deal_value_cr_5d",
        "analyst_buy_pct",
        "analyst_target_mean",
        "analyst_target_upside_pct",
        "analyst_n",
        "broker_recos_90d",
        "days_to_next_earnings",
        "days_since_last_earnings",
        "last_eps_surprise_pct",
        "last_beat_score",
        "earnings_in_5d",
        "delivery_z_20d",
        "delivery_pct_chg_5d",
        "delivery_qty_5d",
        "nifty_pcr",
    ]
    missing = [c for c in want if c not in have]
    _log(f"  post-check: {len(want) - len(missing)}/{len(want)} present"
         + (f", STILL MISSING: {missing}" if missing else ""))
    if missing and not dry:
        raise RuntimeError(f"feature_store schema catch-up failed for {missing}")


# ── entry point ──────────────────────────────────────────────────────────────

def repair_nan_recommendations(conn: ConnWrapper, dry: bool) -> None:
    """Delete rows in unified_recommendations whose unified_score is non-finite.

    These are residue of the 2026-07-31 NaN-poisoning bug (a NaN dl_score propagating
    through _blend). They are NOT harmless leftovers: every comparison against NaN is
    False, so `if unified < 1: continue` failed to skip them and _classify's thresholds
    fell through to a plain label -- the rows carry fabricated Buy/Sell/Hold
    classifications with no score behind them.

    Source is already fixed (_finite_engine_map + the math.isfinite(unified) guard in
    unified_ranker.run), and run() purges rows it did not produce -- but only for the
    date it is currently writing, so historical dates keep their NaN rows forever.

    Live consumers read the latest snapshot only, so this is not current trading P&L.
    It matters because it silently corrupts every measurement taken over this table:
    high_flyer_retrospective.py reads `MAX(computed_at) < day` and matches
    `classification LIKE '%Buy%'`, so a --backfill into that window attributes
    predictions the system never actually made.

    Deletes rather than nulls the score: a row with no valid score is not a
    recommendation, and a missing symbol on a historical date is honest where a
    fabricated 'Buy' is not.
    """
    # NaN detection is dialect-specific ON PURPOSE. The portable IEEE trick `x != x`
    # does NOT work here: Postgres deliberately treats NaN as equal to itself so that
    # btree ordering is total, so `x != x` is FALSE for NaN. Cast-to-text is the
    # reliable Postgres test. SQLite cannot store NaN (it coerces to NULL on insert),
    # so there is nothing to clean on the dev fallback path.
    if not use_postgres():
        _log("nan-recommendations: SQLite stores NaN as NULL -- nothing to repair.")
        return

    rows = conn.execute(
        "SELECT classification, COUNT(*) AS c, MIN(computed_at) AS lo, MAX(computed_at) AS hi "
        "FROM unified_recommendations WHERE unified_score::text IN ('NaN','Infinity','-Infinity') "
        "GROUP BY classification ORDER BY c DESC"
    ).fetchall()
    total = sum(int(r['c']) for r in rows)
    if total == 0:
        _log("nan-recommendations: none found -- clean.")
        return
    for r in rows:
        _log(f"  {r['classification']:<12} {int(r['c']):>6} fabricated rows "
             f"({r['lo']} .. {r['hi']})")
    if dry:
        _log(f"nan-recommendations: would delete {total} non-finite rows (dry run).")
        return
    conn.execute("DELETE FROM unified_recommendations "
                 "WHERE unified_score::text IN ('NaN','Infinity','-Infinity')")
    conn.commit()
    _log(f"nan-recommendations: deleted {total} non-finite rows.")


def repair_ghost_recommendations(conn: ConnWrapper, dry: bool) -> None:
    """Delete unified_recommendations rows for symbols with no price history at all.

    Found by the 2026-08-11 reverse audit: 26,375 of 85,442 rows (31%) named 2,498 distinct
    symbols that appear nowhere in stock_ohlcv on any date -- MORE ghost symbols than the
    2,450 real ones -- and 3,774 of them carried an actionable Buy/Sell label rather than
    Hold. They are genuine NSE microcaps (REXPRO, KONSTELEC, SWADPOL, 4THDIM) that the
    screener feeds surface but the platform never prices, not the 2026-07-23 URL-as-symbol
    corruption (checked: 0 url-shaped, 0 lowercase, all match ^[A-Z0-9&*-]+$).

    Source is already fixed. _restrict_to_tradeable_universe() (unified_ranker.py, commit
    b786b98, 2026-07-31) requires membership in both nse_stocks and recent stock_ohlcv, and
    live rows have been clean since -- verified 0 ghost rows on every computed_at from
    2026-07-31 onward. This is purely the residue the source fix could not reach, because
    run() purges only the computed_at it is currently writing, so every historical date keeps
    its ghosts forever. That is the same shape as --nan-recommendations above and as the
    13,505-row NaN residue before it: **fixing a writer never cleans what it already wrote.**

    Why it matters even though live consumers read only the latest snapshot: these rows
    silently corrupt every measurement taken over the table's history. A ghost cannot be
    graded (no forward return exists), so it is dropped by any join to prices -- meaning the
    backtested population and the recommended population were different, which is exactly the
    bias _restrict_to_tradeable_universe was written to stop at the source.

    The predicate is deliberately narrower than the live filter: it removes a symbol only if
    stock_ohlcv has NO bar for it on ANY date, not merely none in the trailing 30 days. A
    symbol with any price history is left alone even if it is currently stale or illiquid, so
    a delisting or a temporary feed gap can never be mistaken for a ghost.
    """
    rows = conn.execute(
        "SELECT COUNT(*) AS c, COUNT(DISTINCT symbol) AS syms, "
        "       SUM(CASE WHEN classification NOT LIKE 'Hold' THEN 1 ELSE 0 END) AS actionable, "
        "       MIN(computed_at) AS lo, MAX(computed_at) AS hi "
        "FROM unified_recommendations "
        "WHERE symbol NOT IN (SELECT DISTINCT symbol FROM stock_ohlcv)"
    ).fetchone()
    total = int(rows['c'] or 0)
    if total == 0:
        _log("ghost-recommendations: none found -- clean.")
        return
    _log(f"  {total} rows across {int(rows['syms'] or 0)} unpriced symbols "
         f"({rows['lo']} .. {rows['hi']}), {int(rows['actionable'] or 0)} carrying a Buy/Sell label")
    if dry:
        _log(f"ghost-recommendations: would delete {total} rows (dry run).")
        return
    conn.execute("DELETE FROM unified_recommendations "
                 "WHERE symbol NOT IN (SELECT DISTINCT symbol FROM stock_ohlcv)")
    conn.commit()
    _log(f"ghost-recommendations: deleted {total} rows.")


def repair_weekend_recommendations(conn: ConnWrapper, dry: bool) -> None:
    """Delete unified_recommendations snapshots stamped to a weekend or known NSE holiday.

    Residue of the same bug as_of.logical_session_date() now prevents at the source: the
    pipeline deliberately runs early on closed days (queues.ts's closed-day-early-batch), and
    run() took date.today() as the computed_at label, so a weekend run produced a snapshot
    dated to a day the market never opened -- 2026-07-05, 07-12, 07-25 and 08-09.

    Safe to delete rather than re-date, and re-dating is actively wrong: the upsert key is
    (symbol, computed_at), so moving a Sunday snapshot onto its Monday would collide with
    that Monday's own run. Verified before deleting that every one of the four is immediately
    followed by a real trading-day snapshot with at least as many rows (07-06/1917,
    07-13/1922, 07-27/1674, 08-10/2201), so the content is not lost -- Monday re-ranked from
    scratch anyway.

    Why they are worse than merely useless: any measurement that picks "the latest snapshot
    strictly before date D" will select the Sunday row as Monday's pre-move signal. The
    2026-08-11 reverse audit did exactly that before this was found.

    Weekend membership is computed in Python, not SQL, because computed_at is TEXT and
    EXTRACT(DOW FROM ...) is Postgres-only. Weekday holidays come from the canonical calendar.
    """
    holidays = {
        str(r[0])[:10]
        for r in conn.execute(
            "SELECT date FROM market_holidays WHERE exchange = ?", ("NSE",)
        ).fetchall()
    }
    dates = [r['computed_at'] for r in conn.execute(
        "SELECT DISTINCT computed_at FROM unified_recommendations").fetchall()]
    closed = []
    for d in dates:
        try:
            iso_date = str(d)[:10]
            if datetime.date.fromisoformat(iso_date).weekday() >= 5 or iso_date in holidays:
                closed.append(d)
        except ValueError:
            continue                      # unparseable date -- not this repair's business
    if not closed:
        _log("weekend-recommendations: none found -- clean.")
        return

    placeholders = ",".join("?" for _ in closed)
    total = int(conn.execute(
        f"SELECT COUNT(*) AS c FROM unified_recommendations "
        f"WHERE computed_at IN ({placeholders})", tuple(closed)).fetchone()['c'] or 0)
    _log(f"  {total} rows across {len(closed)} closed-day snapshots: {sorted(closed)}")
    if dry:
        _log(f"weekend-recommendations: would delete {total} rows (dry run).")
        return
    conn.execute(f"DELETE FROM unified_recommendations "
                 f"WHERE computed_at IN ({placeholders})", tuple(closed))
    conn.commit()
    _log(f"weekend-recommendations: deleted {total} rows.")


def repair_zero_neutral_outcomes(conn: ConnWrapper, dry: bool) -> None:
    """Requeue stale PENDING rows that expiry fabricated as 0% NEUTRAL without an exit price.

    Only rows with a valid canonical bar after the signal are eligible. Genuine neutral exits
    retain their exit price and are not touched; rows without a valid bar remain as recorded.
    The normal outcome resolver then recomputes each selected row using its canonical path.
    """
    predicates = {
        'signal_outcomes': "outcome = 'NEUTRAL' AND return_pct = 0 AND exit_price IS NULL",
        'unified_signal_outcomes': "outcome = 'NEUTRAL' AND return_pct = 0 AND exit_price IS NULL",
        'recommendation_log': (
            "outcome = 'NEUTRAL' AND actual_return_pct = 0 AND actual_exit_price IS NULL "
            "AND status = 'RESOLVED'"
        ),
    }
    counts = {}
    for table, predicate in predicates.items():
        counts[table] = int(conn.execute(
            f"SELECT count(*) FROM {table} x WHERE {predicate} "
            "AND EXISTS (SELECT 1 FROM stock_ohlcv o WHERE o.symbol = x.symbol "
            "AND o.date > CAST(x.signal_date AS date) AND COALESCE(o.is_suspect, 0) = 0)"
        ).fetchone()[0] or 0)

    total = sum(counts.values())
    _log(f"  stale synthetic neutral rows eligible for re-resolution: {counts} (total={total})")
    if total == 0 or dry:
        if dry:
            _log("zero-neutral-outcomes: dry run -- nothing written.")
        return

    conn.execute("""
        UPDATE signal_outcomes x SET outcome='PENDING', return_pct=NULL
        WHERE outcome='NEUTRAL' AND return_pct=0 AND exit_price IS NULL
          AND EXISTS (SELECT 1 FROM stock_ohlcv o WHERE o.symbol=x.symbol
                      AND o.date > CAST(x.signal_date AS date) AND COALESCE(o.is_suspect,0)=0)
    """)
    conn.execute("""
        UPDATE unified_signal_outcomes x SET outcome='PENDING', return_pct=NULL, exit_reason=NULL
        WHERE outcome='NEUTRAL' AND return_pct=0 AND exit_price IS NULL
          AND EXISTS (SELECT 1 FROM stock_ohlcv o WHERE o.symbol=x.symbol
                      AND o.date > CAST(x.signal_date AS date) AND COALESCE(o.is_suspect,0)=0)
    """)
    conn.execute("""
        UPDATE recommendation_log x
        SET outcome='PENDING', actual_return_pct=NULL, status='ACTIVE', resolved_at=NULL
        WHERE outcome='NEUTRAL' AND actual_return_pct=0 AND actual_exit_price IS NULL
          AND status='RESOLVED'
          AND EXISTS (SELECT 1 FROM stock_ohlcv o WHERE o.symbol=x.symbol
                      AND o.date > CAST(x.signal_date AS date) AND COALESCE(o.is_suspect,0)=0)
    """)
    conn.commit()
    _log(f"zero-neutral-outcomes: requeued {total} rows for the normal resolver.")


def repair_delivery_trades(conn: ConnWrapper, dry: bool) -> None:
    """NULL out stock_delivery_data.trades where it is a copy of delivery_qty.

    deliveryFetcher.ts read the trade count as `cols[cols.length - 2]` with the comment
    "Usually NO_OF_TRADES is second to last". NSE's sec_bhavdata_full actually ends
    ... NO_OF_TRADES, DELIV_QTY, DELIV_PER -- so second-to-last is DELIV_QTY, and `trades`
    held delivery quantity in **100% of 664,006 rows**. Same blind-positional-index class as
    the 2026-07-23 URL-as-symbol corruption; the other four columns in that same function
    were already resolved by header name.

    Source fixed 2026-08-11 (header.indexOf('NO_OF_TRADES')). This clears the residue, because
    a fixed writer never cleans what it already wrote -- the fourth time that has come up here.

    NULLs rather than deletes: `delivery_pct`, `delivery_qty` and `traded_qty` on these rows
    are correct and are what the delivery factor work actually reads. Only the one column is
    wrong, and NULL is the honest value for "we never captured this".

    The predicate is `trades = delivery_qty`, so a row where the real trade count coincidentally
    equalled delivery quantity would also be nulled. Across 664,006 rows matching at 100% that
    is systematic, not coincidence, and the cost of nulling a genuine coincidence is nil.
    """
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM stock_delivery_data "
        "WHERE trades IS NOT NULL AND trades = delivery_qty").fetchone()
    total = int(row['c'] or 0)
    if total == 0:
        _log("delivery-trades: none found -- clean.")
        return
    _log(f"  {total} rows where trades duplicates delivery_qty")
    if dry:
        _log(f"delivery-trades: would NULL {total} rows (dry run).")
        return
    conn.execute("UPDATE stock_delivery_data SET trades = NULL "
                 "WHERE trades IS NOT NULL AND trades = delivery_qty")
    conn.commit()
    _log(f"delivery-trades: nulled {total} rows.")


def repair_dl_performance_sentinels(conn: ConnWrapper, dry: bool) -> None:
    """NULL the unit-test sentinel metrics (roc_auc=0.58, directional_accuracy=0.55) in
    dl_model_performance (AF-20260930-01).

    A test once wrote that exact pair under model_version='lstm_v99'; the daily drift upsert
    (`ON CONFLICT ... DO UPDATE SET model_version=excluded.model_version`) later relabelled some of
    those rows 'current' while leaving the fake metrics, so a cleanup keyed on the label missed
    them and dl.router.ts served them as history. Select by the polluted VALUE, never by a
    provenance column an upsert can rewrite. The pair is required, not either half: a genuine run
    can land on 0.58 alone. NULL (not delete) keeps the drift_score/eval_date bookkeeping.
    """
    where = "roc_auc = 0.58 AND directional_accuracy = 0.55"
    total = int(conn.execute(
        f"SELECT COUNT(*) AS c FROM dl_model_performance WHERE {where}").fetchone()['c'] or 0)
    if total == 0:
        _log("dl-performance-sentinels: none found -- clean.")
        return
    _log(f"  {total} dl_model_performance rows carry the sentinel metric pair")
    if dry:
        _log(f"dl-performance-sentinels: would NULL {total} rows (dry run).")
        return
    conn.execute(f"UPDATE dl_model_performance SET roc_auc = NULL, directional_accuracy = NULL WHERE {where}")
    conn.commit()
    _log(f"dl-performance-sentinels: nulled {total} rows.")


def repair_signal_exit_evidence(conn: ConnWrapper, dry: bool) -> None:
    """Stamp closed_at/exit_price/exit_reason on signals closed before any writer recorded one
    (AF-20261008-08).

    The scheduled `stuck-signal-resolver` wrote only `status` until 2026-10-08, so 44,909 terminal
    `unified_signals` rows inside the trailing 45-day window carry a COMPLETED/FAILED/EXPIRED
    verdict with no exit at all -- and a win percentage over them cannot use the price the signal
    actually exited at. Fixing the writer does not clean what it already wrote.

    PURE REPAIR, NEVER A RE-GRADE. The first touch is re-derived from stock_ohlcv with the same
    geometry the resolver and signal_lifecycle.close_swing use, and the evidence is stamped ONLY
    where the re-derived verdict MATCHES the stored one. Measured live 2026-10-08: 44,211 of
    44,238 agree (99.94%) -- those statuses came from the same path-based logic -- and the 27 that
    disagree are left alone and reported. Recording the evidence for a verdict and changing the
    verdict are different decisions, and only the first one is safe to automate.

    Exit pricing mirrors signal_lifecycle.close_swing exactly: the published level, unless the bar
    OPENED through it, in which case the fill is that open. An EXPIRED row never touched a level,
    so it exits at the last clean close in its own window (TIME_EXIT) -- its real exit price.
    `is_suspect` bars are excluded throughout (panel spec).
    """
    # Horizon in TRADING SESSIONS per source, from signal_lifecycle.HORIZON_SESSIONS. Kept as a
    # literal CASE rather than imported so this repair cannot start writing a window the closer
    # does not use; if they ever diverge, test_repair_signal_exit_evidence pins the behaviour.
    horizon_case = ("CASE u.signal_source WHEN 'screener' THEN 0 "
                    "WHEN 'technical_scan' THEN 5 ELSE 15 END")

    touched_sql = f"""
        WITH term AS (
            SELECT u.id, u.symbol, u.signal_date, u.status,
                   u.target_price AS target, u.stop_loss AS stop,
                   (u.target_price > u.stop_loss) AS is_long
            FROM unified_signals u
            WHERE u.status IN ('COMPLETED', 'FAILED')
              AND u.closed_at IS NULL AND u.exit_price IS NULL
              AND u.target_price IS NOT NULL AND u.stop_loss IS NOT NULL
              AND u.target_price <> u.stop_loss
        )
        SELECT t.id, t.status AS stored, x.date AS touch_date,
               CASE WHEN x.hit_stop THEN 'FAILED' ELSE 'COMPLETED' END AS rederived,
               CASE WHEN x.hit_stop THEN 'STOP' ELSE 'TARGET' END AS exit_reason,
               CASE WHEN x.hit_stop THEN
                    CASE WHEN t.is_long THEN (CASE WHEN x.bar_open <= t.stop THEN x.bar_open ELSE t.stop END)
                         ELSE (CASE WHEN x.bar_open >= t.stop THEN x.bar_open ELSE t.stop END) END
                    ELSE
                    CASE WHEN t.is_long THEN (CASE WHEN x.bar_open >= t.target THEN x.bar_open ELSE t.target END)
                         ELSE (CASE WHEN x.bar_open <= t.target THEN x.bar_open ELSE t.target END) END
               END AS exit_price
        FROM term t
        CROSS JOIN LATERAL (
            SELECT o.date, o.open AS bar_open,
                   (CASE WHEN t.is_long THEN o.low <= t.stop ELSE o.high >= t.stop END) AS hit_stop
            FROM stock_ohlcv o
            WHERE o.symbol = t.symbol AND o.date > t.signal_date::date
              AND COALESCE(o.is_suspect, 0) = 0
              AND o.high IS NOT NULL AND o.low IS NOT NULL
              AND ((CASE WHEN t.is_long THEN o.high >= t.target ELSE o.low  <= t.target END)
                OR (CASE WHEN t.is_long THEN o.low  <= t.stop   ELSE o.high >= t.stop   END))
            ORDER BY o.date LIMIT 1
        ) x
    """
    rows = conn.execute(touched_sql).fetchall()
    agree = [r for r in rows if r['stored'] == r['rederived']]
    disagree = [r for r in rows if r['stored'] != r['rederived']]

    # EXPIRED: no level was ever touched, so the honest exit is the last clean close inside the
    # signal's own window. The window is bounded by session COUNT, never by `today - h days`
    # (bugs-data-layer.md's short-calendar-cutoff class).
    expired_sql = f"""
        WITH term AS (
            SELECT u.id, u.symbol, u.signal_date, u.target_price AS target, u.stop_loss AS stop,
                   (u.target_price > u.stop_loss) AS is_long, {horizon_case} AS horizon
            FROM unified_signals u
            WHERE u.status = 'EXPIRED'
              AND u.closed_at IS NULL AND u.exit_price IS NULL
              AND u.target_price IS NOT NULL AND u.stop_loss IS NOT NULL
              AND u.target_price <> u.stop_loss
        )
        SELECT t.id, w.last_date AS touch_date, w.last_close AS exit_price
        FROM term t
        CROSS JOIN LATERAL (
            -- Aggregate over the WINDOWED subquery, never a `bool_or(...) OVER ()` beside
            -- ORDER BY/LIMIT: Postgres evaluates a window function BEFORE ORDER BY and LIMIT at
            -- the same query level, so that form tests the whole post-signal history instead of
            -- this signal's own window and suppresses every legitimate time exit (shipped once,
            -- caught by the live dry run reading 0 of 621; pinned by
            -- test_a_touch_AFTER_the_window_does_not_block_the_time_exit).
            SELECT bool_or(CASE WHEN t.is_long THEN b.high >= t.target ELSE b.low  <= t.target END) AS any_target,
                   bool_or(CASE WHEN t.is_long THEN b.low  <= t.stop   ELSE b.high >= t.stop   END) AS any_stop,
                   (array_agg(b.close ORDER BY b.date DESC))[1] AS last_close,
                   (array_agg(b.date  ORDER BY b.date DESC))[1] AS last_date,
                   count(*) AS n_bars
            FROM (
                SELECT o.date, o.high, o.low, o.close
                FROM stock_ohlcv o
                WHERE o.symbol = t.symbol AND o.date > t.signal_date::date
                  AND COALESCE(o.is_suspect, 0) = 0 AND o.close IS NOT NULL
                  AND o.high IS NOT NULL AND o.low IS NOT NULL
                ORDER BY o.date
                LIMIT GREATEST(t.horizon, 1)
            ) b
        ) w
        WHERE NOT w.any_target AND NOT w.any_stop AND w.n_bars > 0
    """
    expired_last = {r['id']: r for r in conn.execute(expired_sql).fetchall()}

    total = len(agree) + len(expired_last)
    if total == 0 and not disagree:
        _log("signal-exit-evidence: none found -- every closed signal records its exit.")
        return
    _log(f"  {len(agree)} touched rows agree with their stored verdict and can be stamped")
    _log(f"  {len(expired_last)} EXPIRED rows can be priced at their window's last close")
    if disagree:
        _log(f"  {len(disagree)} rows DISAGREE with their stored verdict -- left untouched "
             f"(re-grading a verdict is a separate decision): ids "
             f"{[r['id'] for r in disagree][:10]}{' ...' if len(disagree) > 10 else ''}")
    if dry:
        _log(f"signal-exit-evidence: would stamp {total} rows (dry run).")
        return

    payload = [(r['touch_date'], r['exit_price'], r['exit_reason'], r['id']) for r in agree]
    payload += [(r['touch_date'], r['exit_price'], 'TIME_EXIT', r['id'])
                for r in expired_last.values()]
    # Chunked: >10,922 rows at 4 bind params each exceeds Postgres' 65,535-parameter statement
    # limit (the same cap signal_lifecycle.py chunks for).
    # `unified_signals` is NOT a Timescale hypertable (checked live 2026-10-08 -- only
    # stock_ohlcv and confluence_signals are), so this needs no safe_keyed_update; it is still
    # keyed on the primary key so no predicate-wide write is ever issued. Committed per chunk
    # rather than once at the end: 114k single-row updates in one transaction holds it open for
    # minutes against a table every live reader touches.
    CHUNK = 1_000
    for i in range(0, len(payload), CHUNK):
        conn.executemany(
            "UPDATE unified_signals SET closed_at = ?, exit_price = ?, exit_reason = ? "
            "WHERE id = ? AND closed_at IS NULL AND exit_price IS NULL", payload[i:i + CHUNK])
        conn.commit()
    _log(f"signal-exit-evidence: stamped {len(payload)} rows "
         f"({len(agree)} touched / {len(expired_last)} time-exit).")


def repair_conflict_signal_outcomes(conn: ConnWrapper, dry: bool) -> None:
    """Delete outcomes graded for signals the scan itself withdrew (AF-20260930-33).

    A screener scan that flips BUY -> SELL on the same symbol the same day marks the earlier signal
    INVALIDATED_CONFLICT. The resolver skips those now, but the rows it wrote before the fix (31k at
    3.3% win vs 6.5% for live signals) still enter every screener win rate. Select by the parent
    signal's status, not by outcome text; a NULL status is a live signal and is never touched.
    """
    where = ("unified_signal_id IN (SELECT id FROM unified_signals WHERE status = 'INVALIDATED_CONFLICT')")
    total = int(conn.execute(f"SELECT COUNT(*) AS c FROM unified_signal_outcomes WHERE {where}").fetchone()['c'] or 0)
    if total == 0:
        _log("conflict-signal-outcomes: none found -- clean.")
        return
    _log(f"  {total} unified_signal_outcomes rows grade INVALIDATED_CONFLICT signals")
    if dry:
        _log(f"conflict-signal-outcomes: would delete {total} rows (dry run).")
        return
    conn.execute(f"DELETE FROM unified_signal_outcomes WHERE {where}")
    conn.commit()
    _log(f"conflict-signal-outcomes: deleted {total} rows.")


def repair_signal_outcome_mfe(conn: ConnWrapper, dry: bool) -> None:
    """Backfill signal_outcomes.max_return_pct from clean bars owned by the trade.

    The live resolver now writes this outcome-side MFE label, but the column had no writer for
    its existing history while the ML diagnostics API exposed AVG(max_return_pct). Bound the
    window by check_date, not the nominal horizon: a stopped trade cannot claim a rally after
    it exited. This is deliberately never used as a model feature (future information).
    """
    rows = conn.execute("""
        SELECT so.symbol, so.signal_date::text, so.horizon_days, so.signal_source,
               ROUND((((MAX(o.high) - so.entry_price) / so.entry_price) * 100)::numeric, 4)::float8 AS mfe
        FROM signal_outcomes so
        JOIN stock_ohlcv o ON o.symbol = so.symbol
                          AND o.date > so.signal_date::date
                          AND o.date <= so.check_date::date
                          AND COALESCE(o.is_suspect, 0) = 0
                          AND o.high IS NOT NULL
        WHERE so.max_return_pct IS NULL
          AND so.check_date IS NOT NULL
          AND so.entry_price IS NOT NULL AND so.entry_price > 0
          AND so.signal_source = 'technical'
        GROUP BY so.symbol, so.signal_date, so.horizon_days, so.signal_source, so.entry_price
    """).fetchall()
    _log(f"signal-outcome-mfe: {len(rows)} technical outcome rows need a clean-bar MFE")
    if not rows or dry:
        return
    payload = [(float(r['mfe']), str(r['symbol']), str(r['signal_date'])[:10],
                int(r['horizon_days']), str(r['signal_source'])) for r in rows if r['mfe'] is not None]
    for i in range(0, len(payload), 1_000):
        conn.executemany(
            "UPDATE signal_outcomes SET max_return_pct=? "
            "WHERE symbol=? AND signal_date=? AND horizon_days=? AND signal_source=? "
            "AND max_return_pct IS NULL",
            payload[i:i + 1_000])
        conn.commit()
    _log(f"signal-outcome-mfe: populated {len(payload)} rows.")


# ── 12. fabricated closed-session bars ───────────────────────────────────────

# Above this share of a day's universe being flat AND zero-volume, the exchange never opened.
# Matches liveStockData.ts's CLOSED_MARKET_SHARE_FLOOR -- keep the two in step.
CLOSED_MARKET_SHARE_FLOOR = 0.95
CLOSED_SESSION_REASON = 'closed session: universe-wide flat zero-volume bar'


def _find_closed_sessions(conn) -> list:
    """Dates whose whole universe is a flat (o==h==l==c) zero-volume bar -- a market holiday on
    which a live-quote refresh persisted every stock's last close as if it were a session."""
    rows = conn.execute("""
        SELECT date::text AS d, count(*) AS n,
               count(*) FILTER (WHERE COALESCE(volume,0)=0
                                 AND open=high AND high=low AND low=close) AS flat
        FROM stock_ohlcv
        GROUP BY date
        HAVING count(*) > 50
        ORDER BY date
    """).fetchall()
    return [(str(r[0])[:10], int(r[1])) for r in rows
            if int(r[1]) and int(r[2]) / int(r[1]) >= CLOSED_MARKET_SHARE_FLOOR]


COPIED_SESSION_REASON = 'closed session: universe-wide copy of the previous session bar'


def _find_copied_sessions(conn) -> list:
    """Dates where the day's bars repeat each symbol's previous bar exactly (OHLC and volume):
    a refresh on a shut exchange persisted the last session's full quote under the new date.
    The second fabricated shape beside the flat zero-volume one (AF-20261117-18: 2026-07-11,
    2,114 of 2,121); every real special session, weekends included, has 0 such copies."""
    rows = conn.execute("""
        SELECT date::text AS d, count(*) AS n,
               count(*) FILTER (WHERE open = po AND high = ph AND low = pl
                                 AND close = pc AND volume = pv) AS copies
        FROM (SELECT date, open, high, low, close, volume,
                     lag(open) OVER w AS po, lag(high) OVER w AS ph, lag(low) OVER w AS pl,
                     lag(close) OVER w AS pc, lag(volume) OVER w AS pv
              FROM stock_ohlcv
              WINDOW w AS (PARTITION BY symbol ORDER BY date)) t
        GROUP BY date
        HAVING count(*) > 50
        ORDER BY date
    """).fetchall()
    return [(str(r[0])[:10], int(r[1])) for r in rows
            if int(r[1]) and int(r[2]) / int(r[1]) >= CLOSED_MARKET_SHARE_FLOOR]


# Rows computed FROM a fabricated session's bars. Flagging the bars does not remove them, and a
# feature rebuild only rewrites dates it still sees, so they stay as duplicate training rows.
PHANTOM_DERIVED_TABLES = ('feature_store', 'technical_signals')


def _purge_phantom_derived(conn, dates: list, dry: bool, backup_dir: str) -> None:
    import csv
    placeholders = ','.join('?' for _ in dates)
    for table in PHANTOM_DERIVED_TABLES:
        if not conn.execute("SELECT to_regclass(?)", (table,)).fetchone()[0]:
            continue
        cur = conn.execute(f"SELECT * FROM {table} WHERE date::text IN ({placeholders})", tuple(dates))
        cols = [c[0] for c in cur.description]
        rows = cur.fetchall()
        _log(f"  {table}: {len(rows)} rows on fabricated sessions")
        if dry or not rows:
            continue
        os.makedirs(backup_dir, exist_ok=True)
        with open(os.path.join(backup_dir, f"{table}.csv"), 'w', newline='', encoding='utf-8') as fh:
            w = csv.writer(fh)
            w.writerow(cols)
            w.writerows([tuple(r) for r in rows])
        i_sym, i_date = cols.index('symbol'), cols.index('date')
        done = safe_keyed_update(
            conn, f"DELETE FROM {table} WHERE symbol=? AND date::text=?",
            [(str(r[i_sym]), str(r[i_date])[:10]) for r in rows], batch_size=500)
        _log(f"  {table}: deleted {done} rows (backup {backup_dir})")


def repair_closed_sessions(conn: ConnWrapper, dry: bool, backup_dir: str | None = None) -> None:
    """Flag bars belonging to a session the exchange never opened (AF-20260911-15).

    Found 2026-09-11: 4 such dates (2026-01-15, 2026-05-01, 2026-05-28, 2026-06-26) held 7,515
    bars, essentially none flagged. Two distinct harms, which is why flagging matters rather
    than being cosmetic:
      * measurement.md's panel spec excludes `is_suspect = 1`, so unflagged fake bars entered
        every forward-return panel as a real session returning exactly 0%;
      * repair_holidays() derives market_holidays from weekdays ABSENT from stock_ohlcv, so a
        fabricated bar permanently hides the holiday that produced it.

    Flags rather than deletes: is_suspect is the column that exists for exactly this, every
    measurement path already filters on it, and the flag is reversible where a DELETE is not.
    """
    _log("closed sessions: scanning for flat zero-volume and copied-previous-session days ...")
    if not dry:  # even a no-op IF NOT EXISTS takes an ACCESS EXCLUSIVE lock on stock_ohlcv
        conn.execute("ALTER TABLE stock_ohlcv ADD COLUMN IF NOT EXISTS is_suspect SMALLINT DEFAULT 0")
        conn.execute("ALTER TABLE stock_ohlcv ADD COLUMN IF NOT EXISTS suspect_reason TEXT")
        conn.commit()

    sessions = [(d, n, CLOSED_SESSION_REASON) for d, n in _find_closed_sessions(conn)]
    seen = {d for d, _, _ in sessions}
    sessions += [(d, n, COPIED_SESSION_REASON) for d, n in _find_copied_sessions(conn) if d not in seen]
    if not sessions:
        _log("  none found")
        return
    for d, n, reason in sessions:
        _log(f"  {d}: {n} bars ({reason})")

    # Idempotent: only rows not already carrying their reason are rewritten, so a second run
    # decompresses nothing.
    updates = []
    for d, _, reason in sessions:
        pairs = conn.execute(
            "SELECT symbol FROM stock_ohlcv WHERE date::text = ? "
            "AND (COALESCE(is_suspect,0)=0 OR suspect_reason IS DISTINCT FROM ?)",
            (d, reason)).fetchall()
        updates += [(reason, str(r[0]), d) for r in pairs]
    _log(f"  bars needing the flag: {len(updates)}")
    if not dry and updates:
        done = safe_keyed_update(
            conn,
            "UPDATE stock_ohlcv SET is_suspect=1, suspect_reason=? WHERE symbol=? AND date::text=?",
            updates, batch_size=200)
        _log(f"  flagged {done} bars across {len(sessions)} session(s)")

    backup_dir = backup_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backups',
        'phantom_sessions_' + datetime.datetime.now().strftime('%Y%m%dT%H%M%S'))
    _purge_phantom_derived(conn, [d for d, _, _ in sessions], dry, backup_dir)


# Symbols that are not NSE listings: Yahoo answered a ticker truncated at an unencoded `&`
# (M&M -> M, J&KBANK -> J, S&SPOWER -> S, ARE&M -> ARE, GVT&D -> GVT) with a US stock, 59 bars
# each 2026-05-26..09-11, before yahooQuoteUrl() fixed the source (AF-20260911-11); ZZTEST is a
# leaked test fixture. Explicit on purpose: none has an nse_stocks or nse_universe_history row,
# and a rule that inferred "unlisted" would also catch index rows and fresh listings.
UNLISTED_JUNK_SYMBOLS = ('ARE', 'GVT', 'J', 'M', 'S', 'ZZTEST')
UNLISTED_REASON = 'not an NSE listing (truncated & ticker answered by a US quote, or test fixture)'


def repair_unlisted_symbols(conn: ConnWrapper, dry: bool) -> None:
    """Flag stock_ohlcv bars of symbols that are not NSE listings (AF-20261117-18)."""
    _log("unlisted symbols: flagging non-NSE bars ...")
    placeholders = ','.join('?' for _ in UNLISTED_JUNK_SYMBOLS)
    pairs = conn.execute(
        f"SELECT symbol, date::text FROM stock_ohlcv WHERE symbol IN ({placeholders}) "
        f"AND (COALESCE(is_suspect,0)=0 OR suspect_reason IS DISTINCT FROM ?)",
        (*UNLISTED_JUNK_SYMBOLS, UNLISTED_REASON)).fetchall()
    _log(f"  bars needing the flag: {len(pairs)}")
    if dry or not pairs:
        return
    done = safe_keyed_update(
        conn, "UPDATE stock_ohlcv SET is_suspect=1, suspect_reason=? WHERE symbol=? AND date::text=?",
        [(UNLISTED_REASON, str(s), str(d)[:10]) for s, d in pairs], batch_size=200)
    _log(f"  flagged {done} bars")


def repair_positive_stop_outcomes(conn: ConnWrapper, dry: bool, backup_dir: str | None = None) -> None:
    """Regrade unified_signal_outcomes stored as STOP_LOSS with a positive net return by the
    resolver's volatility threshold (AF-20261117-19); exit_reason keeps the stop."""
    import csv
    from outcome_resolver import get_volatility_threshold
    _log("positive-return STOP_LOSS outcomes: regrading ...")
    rows = conn.execute(
        "SELECT id, symbol, signal_date::text, horizon_days, return_pct, outcome, exit_reason "
        "FROM unified_signal_outcomes WHERE outcome = 'STOP_LOSS' AND return_pct > 0").fetchall()
    updates = []
    for rid, sym, sd, h, ret, _, _ in rows:
        thr = get_volatility_threshold(conn, sym, str(sd)[:10], int(h or 1))
        updates.append(('WIN' if float(ret) > thr else 'NEUTRAL', rid))
    _log(f"  rows: {len(rows)} -> WIN {sum(u[0] == 'WIN' for u in updates)}, "
         f"NEUTRAL {sum(u[0] == 'NEUTRAL' for u in updates)}")
    if dry or not rows:
        return
    backup_dir = backup_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backups',
        'positive_stop_outcomes_' + datetime.datetime.now().strftime('%Y%m%dT%H%M%S'))
    os.makedirs(backup_dir, exist_ok=True)
    with open(os.path.join(backup_dir, 'unified_signal_outcomes.csv'), 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['id', 'symbol', 'signal_date', 'horizon_days', 'return_pct', 'outcome', 'exit_reason'])
        w.writerows(rows)
    conn.execute("UPDATE unified_signal_outcomes SET exit_reason = 'STOP_LOSS' "
                 "WHERE outcome = 'STOP_LOSS' AND return_pct > 0 AND exit_reason IS NULL")
    done = safe_keyed_update(
        conn, "UPDATE unified_signal_outcomes SET outcome = ? WHERE id = ? AND outcome = 'STOP_LOSS'",
        updates, batch_size=500)
    _log(f"  regraded {done} rows (backup {backup_dir})")


TASKS = {
    'bad_bars': repair_bad_bars,
    'adjustment': repair_adjustment_basis,
    'insider_dates': repair_insider_dates,
    # Must precede 'holidays': that repair derives the calendar from dates ABSENT from
    # stock_ohlcv, so the fabricated sessions have to be flagged first to be excluded.
    'closed_sessions': repair_closed_sessions,
    'unlisted_symbols': repair_unlisted_symbols,
    'holidays': repair_holidays,
    'news_link': repair_news_link,
    'labels': repair_labels,
    'feature_store_columns': repair_feature_store_columns,
    'nan_recommendations': repair_nan_recommendations,
    'ghost_recommendations': repair_ghost_recommendations,
    'weekend_recommendations': repair_weekend_recommendations,
    'zero_neutral_outcomes': repair_zero_neutral_outcomes,
    'delivery_trades': repair_delivery_trades,
    'dl_performance_sentinels': repair_dl_performance_sentinels,
    'conflict_signal_outcomes': repair_conflict_signal_outcomes,
    'signal_exit_evidence': repair_signal_exit_evidence,
    'signal_outcome_mfe': repair_signal_outcome_mfe,
    'positive_stop_outcomes': repair_positive_stop_outcomes,
}


def main():
    ap = argparse.ArgumentParser()
    for t in TASKS:
        ap.add_argument('--' + t.replace('_', '-'), action='store_true')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    chosen = [t for t in TASKS if getattr(args, t)] or (list(TASKS) if args.all else [])
    if not chosen:
        ap.error("pick at least one repair, or --all")
    conn = connect()
    try:
        for t in chosen:
            TASKS[t](conn, args.dry_run)
    finally:
        conn.close()
    _log("done." + (" (dry run -- nothing written)" if args.dry_run else ""))


if __name__ == '__main__':
    main()
