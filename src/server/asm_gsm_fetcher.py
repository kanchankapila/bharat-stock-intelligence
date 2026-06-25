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

ASM_URL = "https://www.nseindia.com/api/asm-securities"
GSM_URL = "https://www.nseindia.com/api/gsm-securities"

ASM_CSV_URL = "https://nsearchives.nseindia.com/content/emerge/ASM_Securities.csv"
GSM_CSV_URL = "https://nsearchives.nseindia.com/content/emerge/GradedSurveillanceMeasure.csv"


def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get("https://www.nseindia.com/", timeout=10)
    return s


def fetch_asm_symbols(sess: requests.Session) -> set[str]:
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
        print(f"[ASM] JSON fetch failed: {e}, trying CSV")
    try:
        df = pd.read_csv(ASM_CSV_URL, engine="python", on_bad_lines="skip")
        for col in df.columns:
            if "symbol" in col.lower():
                return set(df[col].dropna().str.upper().str.strip())
    except Exception as e:
        print(f"[ASM] CSV fetch also failed: {e}")
    return set()


def fetch_gsm_symbols(sess: requests.Session) -> dict[str, int]:
    """Returns {symbol: gsm_stage} where stage 1-6."""
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
        print(f"[GSM] JSON fetch failed: {e}, trying CSV")
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
        print(f"[GSM] CSV fetch also failed: {e}")
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


def main():
    print("[ASM/GSM] Fetching surveillance lists...")
    sess = _nse_session()
    asm = fetch_asm_symbols(sess)
    gsm = fetch_gsm_symbols(sess)
    print(f"[ASM/GSM] Found {len(asm)} ASM stocks, {len(gsm)} GSM stocks")
    updated = upsert_flags(asm, gsm)
    print(f"[ASM/GSM] Updated {updated} stocks in nse_stocks")


if __name__ == "__main__":
    main()
