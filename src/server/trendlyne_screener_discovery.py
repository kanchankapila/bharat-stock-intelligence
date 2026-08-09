#!/usr/bin/env python3
"""
Trendlyne Screener Discovery
=============================
Fetches every known Kayal screener PK from the all-in-one-screener-data-get API,
captures screener name, description, URL, category, sentiment, and the list of
stocks. Stores everything in trendlyne_screeners + trendlyne_screener_stocks and
syncs metadata to screener_master / screener_catalog.

Also discovers NEW screener PKs by:
  1. Scanning the 1053 known PKs (from explore_mc_tl.py)
  2. Extracting any screener PK references found inside API responses (relatedScreeners)
  3. Probing numeric ranges near known PKs to find gaps

Run:
  python trendlyne_screener_discovery.py            # sync known PKs
  python trendlyne_screener_discovery.py --full     # sync + probe for new PKs
  python trendlyne_screener_discovery.py --pk 12345 # fetch a single PK
"""

import re
import sys
import time
import json
import datetime
import argparse
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

from db_compat import connect, try_advisory_lock, release_advisory_lock

RATE_LIMIT_SEC = 0.4
BATCH_SIZE = 15
BATCH_GAP_SEC = 0.5

KAYAL_URL = (
    "https://kayal.trendlyne.com/broker-webview/kayal/"
    "all-in-one-screener-data-get/"
    "?perPageCount=10000&pageNumber=0&screenpk={pk}&groupType=all&groupName="
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://kayal.trendlyne.com/",
}

RATE_LIMIT_SEC = 0.4

# All known Kayal screener PKs (from explore_mc_tl.py KAYAL_SCREENER_PKS)
KNOWN_PKS = [
    15, 16, 23, 24, 26, 27, 28, 29, 30, 31, 41, 138,
    226, 292, 293, 423, 478, 717, 764, 1511, 1648, 1729, 2651, 3051,
    3056, 3057, 3059, 4805, 4807, 4897, 5388, 5389, 5393, 5394, 5779, 5884,
    5885, 5886, 5887, 5888, 5889, 5890, 5891, 5892, 5893, 5894, 5895, 5896,
    5897, 5898, 5899, 5900, 5901, 5902, 5903, 5904, 5905, 5906, 6157, 6159,
    6160, 6211, 6562, 7154, 7205, 7557, 7589, 7830, 7942, 8008, 8036, 8181,
    8182, 8185, 8256, 9193, 9287, 9335, 9362, 9516, 9544, 9588, 9589, 9818,
    9819, 9821, 9823, 9824, 9826, 9831, 9832, 9834, 9835, 9836, 9837, 9838,
    9840, 9843, 9844, 9895, 9896, 10029, 10118, 10159, 10407, 10554, 10663, 10699,
    10955, 11122, 11321, 11385, 11500, 11502, 11559, 11793, 11814, 11866, 12094, 12405,
    13086, 13213, 14535, 14567, 14752, 14807, 15045, 15075, 15316, 15318, 15320, 15451,
    15543, 15628, 15697, 16995, 16996, 17038, 17131, 17183, 17233, 17343, 17344, 18121,
    18566, 18597, 18792, 18916, 19746, 19814, 20014, 20078, 21557, 22709, 22717, 22719,
    23511, 24573, 24575, 24645, 24700, 24702, 24713, 24714, 24715, 24716, 24717, 24728,
    24729, 24730, 24731, 24732, 24733, 24747, 24842, 24866, 24867, 24870, 24871, 24872,
    24876, 25125, 25348, 25797, 25818, 25865, 25866, 25994, 26001, 26901, 31264, 31717,
    32034, 32574, 35316, 35319, 35321, 35325, 35326, 35336, 35337, 35338, 35341, 35343,
    36275, 36288, 36308, 36373, 36375, 36376, 36377, 36378, 36381, 36384, 37335, 42221,
    45882, 45884, 46425, 47927, 48091, 66655, 79690, 79703, 79704, 79706, 79707, 79708,
    79709, 79710, 79711, 79712, 79713, 79715, 79716, 79717, 79718, 79722, 79723, 79724,
    79728, 79729, 79737, 79738, 79739, 79790, 79791, 79792, 79793, 79794, 79795, 79796,
    79797, 79799, 79800, 79801, 79802, 79803, 79806, 79808, 79810, 79811, 82466, 82476,
    82485, 82540, 82553, 82566, 82567, 82568, 82586, 83413, 83414, 83417, 83418, 83419,
    92294, 93730, 95025, 123150, 126619, 150420, 153269, 154274, 174452, 178571, 178572, 178573,
    178574, 178588, 178590, 179144, 179158, 179161, 180912, 182100, 184105, 186840, 190803, 198018,
    205167, 207497, 208109, 208613, 208614, 208618, 208619, 208625, 208626, 208631, 208805, 208995,
    211854, 218262, 218265, 218266, 218470, 218473, 218476, 218479, 218481, 218482, 218484, 218488,
    218489, 218492, 218498, 218510, 218511, 218513, 218517, 218535, 219052, 222859, 222861, 222864,
    222865, 222869, 222870, 222872, 222874, 222875, 222876, 222877, 222879, 224581, 224584, 224587,
    224590, 224601, 224612, 224614, 224616, 224617, 224618, 224628, 224632, 224634, 224641, 224849,
    224851, 224853, 224854, 224855, 224856, 224858, 224859, 224864, 224865, 224866, 224869, 224870,
    224872, 224874, 224875, 225381, 225408, 225489, 225491, 225493, 225496, 225498, 225500, 225502,
    225503, 225507, 225509, 225515, 225517, 225520, 225522, 225524, 225526, 225538, 225540, 225558,
    225569, 230994, 231024, 231110, 231302, 231325, 231955, 231960, 231999, 252158, 252169, 252170,
    252747, 252748, 252749, 252750, 252751, 252766, 252940, 252942, 252969, 252997, 253024, 253025,
    253026, 253053, 253069, 253264, 253267, 253269, 253272, 253296, 253307, 253311, 253313, 253337,
    253350, 253352, 253354, 258174, 258175, 258176, 258180, 258192, 258198, 258205, 258206, 258543,
    258545, 258663, 258822, 258902, 258930, 258944, 260219, 260220, 260221, 260235, 260275, 260300,
    260320, 260322, 260325, 260327, 260364, 260380, 260381, 260382, 260383, 260397, 260401, 260430,
    260452, 260460, 270925, 280337, 286949, 287918, 314003, 314009, 314011, 314012, 314013, 314016,
    314019, 314020, 314026, 314038, 314039, 314040, 314043, 314046, 314050, 314051, 314052, 314053,
    314054, 314055, 330675, 334854, 353470, 358883, 358885, 358886, 358887, 358888, 358889, 358890,
    358891, 358892, 358894, 358896, 358898, 358900, 358901, 358902, 358903, 358904, 358905, 359200,
    359212, 359213, 359214, 359216, 359217, 359218, 371821, 371829, 371831, 371832, 371835, 371842,
    372090, 372098, 372099, 372101, 372130, 372137, 372170, 372171, 372172, 372174, 372175, 385658,
    385659, 385663, 385668, 385670, 385673, 385676, 385690, 387668, 399172, 399177, 399179, 422006,
    422013, 422014, 422015, 422017, 422030, 422031, 422033, 434325, 442237, 442244, 463821, 470223,
    470230, 471978, 472327, 472333, 472341, 472344, 479184, 481430, 481431, 481432, 481434, 481435,
    481436, 482894, 482895, 482896, 482898, 482899, 482900, 482901, 482902, 482903, 482904, 482905,
    482906, 482908, 482909, 482910, 482911, 482912, 482913, 482914, 482916, 482917, 482918, 482919,
    482920, 482921, 482922, 482923, 482924, 494715, 494718, 494720, 494721, 494740, 494747, 494748,
]

# ── Classification helpers (mirrors trendlyneScreener.ts logic) ───────────────

def _classify_screener(name: str, description: str = "") -> dict:
    t = (name + " " + (description or "")).lower()

    # Sentiment
    compound_bear = bool(re.search(
        r"momentum.trap|value.trap|wealth.destroy|low.dvm|dvm.low|red.flag|caution", t
    ))
    if compound_bear or any(w in t for w in [
        "bearish", "sell", "breakdown", "falling", "death cross",
        "underperform", "declining", "downtrend", "overbought", "avoid"
    ]):
        sentiment = "bearish"
    elif any(w in t for w in [
        "bullish", "buy", "breakout", "rising", "golden cross",
        "outperform", "gaining", "uptrend", "accumulate", "strong"
    ]):
        sentiment = "bullish"
    else:
        sentiment = "neutral"

    # Category
    if any(w in t for w in ["intraday", "15min", "30min", "5min", "btst", "stbt", "day trade"]):
        category = "intraday"
    elif re.search(r"\b\d+[\s-]min\b", t):
        category = "intraday"
    elif any(w in t for w in ["delivery", "delivery%", "delivery volume"]):
        category = "delivery"
    elif any(w in t for w in ["pe ratio", "price to book", "valuation", "p/e", "pb ratio", "dvm", "fair value"]):
        category = "valuation"
    elif any(w in t for w in ["eps", "revenue", "profit", "earnings", "quarterly", "annual", "roe", "roce", "debt"]):
        category = "fundamental"
    else:
        category = "technical"

    # Timeframe
    timeframe = "intraday" if category == "intraday" else "positional"

    return {"sentiment": sentiment, "category": category, "timeframe": timeframe}


# ── Schema ────────────────────────────────────────────────────────────────────

def ensure_schema(con):
    # Add url column to trendlyne_screeners if missing
    for stmt in [
        "ALTER TABLE trendlyne_screeners ADD COLUMN IF NOT EXISTS screener_url TEXT",
        "ALTER TABLE trendlyne_screeners ADD COLUMN IF NOT EXISTS query_text TEXT",
        "ALTER TABLE trendlyne_screeners ADD COLUMN IF NOT EXISTS stock_count INTEGER",
        "ALTER TABLE trendlyne_screeners ADD COLUMN IF NOT EXISTS source_tags TEXT",
    ]:
        try:
            con.execute(stmt)
            con.commit()
        except Exception:
            con.rollback()

    # screener_catalog: add signal_keywords column
    for stmt in [
        "ALTER TABLE screener_catalog ADD COLUMN IF NOT EXISTS signal_keywords TEXT",
        "ALTER TABLE screener_catalog ADD COLUMN IF NOT EXISTS screener_url TEXT",
    ]:
        try:
            con.execute(stmt)
            con.commit()
        except Exception:
            con.rollback()


# ── API fetch ─────────────────────────────────────────────────────────────────

def fetch_screener(pk: int, timeout: int = 15) -> dict | None:
    """Fetch one Kayal screener PK. Returns parsed JSON or None."""
    url = KAYAL_URL.format(pk=pk)
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        if r.status_code != 200:
            return None
        data = r.json()
        if data.get("head", {}).get("status") != "0":
            return None
        return data
    except Exception:
        return None


def extract_screener_info(pk: int, data: dict) -> dict | None:
    """
    Parse the Kayal API response for a screener PK.
    Returns a dict with all the metadata or None if invalid.

    Response shape:
      data.body.screenObj.title       -- screener name
      data.body.screenObj.description -- screener description
      data.body.screenObj.query       -- filter logic text
      data.body.tableData             -- list of stock rows (each row = array of values)
      data.body.tableHeaders          -- column definitions [{ "field": "...", "header": "..." }]
      data.body.relatedScreeners      -- [{ "pk": N, "title": "...", "url": "..." }, ...]
    """
    body = data.get("body", {})
    screen_obj = body.get("screenObj", {})

    name = screen_obj.get("title", "").strip()
    if not name:
        return None

    description = screen_obj.get("description", "") or ""
    query_text  = screen_obj.get("query", "") or ""
    table_data  = body.get("tableData", []) or []
    headers     = body.get("tableHeaders", []) or []
    related     = body.get("relatedScreeners", []) or []

    # Extract stock symbols from tableData
    # Find the column index for "nsecode" / "symbol" in headers. The live Kayal API's real
    # header shape uses `unique_name` (e.g. {"unique_name": "NSEcode", "name": "NSE Symbol",
    # "type": "string"}) — NOT `field`/`key`, which this code checked for years without ever
    # matching (verified live, 2026-07-23: every header on a real screener has field=None,
    # key=None). That's the actual root cause of the blind "column 0" fallback always firing
    # — checking `field`/`key` as a defensive fallback below in case the API shape ever adds
    # those, but `unique_name` is the one that actually works today.
    symbol_col = None
    for i, h in enumerate(headers):
        field = (h.get("unique_name") or h.get("field") or h.get("key") or "").lower()
        if field in ("nsecode", "symbol", "nse_code", "nse"):
            symbol_col = i
            break
    # No blind "column 0" fallback: for screeners whose headers don't label a
    # symbol/nsecode column, column 0 is often the stock-name/profile-link column
    # instead (observed root cause of ~2M rows with a Trendlyne URL stored as
    # `symbol` in trendlyne_screener_stocks/confluence_signals). Skip this
    # screener's stocks rather than guess — no rows is safer than wrong rows.
    if symbol_col is None:
        if headers:
            print(f"[TL_DISCOVERY] pk={pk}: no symbol/nsecode column found in headers "
                  f"({[h.get('unique_name') or h.get('field') or h.get('key') for h in headers]}) — skipping stock extraction")
        stocks = []
    else:
        stocks = []
        skipped = 0
        for row in table_data:
            if isinstance(row, (list, tuple)) and len(row) > symbol_col:
                sym = str(row[symbol_col]).strip().upper()
                if not sym or sym in ("", "SYMBOL", "NSE CODE"):
                    continue
                # A real NSE ticker is short, uppercase alnum (plus &/-), never a URL.
                if len(sym) > 20 or "://" in sym or " " in sym or not re.match(r'^[A-Z0-9&\-]+$', sym):
                    skipped += 1
                    continue
                stocks.append(sym)
        if skipped:
            print(f"[TL_DISCOVERY] pk={pk}: skipped {skipped} non-ticker-looking value(s) in symbol column")

    # Related screeners — record their PKs and URLs for later discovery
    related_pks = []
    for rel in related:
        rel_pk = rel.get("pk") or rel.get("screenpk")
        if rel_pk:
            related_pks.append(int(rel_pk))

    screener_url = (
        f"https://trendlyne.com/equity/screeners/{pk}/view/"
    )

    cls = _classify_screener(name, description)
    screener_id = name.lower().replace(" ", "-").replace("/", "-")

    return {
        "pk":           pk,
        "screener_id":  screener_id,
        "name":         name,
        "description":  description,
        "query_text":   query_text,
        "screener_url": screener_url,
        "stocks":       stocks,
        "related_pks":  related_pks,
        "sentiment":    cls["sentiment"],
        "category":     cls["category"],
        "timeframe":    cls["timeframe"],
    }


# ── NLP: extract signal keywords from screener name ──────────────────────────

SIGNAL_KEYWORD_PATTERNS = [
    (r"52.week.high|all.time.high",             "ath_proximity"),
    (r"breakout",                                "breakout"),
    (r"breakdown",                               "breakdown"),
    (r"golden.cross|death.cross",               "ma_crossover"),
    (r"rsi.bullish|rsi.bearish|rsi.overbought|rsi.oversold", "rsi_signal"),
    (r"macd",                                    "macd_signal"),
    (r"bollinger",                               "bollinger_signal"),
    (r"volume.surge|high.volume",               "volume_spike"),
    (r"delivery",                                "delivery_signal"),
    (r"institutional|fii|dii|mf.buy|mf.sell",  "institutional_flow"),
    (r"insider",                                 "insider_activity"),
    (r"earnings|eps|results|quarterly",         "earnings_event"),
    (r"dividend|ex.div",                        "dividend_event"),
    (r"sector.rotation|sector.leader",          "sector_rotation"),
    (r"momentum",                                "momentum"),
    (r"reversal",                                "reversal"),
    (r"support|resistance",                      "sr_level"),
    (r"dvm",                                     "dvm_score"),
    (r"valuation|pe.ratio|p/e|price.book",      "valuation_signal"),
    (r"debt.free|low.debt|zero.debt",           "debt_quality"),
    (r"high.roe|high.roce|roe",                 "return_quality"),
    (r"promoter",                                "promoter_activity"),
    (r"buyback|bonus|split",                    "corporate_action"),
    (r"intraday|btst|stbt",                      "intraday_signal"),
    (r"relative.strength|rs.rank",              "rs_signal"),
]

def extract_signal_keywords(name: str, description: str = "") -> str:
    """Returns comma-separated signal keyword tags extracted from screener name/description."""
    t = (name + " " + (description or "")).lower()
    found = []
    for pat, tag in SIGNAL_KEYWORD_PATTERNS:
        if re.search(pat.replace(".", r"[\s\-_/]?"), t) and tag not in found:
            found.append(tag)
    return ",".join(found)


# ── DB write ──────────────────────────────────────────────────────────────────

def upsert_screener(con, info: dict):
    """Upsert into trendlyne_screeners + screener_master + screener_catalog."""
    keywords = extract_signal_keywords(info["name"], info["description"])
    today = datetime.date.today().isoformat()

    # trendlyne_screeners
    con.execute("""
        INSERT INTO trendlyne_screeners
            (screener_id, screener_name, screenpk, description,
             sentiment, category, timeframe, last_updated,
             screener_url, query_text, stock_count)
        VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?,?)
        ON CONFLICT(screener_id) DO UPDATE SET
            screener_name = excluded.screener_name,
            screenpk      = excluded.screenpk,
            description   = excluded.description,
            sentiment     = excluded.sentiment,
            category      = excluded.category,
            timeframe     = excluded.timeframe,
            last_updated  = CURRENT_TIMESTAMP,
            screener_url  = excluded.screener_url,
            query_text    = excluded.query_text,
            stock_count   = excluded.stock_count
    """, (
        info["screener_id"], info["name"], info["pk"],
        info["description"], info["sentiment"], info["category"],
        info["timeframe"], info["screener_url"], info["query_text"],
        len(info["stocks"]),
    ))

    # screener_master (sync). ON CONFLICT target is (source, scan_id) -- screener_master's real
    # PK, not scan_id alone; scan_id collides across providers (2026-08-04 memory) and, after
    # that PK migration, ON CONFLICT(scan_id) no longer matches any unique constraint.
    con.execute("""
        INSERT INTO screener_master
            (scan_id, name, source, inferred_sentiment, inferred_category,
             inferred_timeframe, confidence)
        VALUES (?,?,'Trendlyne',?,?,?,0.75)
        ON CONFLICT(source, scan_id) DO UPDATE SET
            name               = excluded.name,
            inferred_sentiment = excluded.inferred_sentiment,
            inferred_category  = excluded.inferred_category,
            inferred_timeframe = excluded.inferred_timeframe
    """, (
        info["screener_id"], info["name"],
        info["sentiment"], info["category"], info["timeframe"],
    ))

    # screener_catalog (rich enrichment) — UPDATE first, INSERT if missing
    horizon = "intraday" if info["timeframe"] == "intraday" else "swing"
    updated = con.execute("""
        UPDATE screener_catalog
        SET screener_name=?, category=?, subcategory=?, signal_bias=?,
            investment_horizon=?, signal_keywords=?, screener_url=?
        WHERE screener_id=?
    """, (info["name"], info["category"], info["category"], info["sentiment"],
          horizon, keywords, info["screener_url"], info["screener_id"])).rowcount
    if not updated:
        con.execute("""
            INSERT INTO screener_catalog
                (screener_id, source, screener_name, category, subcategory,
                 signal_bias, investment_horizon, confidence, signal_keywords, screener_url)
            VALUES (?,?,?,?,?,?,?,0.75,?,?)
        """, (info["screener_id"], "Trendlyne", info["name"], info["category"],
              info["category"], info["sentiment"], horizon, keywords, info["screener_url"]))

    # trendlyne_screener_stocks
    if info["stocks"]:
        for sym in info["stocks"]:
            con.execute("""
                INSERT INTO trendlyne_screener_stocks
                    (screener_id, stock_id, symbol, first_seen, last_seen)
                VALUES (?,?,?,?,?)
                ON CONFLICT(screener_id, stock_id) DO UPDATE SET
                    symbol   = excluded.symbol,
                    last_seen = excluded.last_seen
            """, (info["screener_id"], sym, sym, today, today))


# ── Main sync loop ────────────────────────────────────────────────────────────

def sync_pks(pks: list[int], con, label: str = "known") -> set[int]:
    """
    Fetch all PKs, upsert, and return set of any newly discovered related PKs.
    """
    discovered = set()
    ok = 0
    skip = 0
    done = 0

    def _fetch_one(pk):
        return pk, fetch_screener(pk)

    for batch_start in range(0, len(pks), BATCH_SIZE):
        batch = pks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, pk) for pk in batch]
            for fut in as_completed(futures):
                pk, data = fut.result()
                done += 1
                if data is None:
                    skip += 1
                    continue

                info = extract_screener_info(pk, data)
                if info is None:
                    skip += 1
                    continue

                upsert_screener(con, info)
                ok += 1

                for rel_pk in info["related_pks"]:
                    discovered.add(rel_pk)

        con.commit()
        print(f"  [{label}] {done}/{len(pks)} done ({ok} ok / {skip} skip) | "
              f"{len(discovered)} new PKs discovered")
        time.sleep(BATCH_GAP_SEC)

    con.commit()
    print(f"[Discovery] {label}: {ok} screeners synced, {skip} failed, "
          f"[Discovery] {len(discovered)} related PKs found")
    return discovered


def run(mode: str = "known", single_pk: int | None = None):
    if not try_advisory_lock("trendlyne_screener_discovery"):
        print("[Discovery] Another discovery run is already in progress — skipping.")
        return

    con = connect()
    try:
        ensure_schema(con)

        if single_pk:
            data = fetch_screener(single_pk)
            if not data:
                print(f"[Discovery] PK {single_pk} not found or invalid.")
                return
            info = extract_screener_info(single_pk, data)
            if not info:
                print(f"[Discovery] PK {single_pk} returned no screener data.")
                return
            upsert_screener(con, info)
            con.commit()
            print(f"[Discovery] PK {single_pk}: '{info['name']}' | "
                  f"{len(info['stocks'])} stocks | related={info['related_pks']}")
            return

        # Load already-known PKs from DB to skip re-fetch when not --full
        known_in_db = set(
            row[0] for row in
            con.execute("SELECT screenpk FROM trendlyne_screeners WHERE screenpk IS NOT NULL").fetchall()
        )

        if mode == "known":
            # Only sync PKs not yet in DB (or all if --force)
            pks_to_sync = [pk for pk in KNOWN_PKS if pk not in known_in_db]
            if not pks_to_sync:
                print(f"[Discovery] All {len(KNOWN_PKS)} known PKs already in DB. Nothing to sync.")
                print("  Use --full to re-sync and discover new PKs.")
            else:
                print(f"[Discovery] Syncing {len(pks_to_sync)} new PKs ({len(known_in_db)} already in DB)...")
                discovered = sync_pks(pks_to_sync, con, "known")
                # Fetch newly discovered related PKs
                new_pks = [pk for pk in discovered if pk not in known_in_db and pk not in set(KNOWN_PKS)]
                if new_pks:
                    print(f"[Discovery] Probing {len(new_pks)} newly discovered related PKs...")
                    sync_pks(new_pks, con, "discovered")

        elif mode == "full":
            print(f"[Discovery] Full sync: {len(KNOWN_PKS)} known PKs...")
            discovered = sync_pks(KNOWN_PKS, con, "full")
            all_known = set(KNOWN_PKS) | known_in_db
            new_pks = [pk for pk in discovered if pk not in all_known]
            if new_pks:
                print(f"[Discovery] Probing {len(new_pks)} newly discovered related PKs...")
                more = sync_pks(new_pks, con, "discovered")
                # One more level
                level2 = [pk for pk in more if pk not in all_known and pk not in set(new_pks)]
                if level2:
                    print(f"[Discovery] Probing {len(level2)} level-2 related PKs...")
                    sync_pks(level2, con, "level2")

        # Final stats
        n_total = con.execute("SELECT COUNT(*) FROM trendlyne_screeners").fetchone()[0]
        n_stocks = con.execute("SELECT COUNT(DISTINCT symbol) FROM trendlyne_screener_stocks").fetchone()[0]
        print(f"\n[Discovery] Total: {n_total} screeners, {n_stocks} distinct stocks in DB")

        # Show new screeners by category
        rows = con.execute(
            "SELECT category, COUNT(*) FROM trendlyne_screeners GROUP BY category ORDER BY 2 DESC"
        ).fetchall()
        print("[Discovery] By category:", {r[0]: r[1] for r in rows})

        # Log to screener_runs table. The Postgres schema-of-record (db/schema.postgres.sql)
        # diverged from the SQLite one (db.ts) for this table — PG has source/raw_count,
        # not symbol_count/triggered_by — so this insert always threw UndefinedColumn
        # against live PG and was silently swallowed by the except below.
        try:
            run_id = f"tl_discovery_{datetime.date.today().isoformat()}_{mode}"
            con.execute("""
                INSERT INTO screener_runs
                (run_id, screener_id, run_ts, raw_count, source, status)
                VALUES (?, 'ALL_TRENDLYNE', NOW(), ?, ?, 'COMPLETED')
                ON CONFLICT(run_id) DO UPDATE SET
                    raw_count = excluded.raw_count,
                    run_ts = excluded.run_ts
            """, (run_id, n_stocks, f"discovery_{mode}"))
            con.commit()
            print(f"[Discovery] Logged run to screener_runs: {run_id} ({n_stocks} distinct stocks)")
        except Exception as e2:
            con.rollback()
            print(f"[Discovery] Could not log to screener_runs: {e2}")

    finally:
        con.close()
        release_advisory_lock("trendlyne_screener_discovery")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Trendlyne screener discovery")
    parser.add_argument("--full",  action="store_true", help="Re-sync all known PKs + discover new ones")
    parser.add_argument("--pk",    type=int,            help="Fetch a single screener PK")
    args = parser.parse_args()

    if args.pk:
        run("single", single_pk=args.pk)
    elif args.full:
        run("full")
    else:
        run("known")
