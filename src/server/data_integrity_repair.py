#!/usr/bin/env python3
"""
Data-integrity repairs from the 2026-07-30 bias audit
(docs/audit-2026-07-30/DATA_BIAS_AND_QUANT_STRATEGY_AUDIT.md).

Each repair is idempotent and can be run independently:

  --bad-bars        flag physically-impossible stock_ohlcv bars (is_suspect)
  --adjustment      backfill the untagged adjustment_basis column
  --insider-dates   convert insider_trades.date from "22 May, 2026" to ISO
  --holidays        populate market_holidays from observed trading gaps
  --news-link       build an indexed news_symbol_link table from symbols_json
  --labels          add label_definition/producer to signal_outcomes + flag implausible returns
  --all             run everything

Run:  python data_integrity_repair.py --all [--dry-run]
"""
import argparse
import datetime
import json
import re

from db_compat import connect, ConnWrapper
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
    traded = {str(r[0])[:10] for r in
              conn.execute("SELECT DISTINCT date FROM stock_ohlcv").fetchall()}
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
        conn.commit()
    dist = conn.execute(
        "SELECT label_definition, count(*) FROM signal_outcomes GROUP BY 1 ORDER BY 2 DESC").fetchall()
    n_sus = conn.execute("SELECT count(*) FROM signal_outcomes WHERE is_suspect=1").fetchone()[0]
    _log(f"  label_definition: {dict(dist)}")
    _log(f"  implausible-return rows flagged: {n_sus}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_so_label ON signal_outcomes (label_definition)")
    conn.commit()


# ── entry point ──────────────────────────────────────────────────────────────

TASKS = {
    'bad_bars': repair_bad_bars,
    'adjustment': repair_adjustment_basis,
    'insider_dates': repair_insider_dates,
    'holidays': repair_holidays,
    'news_link': repair_news_link,
    'labels': repair_labels,
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
