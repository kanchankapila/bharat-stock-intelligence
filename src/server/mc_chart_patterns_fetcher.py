#!/usr/bin/env python3
"""
MoneyControl Chart Patterns Fetcher (Daily)
============================================
Fetches professionally-identified chart patterns per stock from MoneyControl's
technical picks system. Each pattern has an entry price, target, stop-loss,
expected return %, and directional type (buy/sell).

Endpoint:
  https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns
  ?deviceType=W&version=174&start=0&limit=12&pattern_type=all&sc_id={mcsymbol}

Pattern types observed: "Horizontal Channel", "Falling Trendline", "Double Bottom",
  "Ascending Triangle", "Cup and Handle", "Head and Shoulders", etc.

ML features written to technical_signals:
  mc_cp_bull_count      — number of active BUY chart patterns (0–12)
  mc_cp_bear_count      — number of active SELL chart patterns (0–12)
  mc_cp_net_score       — bull_count - bear_count  (-12 to +12)
  mc_cp_avg_target_pct  — avg expected return % for active buy patterns

Run:
  python mc_chart_patterns_fetcher.py             # all stocks with mcsymbol
  python mc_chart_patterns_fetcher.py --symbol BEL
"""

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

from curl_cffi import requests

from db_compat import connect

PATTERNS_URL = (
    "https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns"
    "?deviceType=W&version=174&start=0&limit=10000&pattern_type=all&sc_id={scid}"
)

MC_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}

RATE_LIMIT_SEC = 0.5
BATCH_SIZE     = 15
BATCH_GAP_SEC  = 0.5


# ── Schema ──────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mc_chart_patterns (
            pattern_id     INTEGER NOT NULL,
            symbol         TEXT NOT NULL,
            pattern_name   TEXT,
            direction      TEXT,
            time_frame     TEXT,
            entry_price    REAL,
            target_price   REAL,
            sl_price       REAL,
            target_return_pct REAL,
            sl_pct         REAL,
            comment        TEXT,
            p_status       TEXT,
            end_date       TEXT,
            created_at     TEXT,
            fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (pattern_id)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mccp_sym ON mc_chart_patterns(symbol)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mc_pattern_signals (
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            bull_count      INTEGER DEFAULT 0,
            bear_count      INTEGER DEFAULT 0,
            net_score       INTEGER DEFAULT 0,
            avg_target_pct  REAL,
            fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN mc_cp_bull_count     INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN mc_cp_bear_count     INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN mc_cp_net_score      INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN mc_cp_avg_target_pct REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Fetch ────────────────────────────────────────────────────────────────────────

def _fetch(mcsymbol: str, session) -> list[dict]:
    url = PATTERNS_URL.format(scid=mcsymbol)
    try:
        r = session.get(url, headers=MC_HEADERS, timeout=10, impersonate="chrome110")
        if r.status_code != 200:
            return []
        payload = r.json()
        if payload.get("status") != "success":
            return []
        return payload.get("list", {}).get("data", [])
    except Exception as e:
        print(f"  [{mcsymbol}] chart patterns error: {e}")
        return []


def _sf(v, default=None) -> float | None:
    if v in (None, "", "0"):
        return default
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _parse_pattern(raw: dict) -> dict | None:
    pid = raw.get("pattern_id")
    if not pid:
        return None

    # direction + price targets are inside the JSON-stringified meta_data field
    meta_str = raw.get("meta_data", "")
    direction = None
    entry_price = target_price = sl_price = target_pct = sl_pct = None

    try:
        if meta_str:
            meta = json.loads(meta_str) if isinstance(meta_str, str) else meta_str
            direction     = meta.get("pattern_type", "")   # "buy" or "sell"
            entry_price   = _sf(meta.get("entry_price"))
            target_price  = _sf(meta.get("target_price"))
            sl_price      = _sf(meta.get("stoploss_price"))
            target_pct    = _sf(meta.get("target_return_prcnt"))
            sl_pct        = _sf(meta.get("stoploss_prcnt"))
    except (json.JSONDecodeError, TypeError):
        pass

    return {
        "pattern_id":      int(pid),
        "pattern_name":    raw.get("pattern_name", ""),
        "direction":       direction,
        "time_frame":      raw.get("time_frame", ""),
        "entry_price":     entry_price,
        "target_price":    target_price,
        "sl_price":        sl_price,
        "target_return_pct": target_pct,
        "sl_pct":          sl_pct,
        "comment":         raw.get("comment", ""),
        "p_status":        raw.get("p_status", ""),
        "end_date":        raw.get("end_date"),
        "created_at":      raw.get("created_at"),
    }


def upsert_patterns(symbol: str, mcsymbol: str, patterns: list[dict], con) -> None:
    cur = con.cursor()
    for p in patterns:
        cur.execute("""
            INSERT INTO mc_chart_patterns
                (pattern_id, mcsymbol, symbol, pattern_name, direction, time_frame,
                 entry_price, target_price, stoploss_price, target_return_pct, stoploss_pct,
                 comment, p_status, end_date, created_at)
            VALUES (:pid, :mcsym, :sym, :pname, :dir, :tf,
                    :entry, :target, :sl, :tret, :slpct,
                    :comment, :pstatus, :end_date, :created_at)
            ON CONFLICT(mcsymbol, pattern_id) DO UPDATE SET
                p_status=EXCLUDED.p_status, target_price=EXCLUDED.target_price,
                stoploss_price=EXCLUDED.stoploss_price, target_return_pct=EXCLUDED.target_return_pct,
                end_date=EXCLUDED.end_date, fetched_at=CURRENT_TIMESTAMP
        """, {
            "pid": p["pattern_id"], "mcsym": mcsymbol, "sym": symbol, "pname": p.get("pattern_name"),
            "dir": p.get("direction"), "tf": p.get("time_frame"),
            "entry": p.get("entry_price"), "target": p.get("target_price"),
            "sl": p.get("sl_price"), "tret": p.get("target_return_pct"),
            "slpct": p.get("sl_pct"), "comment": p.get("comment"),
            "pstatus": p.get("p_status"), "end_date": p.get("end_date"),
            "created_at": p.get("created_at"),
        })
    con.commit()


def compute_and_upsert_signals(symbol: str, today: str, patterns: list[dict], con) -> dict:
    active = [p for p in patterns if p.get("p_status") in ("New", "Updated")]

    bull = [p for p in active if str(p.get("direction", "")).lower() == "buy"]
    bear = [p for p in active if str(p.get("direction", "")).lower() in ("sell", "short")]

    bull_count = len(bull)
    bear_count = len(bear)
    net_score  = bull_count - bear_count

    bull_targets = [p.get("target_return_pct") for p in bull if p.get("target_return_pct") is not None]
    avg_target = round(sum(bull_targets) / len(bull_targets), 2) if bull_targets else None

    cur = con.cursor()
    cur.execute("""
        INSERT INTO mc_pattern_signals (symbol, date, bull_count, bear_count, net_score, avg_target_pct)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            bull_count=excluded.bull_count, bear_count=excluded.bear_count,
            net_score=excluded.net_score, avg_target_pct=excluded.avg_target_pct,
            fetched_at=CURRENT_TIMESTAMP
    """, (symbol, today, bull_count, bear_count, net_score, avg_target))
    con.commit()

    return {"bull_count": bull_count, "bear_count": bear_count,
            "net_score": net_score, "avg_target_pct": avg_target}


def backfill_technical_signals(symbol: str, signals: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            mc_cp_bull_count     = COALESCE(?, mc_cp_bull_count),
            mc_cp_bear_count     = COALESCE(?, mc_cp_bear_count),
            mc_cp_net_score      = COALESCE(?, mc_cp_net_score),
            mc_cp_avg_target_pct = COALESCE(?, mc_cp_avg_target_pct)
        WHERE symbol = ?
    """, (
        signals.get("bull_count"), signals.get("bear_count"),
        signals.get("net_score"), signals.get("avg_target_pct"),
        symbol,
    ))
    con.commit()


def _load_stocks(symbol_filter: str | None, con) -> list[tuple[str, str]]:
    cur = con.cursor()
    cur.execute("""
        SELECT symbol, mcsymbol FROM nse_stocks
        WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
        ORDER BY symbol
    """)
    rows = [(r[0], r[1]) for r in cur.fetchall()]
    if symbol_filter:
        rows = [(s, m) for s, m in rows if s.upper() == symbol_filter.upper()]
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[MCPatterns] No stocks with mcsymbol found.")
        return

    print(f"[MCPatterns] Fetching chart patterns for {len(stocks)} stocks in batches of {BATCH_SIZE} ({BATCH_GAP_SEC}s gap)…")
    session = requests.Session()
    today = date.today().isoformat()
    ok = 0
    done = 0

    def _fetch_one(args):
        symbol, mcsymbol = args
        raw_list = _fetch(mcsymbol, session)
        patterns = [p for p in (_parse_pattern(r) for r in raw_list) if p is not None]
        return symbol, mcsymbol, patterns

    for batch_start in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, item) for item in batch]
            for fut in as_completed(futures):
                symbol, mcsymbol, patterns = fut.result()
                done += 1
                upsert_patterns(symbol, mcsymbol, patterns, con)
                sigs = compute_and_upsert_signals(symbol, today, patterns, con)
                backfill_technical_signals(symbol, sigs, con)
                print(f"  [{done}/{len(stocks)}] {symbol}: {len(patterns)} patterns | "
                      f"bull={sigs['bull_count']} bear={sigs['bear_count']} "
                      f"net={sigs['net_score']} tgt={sigs.get('avg_target_pct','?')}%")
                ok += 1
        time.sleep(BATCH_GAP_SEC)

    print(f"[MCPatterns] Done. {ok}/{len(stocks)} stocks processed.")
    con.close()


if __name__ == "__main__":
    main()
