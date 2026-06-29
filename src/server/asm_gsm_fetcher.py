#!/usr/bin/env python3
"""Fetch NSE ASM / GSM surveillance lists and store flags per symbol.

ASM = Additional Surveillance Measure (T+5 settlement, 100% margin)
GSM = Graded Surveillance Measure (T+5 settlement + higher margins by stage)

Run daily: python asm_gsm_fetcher.py
"""
import sys
from datetime import datetime, date
import requests
import pandas as pd
from db_compat import connect, use_postgres

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/html",
    "Referer": "https://www.nseindia.com/",
}

# NSE moved surveillance endpoints; these paths are dead as of June 2026.
# Primary source: Trendlyne screener IDs for ASM/GSM flags.
# Fallback: NSE equity-master endpoint (no ASM/GSM field, but used for session warm-up).
ASM_URL = "https://www.nseindia.com/api/asm-securities"         # 404 as of June 2026
GSM_URL = "https://www.nseindia.com/api/gsm-securities"         # 404 as of June 2026
ASM_CSV_URL = "https://nsearchives.nseindia.com/content/emerge/ASM_Securities.csv"   # 404
GSM_CSV_URL = "https://nsearchives.nseindia.com/content/emerge/GradedSurveillanceMeasure.csv"  # 404

# Trendlyne screener IDs for ASM and GSM stocks
TL_ASM_SCREENER_URL = "https://trendlyne.com/fundamentals/all-in-one-screener-data-get/?screenerid=26&format=json"
TL_GSM_SCREENER_URL = "https://trendlyne.com/fundamentals/all-in-one-screener-data-get/?screenerid=27&format=json"
TL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/javascript, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://trendlyne.com/",
}


def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get("https://www.nseindia.com/", timeout=10)
    return s


def _tl_fetch_symbols(url: str, label: str) -> list[str]:
    """Fetch symbol list from a Trendlyne screener URL."""
    try:
        r = requests.get(url, headers=TL_HEADERS, timeout=15)
        if r.status_code != 200:
            print(f"[{label}] TL screener HTTP {r.status_code}")
            return []
        data = r.json()
        if data.get("head", {}).get("status") != "0":
            print(f"[{label}] TL screener API error: {data.get('head')}")
            return []
        body = data.get("body") or {}
        rows = body.get("tableData") or []
        # tableData is list of lists; symbol is typically first column
        symbols = []
        for row in rows:
            if isinstance(row, list) and row:
                sym = str(row[0]).upper().strip()
            elif isinstance(row, dict):
                sym = (row.get("symbol") or row.get("Symbol") or "").upper().strip()
            else:
                continue
            if sym:
                symbols.append(sym)
        return symbols
    except Exception as e:
        print(f"[{label}] TL fetch error: {e}")
        return []


def fetch_asm_symbols(sess: requests.Session) -> set[str]:
    # Try Trendlyne screener first (NSE ASM API is dead as of June 2026)
    syms = _tl_fetch_symbols(TL_ASM_SCREENER_URL, "ASM")
    if syms:
        return set(syms)
    # Legacy NSE JSON (may come back)
    try:
        r = sess.get(ASM_URL, timeout=10)
        if r.status_code == 200:
            data = r.json()
            symbols = set()
            for item in (data.get("data") or data if isinstance(data, list) else []):
                sym = item.get("symbol") or item.get("Symbol") or item.get("SYMBOL") or ""
                if sym:
                    symbols.add(sym.upper().strip())
            return symbols
    except Exception as e:
        print(f"[ASM] NSE JSON fetch failed: {e}")
    # Legacy CSV (may come back)
    try:
        df = pd.read_csv(ASM_CSV_URL, engine="python", on_bad_lines="skip")
        for col in df.columns:
            if "symbol" in col.lower():
                return set(df[col].dropna().str.upper().str.strip())
    except Exception as e:
        print(f"[ASM] NSE CSV fetch failed: {e}")
    print("[ASM] All sources failed — returning empty set")
    return set()


def fetch_gsm_symbols(sess: requests.Session) -> dict[str, int]:
    """Returns {symbol: gsm_stage} where stage 1-6."""
    # Try Trendlyne screener first (NSE GSM API is dead as of June 2026)
    syms = _tl_fetch_symbols(TL_GSM_SCREENER_URL, "GSM")
    if syms:
        # Trendlyne screener does not return stage; default stage 1
        return {s: 1 for s in syms}
    # Legacy NSE JSON
    try:
        r = sess.get(GSM_URL, timeout=10)
        if r.status_code == 200:
            data = r.json()
            result = {}
            for item in (data.get("data") or data if isinstance(data, list) else []):
                sym = (item.get("symbol") or item.get("Symbol") or item.get("SYMBOL") or "").upper().strip()
                stage = int(item.get("stage") or item.get("Stage") or 1)
                if sym:
                    result[sym] = stage
            return result
    except Exception as e:
        print(f"[GSM] NSE JSON fetch failed: {e}")
    # Legacy CSV
    try:
        df = pd.read_csv(GSM_CSV_URL, engine="python", on_bad_lines="skip")
        result = {}
        sym_col = next((c for c in df.columns if "symbol" in c.lower()), None)
        stage_col = next((c for c in df.columns if "stage" in c.lower()), None)
        if sym_col:
            for _, row in df.iterrows():
                sym = str(row[sym_col]).upper().strip()
                stage = int(row[stage_col]) if stage_col and pd.notna(row.get(stage_col)) else 1
                if sym and sym != "NAN":
                    result[sym] = stage
        return result
    except Exception as e:
        print(f"[GSM] NSE CSV fetch failed: {e}")
    print("[GSM] All sources failed — returning empty dict")
    return {}


def upsert_flags(asm_symbols: set[str], gsm_map: dict[str, int]) -> int:
    """Write is_asm / gsm_stage to nse_stocks. Returns count updated."""
    con = connect()
    cur = con.cursor()
    today = date.today().isoformat()

    for ddl in [
        "ALTER TABLE nse_stocks ADD COLUMN is_asm INTEGER DEFAULT 0",
        "ALTER TABLE nse_stocks ADD COLUMN gsm_stage INTEGER DEFAULT 0",
        "ALTER TABLE nse_stocks ADD COLUMN surveillance_updated_at TEXT",
    ]:
        try:
            cur.execute(ddl)
        except Exception:
            pass

    if use_postgres():
        cur.execute("UPDATE nse_stocks SET is_asm = 0, gsm_stage = 0")
    else:
        cur.execute("UPDATE nse_stocks SET is_asm = 0, gsm_stage = 0")

    updated = 0
    all_flagged = {s: (1, 0) for s in asm_symbols}
    for sym, stage in gsm_map.items():
        is_asm = all_flagged.get(sym, (0, 0))[0]
        all_flagged[sym] = (is_asm, stage)

    for sym, (is_asm, gsm_stage) in all_flagged.items():
        if use_postgres():
            cur.execute(
                "UPDATE nse_stocks SET is_asm = %s, gsm_stage = %s, surveillance_updated_at = %s WHERE symbol = %s",
                (is_asm, gsm_stage, today, sym)
            )
        else:
            cur.execute(
                "UPDATE nse_stocks SET is_asm = ?, gsm_stage = ?, surveillance_updated_at = ? WHERE symbol = ?",
                (is_asm, gsm_stage, today, sym)
            )
        updated += cur.rowcount

    con.commit()
    con.close()
    return updated


def backfill_technical_signals(con) -> int:
    """Copy asm_flag / gsm_stage from nse_stocks into technical_signals.

    Signal interpretation:
    - asm_flag = 1: Stock on Additional Surveillance Measure — 100% margin,
      T+5 settlement. Institutions cannot hold easily → selling pressure.
    - gsm_stage = 1..6: Graded severity. Stage 5-6 = near-untradeable for
      institutional players.

    Returns count of technical_signals rows updated.
    """
    cur = con.cursor()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN asm_flag INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN gsm_stage INTEGER DEFAULT 0",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()

    if use_postgres():
        cur.execute(
            """
            UPDATE technical_signals
            SET asm_flag = ns.is_asm, gsm_stage = ns.gsm_stage
            FROM nse_stocks ns
            WHERE technical_signals.symbol = ns.symbol
            """
        )
    else:
        cur.execute(
            """
            UPDATE technical_signals
            SET asm_flag = (SELECT is_asm FROM nse_stocks WHERE symbol = technical_signals.symbol),
                gsm_stage = (SELECT gsm_stage FROM nse_stocks WHERE symbol = technical_signals.symbol)
            """
        )

    updated = cur.rowcount
    con.commit()
    return updated


def main():
    print("[ASM/GSM] Fetching surveillance lists...")
    sess = _nse_session()
    asm = fetch_asm_symbols(sess)
    gsm = fetch_gsm_symbols(sess)
    print(f"[ASM/GSM] Found {len(asm)} ASM stocks, {len(gsm)} GSM stocks")
    updated = upsert_flags(asm, gsm)
    print(f"[ASM/GSM] Updated {updated} stocks in nse_stocks")

    con = connect()
    ts_updated = backfill_technical_signals(con)
    con.close()
    print(f"[ASM/GSM] Backfilled {ts_updated} rows in technical_signals")


if __name__ == "__main__":
    main()
