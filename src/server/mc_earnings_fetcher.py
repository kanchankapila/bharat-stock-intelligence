#!/usr/bin/env python3
"""
MoneyControl Earnings Fetcher (Daily)
======================================
Fetches 5 MC earnings APIs to build earnings-related ML features:

  1. Upcoming results dates      → days_to_next_results (pre-earnings run-up signal)
  2. Rapid results categories    → earnings_category_yoy/qoq, earnings_np_growth (PEAD signal)
  3. Price shockers              → earnings_shocker_flag/gain (sustained PEAD momentum)
  4. Sector earnings quality     → mc_sector_earnings table (sector tailwind/headwind)
  5. Market dashboard + inc-widget → macro_asset_prices (earnings regime signal)

All endpoints require curl_cffi (Cloudflare bypass).

Run:
  python mc_earnings_fetcher.py
  python mc_earnings_fetcher.py --skip-rapid
"""

import argparse
import sys
import time
from datetime import date, datetime, timedelta

from curl_cffi import requests as cffi_req

from db_compat import connect, use_postgres

# ── Constants ────────────────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Accept": "application/json",
}

RATE_LIMIT_SEC = 0.4

RAPID_TYPES = ["BP", "WP", "PT", "NT", "LR"]
RAPID_SUBTYPES = ["yoy", "qoq"]
RAPID_PAGES = 5

CATEGORY_SCORE = {"BP": 2, "PT": 1, "LR": 0, "WP": -1, "NT": -2}

TODAY = date.today().isoformat()
TODAY_PLUS_14 = (date.today() + timedelta(days=14)).isoformat()


# ── HTTP helper ──────────────────────────────────────────────────────────────────

def _get(url: str):
    """Fetch a MC API URL via curl_cffi. Returns data dict or None on failure."""
    try:
        r = cffi_req.get(url, headers=HEADERS, impersonate="chrome110", timeout=12)
        d = r.json()
        if d.get("success") != 1:
            return None
        return d["data"]
    except Exception as e:
        print(f"[EarningsFetcher] HTTP error for {url}: {e}", file=sys.stderr)
        return None


# ── Schema ───────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()

    # Table: stock_earnings_dates
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_earnings_dates (
            scid         TEXT NOT NULL,
            result_date  TEXT NOT NULL,
            stock_name   TEXT,
            result_type  TEXT,
            result_time  TEXT,
            market_cap   REAL,
            exchange     TEXT,
            fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (scid, result_date)
        )
    """)

    # Table: mc_earnings_rapid
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mc_earnings_rapid (
            scid              TEXT NOT NULL,
            sub_type          TEXT NOT NULL,
            category          TEXT NOT NULL,
            result_date       TEXT,
            stock_name        TEXT,
            ltp               REAL,
            change_pct        REAL,
            revenue_curr      REAL,
            revenue_prev      REAL,
            revenue_growth    REAL,
            np_curr           REAL,
            np_prev           REAL,
            np_growth         REAL,
            category_score    INTEGER,
            fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (scid, sub_type, category)
        )
    """)

    # Table: mc_price_shockers
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mc_price_shockers (
            scid              TEXT PRIMARY KEY,
            stock_name        TEXT,
            result_date       TEXT,
            gain_since_result REAL,
            ltp               REAL,
            change_pct        REAL,
            fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Table: mc_sector_earnings
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mc_sector_earnings (
            sector_name      TEXT PRIMARY KEY,
            market_cap       REAL,
            rev_growth_yoy   REAL,
            rev_growth_qoq   REAL,
            np_growth_yoy    REAL,
            np_growth_qoq    REAL,
            gp_growth_yoy    REAL,
            gp_growth_qoq    REAL,
            fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    con.commit()

    # Add new columns to technical_signals (safe no-op if already present)
    new_ts_cols = [
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS days_to_next_results   INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_category_yoy  INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_category_qoq  INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_np_growth_yoy REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_np_growth_qoq REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_shocker_flag  INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS earnings_shocker_gain  REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS eps_beat_last_q        REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mc_eps_vs_cons         REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS positive_turnaround    INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS negative_turnaround    INTEGER",
    ]
    for ddl in new_ts_cols:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── API 1: Upcoming earnings dates ───────────────────────────────────────────────

def fetch_earnings_dates(con) -> None:
    url = (
        f"https://api.moneycontrol.com/mcapi/v1/earnings/get-earnings-data"
        f"?indexId=All&page=1&startDate={TODAY}&endDate={TODAY_PLUS_14}"
        f"&sector=&limit=50"
    )
    data = _get(url)
    if not data:
        print("[EarningsFetcher] Upcoming: no data returned")
        return

    items = data.get("list") or []
    rows = []
    for item in items:
        raw_date = item.get("date", "")  # e.g. "30 Jun"
        # Parse "30 Jun" → YYYY-MM-DD (assume current year; if month < today's month → next year)
        try:
            parsed = datetime.strptime(f"{raw_date} {date.today().year}", "%d %b %Y")
            if parsed.date() < date.today():
                parsed = parsed.replace(year=date.today().year + 1)
            result_date = parsed.date().isoformat()
        except ValueError:
            result_date = raw_date  # store as-is if unparseable

        rows.append((
            item.get("scId", ""),
            result_date,
            item.get("stockName"),
            item.get("resultType"),
            item.get("time"),
            item.get("marketCap"),
            item.get("exchange"),
        ))

    if rows:
        cur = con.cursor()
        cur.executemany("""
            INSERT INTO stock_earnings_dates
                (scid, result_date, stock_name, result_type, result_time, market_cap, exchange)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scid, result_date) DO UPDATE SET
                stock_name  = excluded.stock_name,
                result_type = excluded.result_type,
                result_time = excluded.result_time,
                market_cap  = excluded.market_cap,
                exchange    = excluded.exchange,
                fetched_at  = CURRENT_TIMESTAMP
        """, rows)
        con.commit()

    # Backfill days_to_next_results into technical_signals via mc_pricefeed_daily join
    _backfill_days_to_results(con)
    print(f"[EarningsFetcher] Upcoming: {len(rows)} stocks with results in next 14 days -> days_to_next_results updated")


def _backfill_days_to_results(con) -> None:
    """Update technical_signals.days_to_next_results by joining via mc_pricefeed_daily.scid."""
    cur = con.cursor()
    if use_postgres():
        cur.execute("""
            UPDATE technical_signals ts
            SET days_to_next_results = subq.days
            FROM (
                SELECT ns.symbol,
                       (MIN(sed.result_date::date) - CURRENT_DATE) AS days
                FROM stock_earnings_dates sed
                JOIN nse_stocks ns ON ns.mcsymbol = sed.scid
                WHERE sed.result_date >= CURRENT_DATE::text
                GROUP BY ns.symbol
            ) subq
            WHERE ts.symbol = subq.symbol
              AND ts.date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = ts.symbol)
        """)
    else:
        cur.execute("""
            UPDATE technical_signals
            SET days_to_next_results = (
                SELECT CAST(MIN(julianday(sed.result_date) - julianday('now')) AS INTEGER)
                FROM stock_earnings_dates sed
                JOIN nse_stocks ns ON ns.mcsymbol = sed.scid
                WHERE ns.symbol = technical_signals.symbol
                  AND sed.result_date >= date('now')
            )
        """)
    con.commit()


# ── API 2: Rapid results categories ─────────────────────────────────────────────

def fetch_rapid_results(con) -> None:
    total = 0
    category_counts = {t: 0 for t in RAPID_TYPES}
    # Accumulate best row per (scid, sub_type) keyed by category priority
    # Store all rows and upsert; last write wins per PRIMARY KEY
    all_rows = []

    for sub_type in RAPID_SUBTYPES:
        for rtype in RAPID_TYPES:
            for page in range(1, RAPID_PAGES + 1):
                url = (
                    f"https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results"
                    f"?limit=50&page={page}&type={rtype}&subType={sub_type}"
                )
                data = _get(url)
                if not data:
                    break

                items = data.get("list") or []
                if not items:
                    break

                for item in items:
                    # Positional: [date, stockName, seoString, ltp, changeP, quarterData, scID, exchange, financialType]
                    try:
                        result_date = item[0] if len(item) > 0 else None
                        stock_name  = item[1] if len(item) > 1 else None
                        ltp         = _safe_float(item[3]) if len(item) > 3 else None
                        change_pct  = _safe_float(item[4]) if len(item) > 4 else None
                        quarter_data = item[5] if len(item) > 5 else []
                        scid        = item[6] if len(item) > 6 else None

                        if not scid:
                            continue

                        # Parse quarterData = [[metric, curr, prev, growth_pct], ...]
                        rev_curr = rev_prev = rev_growth = None
                        np_curr  = np_prev  = np_growth  = None
                        for metric_row in (quarter_data or []):
                            if not metric_row or len(metric_row) < 4:
                                continue
                            metric_name = str(metric_row[0]).lower()
                            if "revenue" in metric_name:
                                rev_curr   = _safe_float(metric_row[1])
                                rev_prev   = _safe_float(metric_row[2])
                                rev_growth = _safe_float(metric_row[3])
                            elif "net profit" in metric_name:
                                np_curr    = _safe_float(metric_row[1])
                                np_prev    = _safe_float(metric_row[2])
                                np_growth  = _safe_float(metric_row[3])

                        all_rows.append((
                            scid,
                            sub_type,
                            rtype,
                            result_date,
                            stock_name,
                            ltp,
                            change_pct,
                            rev_curr,
                            rev_prev,
                            rev_growth,
                            np_curr,
                            np_prev,
                            np_growth,
                            CATEGORY_SCORE.get(rtype, 0),
                        ))
                        total += 1
                        category_counts[rtype] += 1

                    except (IndexError, TypeError):
                        continue

                time.sleep(RATE_LIMIT_SEC)

                if len(items) < 50:
                    break  # last page

    # Upsert all rows
    if all_rows:
        cur = con.cursor()
        cur.executemany("""
            INSERT INTO mc_earnings_rapid
                (scid, sub_type, category, result_date, stock_name, ltp, change_pct,
                 revenue_curr, revenue_prev, revenue_growth,
                 np_curr, np_prev, np_growth, category_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scid, sub_type, category) DO UPDATE SET
                result_date    = excluded.result_date,
                stock_name     = excluded.stock_name,
                ltp            = excluded.ltp,
                change_pct     = excluded.change_pct,
                revenue_curr   = excluded.revenue_curr,
                revenue_prev   = excluded.revenue_prev,
                revenue_growth = excluded.revenue_growth,
                np_curr        = excluded.np_curr,
                np_prev        = excluded.np_prev,
                np_growth      = excluded.np_growth,
                category_score = excluded.category_score,
                fetched_at     = CURRENT_TIMESTAMP
        """, all_rows)
        con.commit()

    # Backfill technical_signals with best (most recent / highest priority) row per symbol+subtype
    mapped = _backfill_rapid_features(con)

    counts_str = ", ".join(f"{t}:{category_counts[t]}" for t in RAPID_TYPES)
    print(f"[EarningsFetcher] Rapid: {total} total ({counts_str}) -> {mapped} mapped to NSE symbols")


def _backfill_rapid_features(con) -> int:
    """Update technical_signals with earnings category scores and NP growth from rapid results."""
    cur = con.cursor()

    # For each symbol in technical_signals, find the most recent rapid result per sub_type.
    # We pick the row with the highest |category_score| (strongest signal) when multiple exist.
    if use_postgres():
        # Primary join via nse_stocks.mcsymbol (2260+ entries); mc_pricefeed_daily as secondary.
        cur.execute("""
            UPDATE technical_signals ts
            SET
                earnings_category_yoy  = yoy.category_score,
                earnings_np_growth_yoy = yoy.np_growth,
                earnings_category_qoq  = qoq.category_score,
                earnings_np_growth_qoq = qoq.np_growth,
                positive_turnaround    = CASE WHEN yoy.category_score = 1 THEN 1 ELSE 0 END,
                negative_turnaround    = CASE WHEN yoy.category_score = -2 THEN 1 ELSE 0 END
            FROM (
                SELECT DISTINCT ON (ns.symbol)
                    ns.symbol,
                    r.category_score,
                    r.np_growth
                FROM mc_earnings_rapid r
                JOIN nse_stocks ns ON ns.mcsymbol = r.scid
                WHERE r.sub_type = 'yoy'
                ORDER BY ns.symbol, ABS(r.category_score) DESC
            ) yoy
            LEFT JOIN (
                SELECT DISTINCT ON (ns.symbol)
                    ns.symbol,
                    r.category_score,
                    r.np_growth
                FROM mc_earnings_rapid r
                JOIN nse_stocks ns ON ns.mcsymbol = r.scid
                WHERE r.sub_type = 'qoq'
                ORDER BY ns.symbol, ABS(r.category_score) DESC
            ) qoq ON qoq.symbol = yoy.symbol
            WHERE ts.symbol = yoy.symbol
              AND ts.date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = ts.symbol)
        """)
    else:
        for col_score, col_growth, sub_type in [
            ("earnings_category_yoy", "earnings_np_growth_yoy", "yoy"),
            ("earnings_category_qoq", "earnings_np_growth_qoq", "qoq"),
        ]:
            cur.execute(f"""
                UPDATE technical_signals
                SET
                    {col_score}  = (
                        SELECT r.category_score
                        FROM mc_earnings_rapid r
                        JOIN mc_pricefeed_daily mpd ON mpd.scid = r.scid
                        WHERE mpd.symbol = technical_signals.symbol
                          AND r.sub_type = ?
                        ORDER BY ABS(r.category_score) DESC
                        LIMIT 1
                    ),
                    {col_growth} = (
                        SELECT r.np_growth
                        FROM mc_earnings_rapid r
                        JOIN mc_pricefeed_daily mpd ON mpd.scid = r.scid
                        WHERE mpd.symbol = technical_signals.symbol
                          AND r.sub_type = ?
                        ORDER BY ABS(r.category_score) DESC
                        LIMIT 1
                    )
            """, [sub_type, sub_type])
    con.commit()

    # Count how many technical_signals rows got a non-null yoy category
    cur.execute("SELECT COUNT(*) FROM technical_signals WHERE earnings_category_yoy IS NOT NULL")
    row = cur.fetchone()
    return row[0] if row else 0


# ── API 3: Price shockers ────────────────────────────────────────────────────────

def fetch_price_shockers(con) -> None:
    url = "https://api.moneycontrol.com/mcapi/v1/earnings/price-shockers?limit=50&page=1"
    data = _get(url)
    if not data:
        print("[EarningsFetcher] Shockers: no data returned")
        return

    items = data.get("list") or []
    rows = []
    for item in items:
        # Positional: [scID, exchange, Name, result_date_str, ltp, change_pct, gain_since_result_pct, analysis_text, stockURL]
        try:
            scid              = item[0] if len(item) > 0 else None
            stock_name        = item[2] if len(item) > 2 else None
            result_date_str   = item[3] if len(item) > 3 else None
            ltp               = _safe_float(item[4]) if len(item) > 4 else None
            change_pct        = _safe_float(item[5]) if len(item) > 5 else None
            gain_since_result = _safe_float(item[6]) if len(item) > 6 else None

            if not scid:
                continue

            # Parse result_date_str "04/05/26" → "2026-05-04"
            result_date = _parse_dmy_short(result_date_str)

            rows.append((scid, stock_name, result_date, gain_since_result, ltp, change_pct))
        except (IndexError, TypeError):
            continue

    if rows:
        cur = con.cursor()
        cur.executemany("""
            INSERT INTO mc_price_shockers
                (scid, stock_name, result_date, gain_since_result, ltp, change_pct)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scid) DO UPDATE SET
                stock_name        = excluded.stock_name,
                result_date       = excluded.result_date,
                gain_since_result = excluded.gain_since_result,
                ltp               = excluded.ltp,
                change_pct        = excluded.change_pct,
                fetched_at        = CURRENT_TIMESTAMP
        """, rows)
        con.commit()

    # Backfill technical_signals
    _backfill_shockers(con)

    avg_gain = 0.0
    valid_gains = [r[3] for r in rows if r[3] is not None]
    if valid_gains:
        avg_gain = sum(valid_gains) / len(valid_gains)
    print(f"[EarningsFetcher] Shockers: {len(rows)} stocks, avg gain +{avg_gain:.1f}% since results")


def _backfill_shockers(con) -> None:
    cur = con.cursor()
    if use_postgres():
        cur.execute("""
            UPDATE technical_signals ts
            SET
                earnings_shocker_flag = 1,
                earnings_shocker_gain = s.gain_since_result
            FROM mc_price_shockers s
            JOIN nse_stocks ns ON ns.mcsymbol = s.scid
            WHERE ts.symbol = ns.symbol
              AND ts.date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = ts.symbol)
        """)
        cur.execute("""
            UPDATE technical_signals ts
            SET earnings_shocker_flag = 0
            WHERE NOT EXISTS (
                SELECT 1 FROM mc_price_shockers s
                JOIN nse_stocks ns ON ns.mcsymbol = s.scid
                WHERE ns.symbol = ts.symbol
            ) AND ts.date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = ts.symbol)
        """)
    else:
        cur.execute("""
            UPDATE technical_signals
            SET
                earnings_shocker_flag = (
                    SELECT 1 FROM mc_price_shockers s
                    JOIN nse_stocks ns ON ns.mcsymbol = s.scid
                    WHERE ns.symbol = technical_signals.symbol
                    LIMIT 1
                ),
                earnings_shocker_gain = (
                    SELECT s.gain_since_result FROM mc_price_shockers s
                    JOIN nse_stocks ns ON ns.mcsymbol = s.scid
                    WHERE ns.symbol = technical_signals.symbol
                    LIMIT 1
                )
        """)
    con.commit()


# ── API 4: Sector earnings quality ───────────────────────────────────────────────

def fetch_sector_performers(con) -> None:
    url = (
        "https://api.moneycontrol.com/mcapi/v1/earnings/get-performers-detailed"
        "?sortBy=all&orderBy=mc&page=1&seq=desc&type=all"
    )
    data = _get(url)
    if not data:
        print("[EarningsFetcher] Sectors: no data returned")
        return

    items = data.get("list") or []
    rows = []
    for item in items:
        # Positional: [sector_name, market_cap_str, [[metric, qoq_growth, yoy_growth], ...]]
        try:
            sector_name = item[0] if len(item) > 0 else None
            market_cap  = _safe_float(item[1]) if len(item) > 1 else None
            metrics     = item[2] if len(item) > 2 else []

            if not sector_name:
                continue

            rev_qoq = rev_yoy = np_qoq = np_yoy = gp_qoq = gp_yoy = None
            for metric_row in (metrics or []):
                if not metric_row or len(metric_row) < 3:
                    continue
                name = str(metric_row[0]).lower()
                qoq  = _safe_float(metric_row[1])
                yoy  = _safe_float(metric_row[2])
                if "revenue" in name or "sales" in name:
                    rev_qoq, rev_yoy = qoq, yoy
                elif "net profit" in name:
                    np_qoq, np_yoy = qoq, yoy
                elif "gross profit" in name or "operating profit" in name or "ebitda" in name:
                    gp_qoq, gp_yoy = qoq, yoy

            rows.append((sector_name, market_cap, rev_yoy, rev_qoq, np_yoy, np_qoq, gp_yoy, gp_qoq))
        except (IndexError, TypeError):
            continue

    if rows:
        cur = con.cursor()
        cur.executemany("""
            INSERT INTO mc_sector_earnings
                (sector_name, market_cap, rev_growth_yoy, rev_growth_qoq,
                 np_growth_yoy, np_growth_qoq, gp_growth_yoy, gp_growth_qoq)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sector_name) DO UPDATE SET
                market_cap       = excluded.market_cap,
                rev_growth_yoy   = excluded.rev_growth_yoy,
                rev_growth_qoq   = excluded.rev_growth_qoq,
                np_growth_yoy    = excluded.np_growth_yoy,
                np_growth_qoq    = excluded.np_growth_qoq,
                gp_growth_yoy    = excluded.gp_growth_yoy,
                gp_growth_qoq    = excluded.gp_growth_qoq,
                fetched_at       = CURRENT_TIMESTAMP
        """, rows)
        con.commit()

    print(f"[EarningsFetcher] Sectors: {len(rows)} sectors updated in mc_sector_earnings")


# ── API 5: Market dashboard + inc-widget ─────────────────────────────────────────

def fetch_market_dashboard(con) -> None:
    dashboard_url = "https://api.moneycontrol.com/mcapi/v1/earnings/result-dashboard"
    widget_url    = "https://api.moneycontrol.com/mcapi/v1/earnings/inc-widget?indexId=all"

    dashboard = _get(dashboard_url)
    widget    = _get(widget_url)

    breadth_pct = None
    np_yoy      = None
    rev_yoy     = None
    acceleration = None

    if dashboard:
        positive = _safe_float(dashboard.get("postiveGrowth"))
        negative = _safe_float(dashboard.get("negativeGrowth"))
        np_yoy   = _safe_float(dashboard.get("netProfitYoy"))
        rev_yoy  = _safe_float(dashboard.get("revenueYoy"))
        if positive is not None and negative is not None and (positive + negative) > 0:
            breadth_pct = positive / (positive + negative)

    # Compute earnings acceleration from 5-quarter NP trend in inc-widget
    if widget:
        items = widget.get("list") or []
        # Find the "all" or first index row; each row: [indexName, [[metric, curr, prev, [5_qtrs], growth], ...], overall_growth]
        for idx_row in items:
            if not idx_row or len(idx_row) < 2:
                continue
            metric_list = idx_row[1] if isinstance(idx_row[1], list) else []
            for metric_row in metric_list:
                if not metric_row or len(metric_row) < 4:
                    continue
                metric_name = str(metric_row[0]).lower()
                if "net profit" in metric_name or "profit" in metric_name:
                    five_qtrs = metric_row[3] if len(metric_row) > 3 else []
                    if isinstance(five_qtrs, list) and len(five_qtrs) >= 2:
                        acceleration = _linear_slope([_safe_float(v) for v in five_qtrs])
                    break
            if acceleration is not None:
                break

    # Write macro_asset_prices rows
    macro_rows = []
    if breadth_pct is not None:
        macro_rows.append(("EARNINGS_BREADTH",       TODAY, breadth_pct))
    if np_yoy is not None:
        macro_rows.append(("MARKET_NP_GROWTH_YOY",   TODAY, np_yoy))
    if rev_yoy is not None:
        macro_rows.append(("MARKET_REV_GROWTH_YOY",  TODAY, rev_yoy))
    if acceleration is not None:
        macro_rows.append(("EARNINGS_ACCELERATION",  TODAY, acceleration))

    if macro_rows:
        cur = con.cursor()
        cur.executemany("""
            INSERT INTO macro_asset_prices (symbol, date, close)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close
        """, macro_rows)
        con.commit()

    print(
        f"[EarningsFetcher] Dashboard: "
        f"Breadth={breadth_pct * 100:.1f}% " if breadth_pct else "[EarningsFetcher] Dashboard: Breadth=N/A ",
        end="",
    )
    print(
        f"NP YoY=+{np_yoy:.1f}%" if np_yoy else "NP YoY=N/A",
        f", Rev YoY=+{rev_yoy:.1f}%" if rev_yoy else "",
    )


# ── API 6: Actual vs Estimate — beat/miss label + % vs consensus ─────────────────

def fetch_actual_estimate_beats(con, max_pages: int = 25) -> None:
    """
    Paginates actual-estimate across three types for maximum stock coverage:
      type=all (25p, ~521 stocks), type=con (24p, ~466), type=std (23p, ~483)
    Union gives ~650+ unique stocks vs 521 from type=all alone.

    Preference: consolidated > standalone > all (when same scId appears in multiple types).

    Writes:
      eps_beat_last_q  — 1=Beats, 0=Meets, -1=Missed Expectations
      mc_eps_vs_cons   — % vs analyst consensus (positive=beat, negative=miss)
    """
    cur = con.cursor()
    cur.execute("SELECT mcsymbol, symbol FROM nse_stocks WHERE mcsymbol IS NOT NULL AND mcsymbol != ''")
    scid_map = {row[0]: row[1] for row in cur.fetchall()}

    # symbol → (beat_label, beat_pct, type_priority)
    # type_priority: con=3 > std=2 > all=1 (prefer consolidated)
    rows_by_symbol: dict = {}

    TYPES = [
        ("all", max_pages,   1),
        ("con", max_pages,   3),
        ("std", max_pages-2, 2),  # user noted std goes to page 23
    ]

    for type_code, pages, priority in TYPES:
        for page in range(1, pages + 1):
            url = (
                f"https://api.moneycontrol.com/mcapi/v1/earnings/actual-estimate"
                f"?page={page}&sortBy=all&search=&indexId=N&sector=&type={type_code}"
            )
            data = _get(url)
            if not data:
                break
            items = data.get("list") or []
            if not items:
                break

            for item in items:
                if len(item) < 9:
                    continue
                sc_id        = str(item[0]).strip()
                expectations = str(item[7]).strip()
                beat_pct     = _safe_float(item[8])

                symbol = scid_map.get(sc_id)
                if not symbol:
                    continue

                label = (
                    1 if "Beats" in expectations
                    else -1 if "Missed" in expectations
                    else 0
                )
                existing = rows_by_symbol.get(symbol)
                if existing is None or priority > existing[2]:
                    rows_by_symbol[symbol] = (label, beat_pct, priority)

            time.sleep(RATE_LIMIT_SEC)

    if not rows_by_symbol:
        print("[EarningsFetcher] actual-estimate: no matched symbols")
        return

    # Stamp most-recent ts row per symbol (strip priority from tuple)
    if use_postgres():
        cur.execute("""
            UPDATE technical_signals ts
            SET eps_beat_last_q = v.beat_label,
                mc_eps_vs_cons  = v.beat_pct
            FROM (VALUES {}) AS v(symbol, beat_label, beat_pct)
            WHERE ts.symbol = v.symbol
              AND ts.date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = ts.symbol)
        """.format(
            ", ".join(
                f"('{sym}', {lbl}, {pct if pct is not None else 'NULL'})"
                for sym, (lbl, pct, _) in rows_by_symbol.items()
            )
        ))
    else:
        for sym, (lbl, pct, _) in rows_by_symbol.items():
            cur.execute(
                "UPDATE technical_signals SET eps_beat_last_q = ?, mc_eps_vs_cons = ? "
                "WHERE symbol = ? AND date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = ?)",
                (lbl, pct, sym, sym),
            )
    con.commit()

    beats  = sum(1 for lbl, _, _ in rows_by_symbol.values() if lbl == 1)
    misses = sum(1 for lbl, _, _ in rows_by_symbol.values() if lbl == -1)
    meets  = sum(1 for lbl, _, _ in rows_by_symbol.values() if lbl == 0)
    print(
        f"[EarningsFetcher] actual-estimate: {len(rows_by_symbol)} stocks stamped "
        f"(Beats={beats}, Meets={meets}, Missed={misses})"
    )


# ── Utilities ────────────────────────────────────────────────────────────────────

def _safe_float(val) -> float | None:
    """Coerce a value to float, returning None on failure."""
    if val is None:
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _parse_dmy_short(date_str: str | None) -> str | None:
    """Parse "04/05/26" (DD/MM/YY) → "2026-05-04". Returns None if unparseable."""
    if not date_str:
        return None
    try:
        d = datetime.strptime(date_str.strip(), "%d/%m/%y")
        return d.date().isoformat()
    except ValueError:
        return None


def _linear_slope(values: list) -> float | None:
    """Compute the linear least-squares slope of a numeric series (proxy for acceleration)."""
    vals = [v for v in values if v is not None]
    n = len(vals)
    if n < 2:
        return None
    x_mean = (n - 1) / 2.0
    y_mean = sum(vals) / n
    numerator   = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(vals))
    denominator = sum((i - x_mean) ** 2 for i in range(n))
    if denominator == 0:
        return None
    return numerator / denominator


# ── Main ─────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="MC Earnings Fetcher — daily ML feature pipeline")
    parser.add_argument("--skip-rapid", action="store_true",
                        help="Skip the 10 rapid results calls (faster daily run)")
    parser.add_argument("--skip-beats", action="store_true",
                        help="Skip actual-estimate beat/miss fetch (25 pages)")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    print("[EarningsFetcher] Fetching upcoming results (next 14 days)...")
    fetch_earnings_dates(con)

    if not args.skip_rapid:
        print("[EarningsFetcher] Fetching rapid results categories (all 10 type×subtype)...")
        fetch_rapid_results(con)
    else:
        print("[EarningsFetcher] Skipping rapid results (--skip-rapid)")

    print("[EarningsFetcher] Fetching price shockers...")
    fetch_price_shockers(con)

    print("[EarningsFetcher] Fetching sector earnings quality...")
    fetch_sector_performers(con)

    print("[EarningsFetcher] Fetching market dashboard + earnings trajectory...")
    fetch_market_dashboard(con)

    if not args.skip_beats:
        print("[EarningsFetcher] Fetching actual-estimate beat/miss (25 pages)...")
        fetch_actual_estimate_beats(con)
    else:
        print("[EarningsFetcher] Skipping actual-estimate beats (--skip-beats)")

    con.close()


if __name__ == "__main__":
    main()
