#!/usr/bin/env python3
"""
screener_catalog_enricher.py
============================
Bulk-fills signal_keywords and screener_url for all screener_catalog + screener_master rows
using NLP on screener names already in the DB. No API calls required.

Also backfills:
- trendlyne_screeners.screener_url for PKs we know (pk -> url is deterministic)
- screener_master.signal_type_tag from name keywords

Run: python screener_catalog_enricher.py
"""
import polars as pl
import re
from db_compat import connect
import sys

# ── Signal keyword patterns (same as trendlyne_screener_discovery.py) ────────
SIGNAL_KEYWORD_PATTERNS = [
    (r"52.week.high|all.time.high",               "ath_proximity"),
    (r"breakout",                                   "breakout"),
    (r"breakdown",                                  "breakdown"),
    (r"golden.cross|death.cross",                   "ma_crossover"),
    (r"rsi.bullish|rsi.bearish|rsi.overbought|rsi.oversold", "rsi_signal"),
    (r"macd",                                       "macd_signal"),
    (r"bollinger",                                  "bollinger_signal"),
    (r"volume.surge|high.volume|delivery.surge",   "volume_spike"),
    (r"delivery",                                   "delivery_signal"),
    (r"institutional|fii|dii|mf.buy|mf.sell",     "institutional_flow"),
    (r"insider",                                    "insider_activity"),
    (r"earnings|eps|results|quarterly",            "earnings_event"),
    (r"dividend|ex.div",                           "dividend_event"),
    (r"sector.rotation|sector.leader",             "sector_rotation"),
    (r"momentum",                                   "momentum"),
    (r"reversal",                                   "reversal"),
    (r"support|resistance",                         "sr_level"),
    (r"dvm",                                        "dvm_score"),
    (r"valuation|pe.ratio|p/e|price.book",         "valuation_signal"),
    (r"debt.free|low.debt|zero.debt",              "debt_quality"),
    (r"high.roe|high.roce|roe",                    "return_quality"),
    (r"promoter",                                   "promoter_activity"),
    (r"buyback|bonus|split",                       "corporate_action"),
    (r"intraday|btst|stbt",                         "intraday_signal"),
    (r"relative.strength|rs.rank",                 "rs_signal"),
    (r"fundamental.strong|quality.stock|balance.sheet", "fundamental_quality"),
    (r"smallcap|midcap|largecap|microcap",         "market_cap_theme"),
    (r"swing|positional|long.term|investment",     "timeframe_signal"),
    (r"rebound|recovery|turnaround",               "turnaround"),
    (r"overvalued|undervalued",                    "valuation_signal"),
]


_REGEX_SPECIAL = set(r"()*+?[]{}^$|\\")


def _safe_pattern(pat: str) -> str:
    """If pattern has regex special chars, use as-is. Otherwise replace '.' with [\s\-_]?."""
    if any(c in pat for c in _REGEX_SPECIAL):
        return pat
    return re.escape(pat).replace(r"\.", r"[\s\-_]?")


def extract_signal_keywords(name: str) -> str:
    """Extract comma-separated signal keyword tags from screener name."""
    t = (name or "").lower()
    tags = []
    seen = set()
    for pattern, tag in SIGNAL_KEYWORD_PATTERNS:
        if tag not in seen and re.search(_safe_pattern(pattern), t):
            tags.append(tag)
            seen.add(tag)
    return ",".join(tags) if tags else ""


def tl_screener_url(screenpk) -> str:
    if screenpk:
        return f"https://trendlyne.com/equity/screeners/{screenpk}/view/"
    return None


# Category → (signal_bias, investment_horizon, confidence) fallback defaults ONLY -- this is
# a coarser, unrelated vocabulary (momentum/breakout/valuation/...) from screener_master's real
# category taxonomy (technical_trend, fundamental_quality, ... -- unified_ranker.py's
# CAT_BASE_WT keys). Never use this dict to validate/normalize a category value itself -- see
# resolve_screener_defaults's own docstring for why that collapsed real categories to 'other'.
CATEGORY_DEFAULTS = {
    'momentum':          ('bullish',  'short_term',  0.72),
    'breakout':          ('bullish',  'short_term',  0.72),
    'breakdown':         ('bearish',  'short_term',  0.72),
    'valuation':         ('bullish',  'long_term',   0.72),
    'fundamental':       ('bullish',  'long_term',   0.72),
    'quality':           ('bullish',  'long_term',   0.72),
    'dividend':          ('bullish',  'long_term',   0.70),
    'technical':         ('bullish',  'short_term',  0.70),
    'sector_theme':      ('neutral',  'medium_term', 0.65),
    'fno':               ('neutral',  'short_term',  0.68),
    'institutional':     ('bullish',  'medium_term', 0.72),
    'insider':           ('bullish',  'medium_term', 0.70),
    'earnings':          ('bullish',  'short_term',  0.70),
    'other':             ('neutral',  'medium_term', 0.65),
}

BEARISH_KEYWORDS = r"breakdown|sell|short|fall|decline|bearish|overbought|death.cross"


def classify_screener(name: str) -> str | None:
    nl = (name or '').lower()

    # Special Value / Reversal / Turnaround Overrides
    if 'turnaround' in nl and 'loss to profit' in nl:
        return 'bullish'
    if 'good fundamental' in nl and 'near 52 week low' in nl:
        return 'bullish'
    if any(k in nl for k in [
        'pe less than industry', 'pe less than sector', 'peg lower than industry',
        'peg lower than sector', 'price to book value (p/bv) less than'
    ]):
        return 'bullish'

    # Technical Bearish / Sell indicators
    if any(k in nl for k in [
        'trending down', 'crossed below', 'crossed -80 from above', 'overbought',
        'bearish', 'breakdown', 'death cross', 'lower low', 'volume loser',
        'downgrade', 'profit fall', 'loss', 'new 52 week low', 'underperform',
        'promoter pledge', 'high debt', 'less than industry', 'lower than sector',
        'less than sector', 'lower than industry', 'falling rsi', 'macd negative',
        'signal changed to sell', 'negative surprise', 'negative revenue growth',
        'negative quarterly', 'negative eps', 'analysts estimate negative', 'profit to loss'
    ]):
        return 'bearish'

    # Technical Bullish / Buy indicators
    if any(k in nl for k in [
        'trending up', 'crossed above', 'oversold', 'bullish', 'breakout',
        'golden cross', 'higher high', 'volume gainer', 'signal changed to buy',
        'new 52 week high', 'high delivery', 'volume spike', 'fii buying', 'dii buying',
        'profit growth', 'revenue growth', 'earnings beat', 'upgrade', 'outperform',
        'strong buy', 'high momentum', 'multibagger', 'piotroski score', 'high roe',
        'positive surprise', 'positive revenue growth', 'positive quarterly', 'positive eps',
        'analysts estimate positive'
    ]):
        return 'bullish'

    return None

def resolve_screener_defaults(category: str, sentiment: str | None, name: str) -> tuple[str, str, str, float]:
    """Pure: (signal_bias, cat_norm, investment_horizon, confidence) for a screener_master
    row being inserted into screener_catalog (Step 5)."""
    # 1. Check domain classifier first
    domain_bias = classify_screener(name)
    if domain_bias:
        bias = domain_bias
    elif sentiment and sentiment in ('bullish', 'bearish', 'neutral'):
        bias = sentiment
    elif re.search(_safe_pattern(BEARISH_KEYWORDS), name.lower()):
        bias = 'bearish'
    elif category == 'sector_theme':
        bias = 'neutral'
    else:
        bias = 'neutral'

    cat_norm = category
    _, horizon, confidence = CATEGORY_DEFAULTS.get(category, ('neutral', 'medium_term', 0.65))
    return bias, cat_norm, horizon, confidence


def load_catalog_rows_for_name_enrichment(con):
    """Step 2's name-lookup: rows still missing signal_keywords, joined against
    trendlyne_screeners/screener_master for a display name. Extracted so a regression in the
    LOWER(sc.source) join condition (AF-20260816-19 -- screener_catalog.source holds both
    'trendlyne' and 'Trendlyne' live) actually fails a test, rather than a hand-copied mirror of
    the query passing regardless of what the real one says -- see resolve_screener_defaults()
    above for the same reasoning applied to Step 5."""
    return con.execute("""
        SELECT sc.screener_id, sc.source, sc.screener_name,
               ts.screenpk, ts.screener_url AS ts_url, ts.screener_name AS ts_name,
               sm.name AS sm_name
        FROM screener_catalog sc
        LEFT JOIN trendlyne_screeners ts ON ts.screener_id = sc.screener_id AND LOWER(sc.source) = 'trendlyne'
        LEFT JOIN screener_master sm ON sm.scan_id = sc.screener_id
        WHERE sc.signal_keywords IS NULL OR sc.signal_keywords = ''
    """).fetchall()


def run():
    con = connect()

    # ── Step 1: Ensure columns exist ─────────────────────────────────────────
    for col in ["signal_keywords TEXT", "screener_url TEXT"]:
        try:
            con.execute(f"ALTER TABLE screener_catalog ADD COLUMN IF NOT EXISTS {col}")
            con.commit()
        except Exception:
            con.rollback()

    for col in ["signal_type_tag TEXT", "screener_url TEXT"]:
        try:
            con.execute(f"ALTER TABLE screener_master ADD COLUMN IF NOT EXISTS {col}")
            con.commit()
        except Exception:
            con.rollback()

    # ── Step 2: Load screener names from all sources ──────────────────────────
    # screener_catalog: join on screener_master or trendlyne_screeners for name
    rows = load_catalog_rows_for_name_enrichment(con)

    print(f"[CatalogEnricher] {len(rows)} screener_catalog rows to enrich")
    catalog_updated = 0

    for row in rows:
        scid    = row[0]
        source  = row[1]
        name    = row[2] or row[6] or row[5] or scid  # catalog name > sm.name > ts.name > id
        screenpk = row[3]
        ts_url  = row[4]

        kw = extract_signal_keywords(name)
        url = ts_url or (tl_screener_url(screenpk) if source == "trendlyne" and screenpk else None)

        # WHERE screener_id = ? alone (no source filter) let this silently overwrite a
        # DIFFERENT provider's row sharing the same numeric screener_id with keywords/url
        # derived from THIS row's source -- same class as trendlyne_screener_discovery.py's fix,
        # cross-writer-collision-audit 2026-08-14. `source` here is this loop's own per-row
        # value (from the `rows` query), so scoping to it is correct, not just defensive.
        con.execute("""
            UPDATE screener_catalog
            SET signal_keywords = ?,
                screener_url = COALESCE(screener_url, ?)
            WHERE screener_id = ? AND source = ?
        """, (kw, url, scid, source))
        catalog_updated += 1

    con.commit()
    print(f"[CatalogEnricher] screener_catalog: {catalog_updated} rows updated with signal_keywords")

    # ── Step 3: Backfill trendlyne_screeners.screener_url from screenpk ──────
    ts_rows = con.execute("""
        SELECT id, screenpk FROM trendlyne_screeners
        WHERE screenpk IS NOT NULL AND (screener_url IS NULL OR screener_url = '')
    """).fetchall()

    ts_updated = 0
    for row in ts_rows:
        url = tl_screener_url(row[1])
        con.execute("UPDATE trendlyne_screeners SET screener_url = ? WHERE id = ?", (url, row[0]))
        ts_updated += 1

    con.commit()
    print(f"[CatalogEnricher] trendlyne_screeners: {ts_updated} screener_url backfilled from screenpk")

    # ── Step 4: Fill screener_master.signal_type_tag ─────────────────────────
    # source is required both to fetch (so trendlyne_screeners is only consulted for a
    # Trendlyne row) and to scope the UPDATE below -- scan_id collides across providers
    # (2026-08-04 memory), and an unscoped UPDATE would tag both colliding rows identically.
    # BUG FOUND 2026-08-07 (dead-column sweep): the original WHERE clause gated re-selection
    # purely on signal_type_tag, so once that column reached 100% coverage (confirmed live:
    # 1,669/1,669), this loop selected ZERO rows on every subsequent run -- permanently, even
    # though the loop body ALSO derives screener_url, which was 0/1,669 the whole time as a
    # result (same bug class fixed earlier this session in screener_appearances.phase_b_fill_returns:
    # a fill-missing-columns loop gated on only one of the columns it fills). Now re-selects a
    # row if EITHER target column is still missing -- extract_signal_keywords() is a cheap pure
    # function, so recomputing it for already-tagged rows is harmless and idempotent.
    sm_rows = con.execute("""
        SELECT scan_id, name, source FROM screener_master
        WHERE signal_type_tag IS NULL OR signal_type_tag = ''
           OR screener_url IS NULL OR screener_url = ''
    """).fetchall()

    sm_updated = 0
    for row in sm_rows:
        kw = extract_signal_keywords(row[1] or row[0])
        if kw:
            # also derive a screener_url if the scan_id matches a trendlyne_screeners pk
            url = None
            if row[2] == 'Trendlyne':
                ts_row = con.execute(
                    "SELECT screenpk, screener_url FROM trendlyne_screeners WHERE screener_id = ? LIMIT 1",
                    (row[0],)
                ).fetchone()
                if ts_row:
                    url = ts_row[1] or tl_screener_url(ts_row[0])
            con.execute("""
                UPDATE screener_master
                SET signal_type_tag = ?,
                    screener_url = COALESCE(screener_url, ?)
                WHERE scan_id = ? AND source = ?
            """, (kw, url, row[0], row[2]))
            sm_updated += 1

    con.commit()
    print(f"[CatalogEnricher] screener_master: {sm_updated} signal_type_tag rows filled")

    # ── Step 5: INSERT missing screener_catalog entries from screener_master ────
    # 858 screener_master rows have no catalog entry. Insert them with NLP-derived bias.
    # sc.source vs sm.source case mismatch: screener_catalog historically got both 'trendlyne'
    # and 'Trendlyne' rows (2026-08 screener_signal_generator.py comment documents the same
    # split) -- match case-insensitively so a lowercase-cataloged screener isn't re-inserted,
    # and source-scope the NOT EXISTS so a genuinely-missing MoneyControl/ETnow scan_id isn't
    # silently skipped just because an unrelated provider's screener happens to share the same
    # numeric scan_id (2026-08-04 screener_master collision class) and already has a row.
    missing = con.execute("""
        SELECT sm.scan_id, sm.name, sm.source, sm.inferred_sentiment, sm.inferred_category,
               ts.screenpk, ts.screener_url AS ts_url
        FROM screener_master sm
        LEFT JOIN trendlyne_screeners ts ON ts.screener_id = sm.scan_id
        WHERE NOT EXISTS (
            SELECT 1 FROM screener_catalog sc
            WHERE sc.screener_id = sm.scan_id AND LOWER(sc.source) = LOWER(sm.source)
        )
    """).fetchall()

    print(f"[CatalogEnricher] {len(missing)} screener_master entries to INSERT into screener_catalog")

    inserted = 0
    for row in missing:
        scan_id  = row[0]
        name     = row[1] or scan_id
        # Lowercased: unified_ranker.py's _get_screener_membership() joins screener_catalog on
        # a hardcoded lowercase literal ('trendlyne'/'moneycontrol'/'etnow'), case-sensitively,
        # not LOWER(sc.source) -- inserting screener_master's raw capitalized source
        # ('MoneyControl') here would silently reproduce the exact orphaned-row bug this run is
        # meant to close (874 pre-existing screener_catalog rows already sit under a capitalized
        # source and are never read by that join; verified live 2026-08-04).
        source   = (row[2] or 'unknown').lower()
        sentiment = row[3]
        category  = row[4] or 'other'
        screenpk  = row[5]
        ts_url    = row[6]

        kw = extract_signal_keywords(name)
        bias, cat_norm, horizon, confidence = resolve_screener_defaults(category, sentiment, name)

        url = ts_url or (tl_screener_url(screenpk) if source == 'trendlyne' and screenpk else None)

        try:
            con.execute("""
                INSERT INTO screener_catalog
                  (screener_id, screener_name, source, signal_bias, category,
                   investment_horizon, confidence, signal_keywords, screener_url)
                SELECT ?,?,?,?,?, ?,?,?,?
                WHERE NOT EXISTS (
                    SELECT 1 FROM screener_catalog WHERE screener_id = ? AND LOWER(source) = LOWER(?)
                )
            """, (scan_id, name, source, bias, cat_norm, horizon, confidence, kw, url, scan_id, source))
            inserted += 1
        except Exception as e:
            print(f"  [WARN] Cannot insert {scan_id}: {e}", file=sys.stderr)
            con.rollback()

    con.commit()
    print(f"[CatalogEnricher] screener_catalog: {inserted} new rows inserted from screener_master")

    # ── Step 5b: Backfill category for EXISTING rows the CATEGORY_DEFAULTS bug already hit ──
    # The Step 5 fix above only stops NEW rows losing their category -- it does nothing for the
    # screener_catalog rows this already corrupted (they already exist, so Step 5's `missing`
    # query's NOT EXISTS clause skips them entirely). Repair by pulling the real category back
    # from screener_master wherever they've diverged and screener_master actually has a better
    # answer (not 'other' or NULL itself).
    drift = con.execute("""
        SELECT sc.screener_id, sc.source, sm.inferred_category
        FROM screener_catalog sc
        JOIN screener_master sm ON sm.scan_id = sc.screener_id AND LOWER(sm.source) = LOWER(sc.source)
        WHERE sc.category = 'other' AND sm.inferred_category IS NOT NULL AND sm.inferred_category != 'other'
    """).fetchall()
    for sid, src, real_cat in drift:
        con.execute(
            "UPDATE screener_catalog SET category = ? WHERE screener_id = ? AND source = ?",
            (real_cat, sid, src),
        )
    con.commit()
    print(f"[CatalogEnricher] screener_catalog: {len(drift)} existing rows' category backfilled from screener_master")

    # ── Step 6: Fix sector_theme signal_bias — force neutral unless directional ─
    # Screeners in the sector_theme category that have generic universe names
    # (no directional keyword in the name) should be neutral, not bullish.
    DIRECTIONAL_KW = r"rising|growing|improving|breakout|momentum|strong|profit|roe|bullish|outperform|beat"
    sector_fixed = 0
    sector_rows = con.execute("""
        SELECT screener_id, screener_name FROM screener_catalog
        WHERE category = 'sector_theme' AND signal_bias = 'bullish'
    """).fetchall()

    for sid, sname in sector_rows:
        has_direction = re.search(_safe_pattern(DIRECTIONAL_KW), (sname or "").lower())
        if not has_direction:
            con.execute("""
                UPDATE screener_catalog SET signal_bias = 'neutral' WHERE screener_id = ?
            """, (sid,))
            sector_fixed += 1

    con.commit()
    print(f"[CatalogEnricher] sector_theme: {sector_fixed} wrongly-bullish screeners corrected to neutral")

    # ── Step 7: Summary ───────────────────────────────────────────────────────
    r = con.execute("""
        SELECT
          COUNT(*) FILTER(WHERE signal_keywords IS NOT NULL AND signal_keywords != '') AS kw_filled,
          COUNT(*) FILTER(WHERE signal_bias = 'bullish') AS bull,
          COUNT(*) FILTER(WHERE signal_bias = 'bearish') AS bear,
          COUNT(*) FILTER(WHERE signal_bias = 'neutral') AS neutral,
          COUNT(*) AS total
        FROM screener_catalog
    """).fetchone()
    print(f"[CatalogEnricher] Final: screener_catalog signal_keywords {r[0]}/{r[4]}")
    print(f"[CatalogEnricher] Final: bias distribution — bull={r[1]}, bear={r[2]}, neutral={r[3]}")

    r2 = con.execute("""
        SELECT
          COUNT(*) FILTER(WHERE screener_url IS NOT NULL) AS url_filled,
          COUNT(*) AS total
        FROM trendlyne_screeners
    """).fetchone()
    print(f"[CatalogEnricher] Final: trendlyne_screeners screener_url {r2[0]}/{r2[1]}")

    con.close()


if __name__ == "__main__":
    run()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
