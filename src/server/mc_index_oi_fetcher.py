import argparse
import datetime
import json
import logging
import time
import urllib.parse
import urllib.request

from db_compat import execute, executemany

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

SOURCE = "moneycontrol"

def _get_mc_index_map() -> dict:
    """Load {scId: index_name} from DB. Keyed by mc_oi provider_id."""
    from db_compat import load_index_map
    m = load_index_map("mc_oi")
    return m if m else {
        "in;NSX":  "NIFTY50",
        "in;nbx":  "NIFTYBANK",
    }

EXPIRY_URL = (
    "https://priceapi.moneycontrol.com/technicalCompanyData/oiData/"
    "options-expiry-dates?scId={sc_id}&assetType=I&deviceType=W"
)
OI_URL = (
    "https://priceapi.moneycontrol.com/technicalCompanyData/oiData/"
    "oi-change-chart?scId={sc_id}&expiryDate={expiry}&assetType=I"
    "&type=ALL&count=25&deviceType=W"
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.moneycontrol.com/",
    "Origin": "https://www.moneycontrol.com",
}


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def _ensure_tables():
    execute("""
        CREATE TABLE IF NOT EXISTS index_option_oi (
            index_name      TEXT NOT NULL,
            date            TEXT NOT NULL,
            expiry          TEXT NOT NULL,
            strike          REAL NOT NULL,
            ce_oi           BIGINT,
            pe_oi           BIGINT,
            ce_oi_change    BIGINT,
            pe_oi_change    BIGINT,
            ce_ltp          REAL,
            pe_ltp          REAL,
            fetched_at      TEXT NOT NULL,
            PRIMARY KEY (index_name, date, expiry, strike)
        )
    """)
    # PK includes `source`: nt_oi_snapshot_fetcher.py writes the same (index_name, date, expiry)
    # key for NIFTY50/NIFTYBANK from NiftyTrader's own OI data -- without the provider in the
    # key, whichever fetcher runs later silently overwrites the other's max_pain/pcr_oi
    # (migration 1787010000000, data-sources.md's composite-key rule). This CREATE TABLE only
    # matters for a fresh SQLite dev DB; the live Postgres table is repaired by the migration.
    execute("""
        CREATE TABLE IF NOT EXISTS index_max_pain (
            source       TEXT NOT NULL,
            index_name   TEXT NOT NULL,
            date         TEXT NOT NULL,
            expiry       TEXT NOT NULL,
            max_pain     REAL,
            pcr_oi       REAL,
            total_ce_oi  BIGINT,
            total_pe_oi  BIGINT,
            fetched_at   TEXT NOT NULL,
            PRIMARY KEY (source, index_name, date, expiry)
        )
    """)


def _fetch_expiries(sc_id: str) -> list[str]:
    url = EXPIRY_URL.format(sc_id=urllib.parse.quote(sc_id, safe=";"))
    try:
        data = _get(url)
    except Exception as exc:
        log.warning("expiry fetch failed for %s: %s", sc_id, exc)
        return []

    # MC response: {"data": {"default_expiry": {...}, "dataList": [{"expiryDate": "2026-06-30", ...}, ...]}}
    mc_data = data.get("data") or {}
    raw = []
    if isinstance(mc_data, dict):
        raw = mc_data.get("dataList") or mc_data.get("expiryDates") or []
    elif isinstance(mc_data, list):
        raw = mc_data

    dates: list[str] = []
    for item in raw:
        if isinstance(item, str):
            dates.append(item)
        elif isinstance(item, dict):
            val = item.get("expiryDate") or item.get("date") or item.get("value") or ""
            if val:
                dates.append(str(val))
    return dates


def _near_term_expiries(expiries: list[str], n: int = 3) -> list[str]:
    today = datetime.date.today().isoformat()
    future = sorted(e for e in expiries if e >= today)
    return future[:n]


def _parse_oi_row(item: dict) -> dict | None:
    def _int(v):
        try:
            return int(v) if v not in (None, "", "NA") else None
        except (ValueError, TypeError):
            return None

    def _float(v):
        try:
            return float(v) if v not in (None, "", "NA") else None
        except (ValueError, TypeError):
            return None

    strike = _float(
        item.get("strikePrice") or item.get("strike") or item.get("strikeprice")
    )
    if strike is None:
        return None

    # BUG FOUND 2026-08-07 (dead-column sweep): none of the pre-existing key guesses
    # matched MC's real "oi-change-chart" payload, which live-verified returns
    # {"strikePrice", "callOi", "callOiChange", "putOi", "putOiChange"} per row (note
    # "callOi" -- lowercase i, NOT "callOI"/"callOpenInterest"). ce_oi_change/pe_oi_change
    # happened to work already ("callOiChange" was the last item in that OR chain and
    # matches exactly) -- only the OI-level fields ce_oi/pe_oi were silently always None.
    # Confirmed live impact: index_option_oi's ce_oi/pe_oi were 100% NULL across all 2,206
    # NIFTY50/NIFTYBANK rows, and _compute_max_pain() degenerated to picking the first
    # candidate strike (min_loss stays 0 for every settlement when ce_oi/pe_oi are always
    # `or 0`), which happened to still land inside the real strike range -- so the
    # live_datasource test's `min(strikes) <= max_pain <= max(strikes)` check was a false
    # pass throughout. "callOi"/"putOi" added as the first (correct) candidate below.
    ce_oi = _int(
        item.get("callOi") or item.get("callOpenInterest") or item.get("ceOpenInterest")
        or item.get("ce_oi") or item.get("callOI")
    )
    pe_oi = _int(
        item.get("putOi") or item.get("putOpenInterest") or item.get("peOpenInterest")
        or item.get("pe_oi") or item.get("putOI")
    )
    ce_chg = _int(
        item.get("callOiChange") or item.get("callOIChange") or item.get("ceOIChange")
        or item.get("ce_oi_change")
    )
    pe_chg = _int(
        item.get("putOiChange") or item.get("putOIChange") or item.get("peOIChange")
        or item.get("pe_oi_change")
    )
    # ce_ltp/pe_ltp are expected to stay None for this endpoint: live-verified 2026-08-07
    # that MC's oi-change-chart payload carries no per-strike LTP field at all (OI/OI-change
    # only) -- this is not a parsing bug, per-strike LTP would need a different MC endpoint.
    ce_ltp = _float(
        item.get("callLTP") or item.get("ceLTP") or item.get("ce_ltp")
    )
    pe_ltp = _float(
        item.get("putLTP") or item.get("peLTP") or item.get("pe_ltp")
    )

    return {
        "strike": strike,
        "ce_oi": ce_oi,
        "pe_oi": pe_oi,
        "ce_oi_change": ce_chg,
        "pe_oi_change": pe_chg,
        "ce_ltp": ce_ltp,
        "pe_ltp": pe_ltp,
    }


def _compute_max_pain(rows: list[dict]) -> float | None:
    strikes = [r["strike"] for r in rows if r["strike"] is not None]
    if not strikes:
        return None

    min_loss = None
    max_pain_strike = None

    for settlement in strikes:
        total_loss = 0.0
        for r in rows:
            s = r["strike"]
            if s is None:
                continue
            ce_oi = r["ce_oi"] or 0
            pe_oi = r["pe_oi"] or 0
            # Fixed 2026-07-30 (Finding #51, full-stack audit): call/put OI were swapped --
            # call writers lose (and are weighted by CALL oi) when settlement > strike; put
            # writers lose (weighted by PUT oi) when settlement < strike. Verified against
            # the correct implementation already used elsewhere in this codebase
            # (pcr_fetcher.py x2, nt_oi_snapshot_fetcher.py).
            total_loss += max(0.0, settlement - s) * ce_oi
            total_loss += max(0.0, s - settlement) * pe_oi
        if min_loss is None or total_loss < min_loss:
            min_loss = total_loss
            max_pain_strike = settlement

    return max_pain_strike


def _fetch_and_store(sc_id: str, expiry: str, date: str, fetched_at: str) -> int:
    _map = _get_mc_index_map()
    index_name = _map.get(sc_id, sc_id)
    url = OI_URL.format(
        sc_id=urllib.parse.quote(sc_id, safe=";"),
        expiry=expiry,
    )
    try:
        data = _get(url)
    except Exception as exc:
        log.warning("OI fetch failed %s expiry=%s: %s", index_name, expiry, exc)
        return 0

    # MC OI change chart response structure:
    # {"data": {"type": "HIST", "results": {"2026-06-25": {"list": [...], "atm": 24050, "total": {...}}}}}
    raw_rows = []
    oi_date = date  # use requested date as default
    mc_data = data.get("data") or {}
    mc_results = mc_data.get("results") if isinstance(mc_data, dict) else None
    if mc_results and isinstance(mc_results, dict):
        # Latest available date in the results dict
        oi_date = max(mc_results.keys(), default=date)
        date_block = mc_results.get(oi_date) or {}
        raw_rows = date_block.get("list") or []
    if not raw_rows:
        # Fallback: flat list under data
        flat = data.get("oiData") or data.get("oi_data") or []
        if isinstance(flat, list):
            raw_rows = flat

    parsed = [_parse_oi_row(item) for item in raw_rows]
    parsed = [r for r in parsed if r is not None]
    if not parsed:
        log.warning("no OI rows parsed for %s expiry=%s", index_name, expiry)
        return 0

    oi_rows = [
        (
            index_name, oi_date, expiry,
            r["strike"], r["ce_oi"], r["pe_oi"],
            r["ce_oi_change"], r["pe_oi_change"],
            r["ce_ltp"], r["pe_ltp"],
            fetched_at,
        )
        for r in parsed
    ]

    executemany(
        """
        INSERT INTO index_option_oi
            (index_name, date, expiry, strike,
             ce_oi, pe_oi, ce_oi_change, pe_oi_change, ce_ltp, pe_ltp, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (index_name, date, expiry, strike) DO UPDATE SET
            ce_oi        = EXCLUDED.ce_oi,
            pe_oi        = EXCLUDED.pe_oi,
            ce_oi_change = EXCLUDED.ce_oi_change,
            pe_oi_change = EXCLUDED.pe_oi_change,
            ce_ltp       = EXCLUDED.ce_ltp,
            pe_ltp       = EXCLUDED.pe_ltp,
            fetched_at   = EXCLUDED.fetched_at
        """,
        oi_rows,
    )

    max_pain = _compute_max_pain(parsed)
    total_ce = sum(r["ce_oi"] or 0 for r in parsed)
    total_pe = sum(r["pe_oi"] or 0 for r in parsed)
    pcr_oi = (total_pe / total_ce) if total_ce else None

    execute(
        """
        INSERT INTO index_max_pain
            (source, index_name, date, expiry, max_pain, pcr_oi, total_ce_oi, total_pe_oi, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, index_name, date, expiry) DO UPDATE SET
            max_pain    = EXCLUDED.max_pain,
            pcr_oi      = EXCLUDED.pcr_oi,
            total_ce_oi = EXCLUDED.total_ce_oi,
            total_pe_oi = EXCLUDED.total_pe_oi,
            fetched_at  = EXCLUDED.fetched_at
        """,
        (SOURCE, index_name, date, expiry, max_pain, pcr_oi, total_ce, total_pe, fetched_at),
    )

    log.info(
        "%s expiry=%s  strikes=%d  max_pain=%.0f  PCR=%.2f",
        index_name, expiry, len(parsed),
        max_pain or 0, pcr_oi or 0,
    )
    return len(parsed)


def run(sc_ids: list[str] | None = None, expiry_override: str | None = None):
    _ensure_tables()
    date = datetime.date.today().isoformat()
    fetched_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    targets = sc_ids if sc_ids else list(_get_mc_index_map().keys())

    for sc_id in targets:
        if expiry_override:
            expiries = [expiry_override]
        else:
            expiries = _near_term_expiries(_fetch_expiries(sc_id), n=3)

        if not expiries:
            log.warning("no expiries found for %s", sc_id)
            continue

        for expiry in expiries:
            _fetch_and_store(sc_id, expiry, date, fetched_at)
            time.sleep(0.4)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch index option OI from MoneyControl")
    parser.add_argument("--index", help="scId to fetch (e.g. 'in;NSX'). Defaults to all.")
    parser.add_argument("--expiry", help="Expiry date YYYY-MM-DD. Defaults to near-term expiries.")
    args = parser.parse_args()

    sc_ids = [args.index] if args.index else None
    run(sc_ids=sc_ids, expiry_override=args.expiry)
