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
import re
from db_compat import connect

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


def run():
    con = connect()

    # ── Step 1: Ensure columns exist ─────────────────────────────────────────
    for col in ["signal_keywords TEXT", "screener_url TEXT"]:
        try:
            con.execute(f"ALTER TABLE screener_catalog ADD COLUMN IF NOT EXISTS {col}")
            con.commit()
        except Exception:
            con.execute("ROLLBACK")

    for col in ["signal_type_tag TEXT", "screener_url TEXT"]:
        try:
            con.execute(f"ALTER TABLE screener_master ADD COLUMN IF NOT EXISTS {col}")
            con.commit()
        except Exception:
            con.execute("ROLLBACK")

    # ── Step 2: Load screener names from all sources ──────────────────────────
    # screener_catalog: join on screener_master or trendlyne_screeners for name
    rows = con.execute("""
        SELECT sc.screener_id, sc.source, sc.screener_name,
               ts.screenpk, ts.screener_url AS ts_url, ts.screener_name AS ts_name,
               sm.name AS sm_name
        FROM screener_catalog sc
        LEFT JOIN trendlyne_screeners ts ON ts.screener_id = sc.screener_id AND sc.source = 'trendlyne'
        LEFT JOIN screener_master sm ON sm.scan_id = sc.screener_id
        WHERE sc.signal_keywords IS NULL OR sc.signal_keywords = ''
    """).fetchall()

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

        con.execute("""
            UPDATE screener_catalog
            SET signal_keywords = ?,
                screener_url = COALESCE(screener_url, ?)
            WHERE screener_id = ?
        """, (kw, url, scid))
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
    sm_rows = con.execute("""
        SELECT scan_id, name FROM screener_master
        WHERE signal_type_tag IS NULL OR signal_type_tag = ''
    """).fetchall()

    sm_updated = 0
    for row in sm_rows:
        kw = extract_signal_keywords(row[1] or row[0])
        if kw:
            # also derive a screener_url if the scan_id matches a trendlyne_screeners pk
            ts_row = con.execute(
                "SELECT screenpk, screener_url FROM trendlyne_screeners WHERE screener_id = ? LIMIT 1",
                (row[0],)
            ).fetchone()
            url = None
            if ts_row:
                url = ts_row[1] or tl_screener_url(ts_row[0])
            con.execute("""
                UPDATE screener_master
                SET signal_type_tag = ?,
                    screener_url = COALESCE(screener_url, ?)
                WHERE scan_id = ?
            """, (kw, url, row[0]))
            sm_updated += 1

    con.commit()
    print(f"[CatalogEnricher] screener_master: {sm_updated} signal_type_tag rows filled")

    # ── Step 5: Summary ───────────────────────────────────────────────────────
    r = con.execute("""
        SELECT
          COUNT(*) FILTER(WHERE signal_keywords IS NOT NULL AND signal_keywords != '') AS kw_filled,
          COUNT(*) AS total
        FROM screener_catalog
    """).fetchone()
    print(f"[CatalogEnricher] Final: screener_catalog signal_keywords {r[0]}/{r[1]}")

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
