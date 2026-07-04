#!/usr/bin/env python3
"""Fetch NSE ASM / GSM surveillance lists and store flags per symbol.

ASM = Additional Surveillance Measure (T+5 settlement, 100% margin)
GSM = Graded Surveillance Measure (T+5 settlement + higher margins by stage)

Run daily: python asm_gsm_fetcher.py
"""
import re
import sys
from datetime import datetime, date
import requests
from db_compat import connect, use_postgres

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/html",
    "Referer": "https://www.nseindia.com/",
}

# NSE's old asm-securities/gsm-securities paths (and the nsearchives CSVs) went 404 in
# June 2026; these are the current endpoints that replaced them.
ASM_URL = "https://www.nseindia.com/api/reportASM"
GSM_URL = "https://www.nseindia.com/api/reportGSM"

# Roman numeral (as used in NSE's stage descriptions, e.g. "Stage IV") -> int
_ROMAN_STAGE = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6}


def _parse_stage(text: str | None) -> int:
    """Extract a 1-6 GSM/ASM stage from an NSE surveillance description.

    reportGSM's own `gsmStage` field is an internal compound code (e.g. "LVIII")
    that does not correspond to the 1-6 severity scale — the actual stage has to be
    read out of `survDesc`, e.g. "Graded Surveillance Measure - Stage IV" -> 4,
    "GSM stage II and ..." -> 2. Entries like "Shortlisted under Graded Surveillance
    Measure" (or GSM/ASM stage folded into an IBC/encumbrance description as
    "Stage 0") carry no stage severity yet -> 0.
    """
    if not text:
        return 0
    m = re.search(r"\bStage\s+([IVX]+|\d+)\b", text, re.IGNORECASE)
    if not m:
        return 0
    token = m.group(1).upper()
    if token.isdigit():
        return int(token)
    return _ROMAN_STAGE.get(token, 0)


def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get("https://www.nseindia.com/", timeout=10)
    return s


def fetch_asm_symbols(sess: requests.Session) -> set[str] | None:
    """Returns the set of symbols currently on ASM (long-term or short-term),
    or None if the fetch itself failed (as opposed to a legitimate empty list)."""
    try:
        r = sess.get(ASM_URL, timeout=15)
        if r.status_code != 200:
            print(f"[ASM] NSE reportASM HTTP {r.status_code}")
            return None
        data = r.json()
        symbols = set()
        for bucket in ("longterm", "shortterm"):
            for item in (data.get(bucket) or {}).get("data") or []:
                sym = (item.get("symbol") or "").upper().strip()
                if sym:
                    symbols.add(sym)
        return symbols
    except Exception as e:
        print(f"[ASM] NSE reportASM fetch failed: {e}")
        return None


def fetch_gsm_symbols(sess: requests.Session) -> dict[str, int] | None:
    """Returns {symbol: gsm_stage} where stage is 0-6 (0 = shortlisted/no stage yet),
    or None if the fetch itself failed (as opposed to a legitimate empty list)."""
    try:
        r = sess.get(GSM_URL, timeout=15)
        if r.status_code != 200:
            print(f"[GSM] NSE reportGSM HTTP {r.status_code}")
            return None
        rows = r.json()
        result = {}
        for item in rows if isinstance(rows, list) else []:
            sym = (item.get("symbol") or "").upper().strip()
            if sym:
                result[sym] = _parse_stage(item.get("survDesc"))
        return result
    except Exception as e:
        print(f"[GSM] NSE reportGSM fetch failed: {e}")
        return None


def upsert_flags(asm_symbols: set[str] | None, gsm_map: dict[str, int] | None) -> int:
    """Write is_asm / gsm_stage to nse_stocks. Returns count updated.

    Refuses to touch existing flags if either fetch failed (None) — a failed fetch
    must never be indistinguishable from "genuinely zero stocks flagged today," or
    a transient NSE outage silently wipes real surveillance data platform-wide.
    """
    if asm_symbols is None or gsm_map is None:
        print("[ASM/GSM] Skipping flag update — at least one fetch failed, leaving existing flags untouched.")
        return 0

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
            # Postgres aborts the whole transaction on a failed statement (e.g. duplicate
            # column) — without this rollback every subsequent query in this connection
            # would raise InFailedSqlTransaction.
            con.rollback()

    cur.execute("UPDATE nse_stocks SET is_asm = 0, gsm_stage = 0")

    updated = 0
    all_flagged = {s: (1, 0) for s in asm_symbols}
    for sym, stage in gsm_map.items():
        is_asm = all_flagged.get(sym, (0, 0))[0]
        all_flagged[sym] = (is_asm, stage)

    for sym, (is_asm, gsm_stage) in all_flagged.items():
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
    print(f"[ASM/GSM] Found {len(asm) if asm is not None else 'FETCH FAILED'} ASM stocks, "
          f"{len(gsm) if gsm is not None else 'FETCH FAILED'} GSM stocks")
    updated = upsert_flags(asm, gsm)
    print(f"[ASM/GSM] Updated {updated} stocks in nse_stocks")

    con = connect()
    ts_updated = backfill_technical_signals(con)
    con.close()
    print(f"[ASM/GSM] Backfilled {ts_updated} rows in technical_signals")


if __name__ == "__main__":
    main()
