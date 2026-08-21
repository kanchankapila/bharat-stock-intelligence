"""
Per-stock futures OI / positioning fetcher (MoneyControl FUTSTK)
===============================================================

Closes the one gap `.claude/rules/measurement.md` listed as "needs a new data source":
FnO/positioning factors (long/short buildup, short covering, rollover) could not be
reconstructed at all because nothing on this platform captured per-stock futures open
interest -- `so_stock_oi_summary.fut_oi` is 100% NULL (live-checked 2026-08-21: 5,649 rows,
0 populated, while the table is otherwise fresh, i.e. that column is simply never written).

That line was stale rather than true. The endpoint was already sitting in the onboarded
registry (`urls_sample.json`), it had just never been turned into a fetcher. Live response
for RELIANCE (`scId=RI`) carries `open_int`, `oi_change`, `oi_percchg`, `oiBuildup`
("Long Unwinding"), `rollover`, `oi_pcr`, plus `spot_price` alongside `lastprice` so basis
is derivable.

NOTHING HERE CLAIMS EDGE. This makes the factor family *measurable*; it must then be graded
through factor_edge.py / factor_backtest.py like everything else before it goes anywhere near
unified_ranker.py. `oiBuildup` in particular is a VENDOR'S OWN directional label, and this
repo has already measured one of those (`mojo_indigraph`) at no edge -- treat it as a
candidate feature, not a signal.

Run:  python mc_stock_futures_oi_fetcher.py
      python mc_stock_futures_oi_fetcher.py --symbols RELIANCE,TCS
      python mc_stock_futures_oi_fetcher.py --dry-run
"""

import argparse
import datetime
import json
import logging
import time
import urllib.request

from as_of import logical_trading_date
from db_compat import execute, executemany, query_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# In the PK. MoneyControl and Trendlyne (smartoptions .../screenType=long-buildup) both publish
# this family independently, so a table keyed on (symbol, date, expiry) alone would let whichever
# fetcher ran later silently overwrite the other's numbers -- the exact collision that hit
# index_max_pain (migration 1787010000000). See data-sources.md's composite-key rule.
SOURCE = "moneycontrol"

_EXPIRY_URL = "https://api.moneycontrol.com/mcapi/v1/fno/futures/getExpDts?id={sc_id}"
_FUTURES_URL = ("https://api.moneycontrol.com/mcapi/v1/fno/futures/getFuturesData"
                "?fut=FUTSTK&id={sc_id}&expirydate={expiry}")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.moneycontrol.com/",
}


def _get(url: str, timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


# ── Parsing (pure -- unit-testable without network or DB) ─────────────────────

def _num(v):
    """MC returns money/size as display strings: '79,580,500', '-12.48', '28.41m', 'NA'.

    Returns None rather than 0 on anything unparseable. Coercing to 0 would fabricate a
    real reading ("no OI change") out of a missing one, which is the `float(x or 0)` trap in
    recurring-bugs.md.
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if v == v else None  # NaN-safe (plain-Python form is correct here)
    s = str(v).strip().replace(",", "")
    if s in ("", "NA", "-", "null", "None"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_expiries(payload: dict) -> list[str]:
    """MC returns a dict-of-dicts keyed '0','1','2', NOT a list:
        {"success":1,"data":{"0":{"fno_exp":"2026-08-25",...},"1":{...}}}
    Parsing it as a list yields None and the futures call then 422s -- caught live while
    probing this endpoint, so the shape is asserted here rather than assumed.
    """
    data = (payload or {}).get("data") or {}
    rows = data.values() if isinstance(data, dict) else data
    out = []
    for r in rows:
        if isinstance(r, dict):
            e = r.get("fno_exp") or r.get("expirydate")
            if e:
                out.append(str(e))
        elif isinstance(r, str):
            out.append(r)
    return sorted(set(out))


def parse_futures(payload: dict) -> dict | None:
    """One FUTSTK contract -> a flat row. Returns None if the payload carries no OI."""
    d = (payload or {}).get("data") or {}
    if not isinstance(d, dict) or not d:
        return None
    open_int = _num(d.get("open_int"))
    if open_int is None:
        return None
    last = _num(d.get("lastprice"))
    spot = _num(d.get("spot_price"))
    return {
        "fno_symbol": (d.get("fno_symbol") or "").strip().upper() or None,
        "expiry": (d.get("expiry_date") or "").strip() or None,
        "open_interest": open_int,
        "oi_change": _num(d.get("oi_change")),
        "oi_pct_change": _num(d.get("oi_percchg")),
        # Vendor's own label ('Long Buildup' / 'Short Buildup' / 'Long Unwinding' /
        # 'Short Covering'). Stored verbatim, NOT normalised into a direction here -- deciding
        # what it means is a measurement question, not a parsing one.
        "oi_buildup": (d.get("oiBuildup") or "").strip() or None,
        "rollover_pct": _num(d.get("rollover")),
        "oi_pcr": _num(d.get("oi_pcr")),
        "futures_price": last,
        "spot_price": spot,
        # Positive = futures above spot (contango/premium). Both legs required; a basis
        # computed against a missing spot would be a confidently wrong number.
        "basis": (last - spot) if (last is not None and spot is not None) else None,
        "contracts": _num(d.get("contracts")),
        "futures_volume": _num(d.get("volume_data")),
        "lot_size": _num(d.get("mkt_lot")),
    }


# ── DB ────────────────────────────────────────────────────────────────────────

def ensure_schema() -> None:
    execute("""
        CREATE TABLE IF NOT EXISTS stock_futures_oi_history (
            source          TEXT NOT NULL,
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            expiry          TEXT NOT NULL,
            open_interest   DOUBLE PRECISION,
            oi_change       DOUBLE PRECISION,
            oi_pct_change   DOUBLE PRECISION,
            oi_buildup      TEXT,
            rollover_pct    DOUBLE PRECISION,
            oi_pcr          DOUBLE PRECISION,
            futures_price   DOUBLE PRECISION,
            spot_price      DOUBLE PRECISION,
            basis           DOUBLE PRECISION,
            contracts       DOUBLE PRECISION,
            futures_volume  DOUBLE PRECISION,
            lot_size        DOUBLE PRECISION,
            fetched_at      TEXT NOT NULL,
            PRIMARY KEY (source, symbol, date, expiry)
        )
    """)


_UPSERT = """
    INSERT INTO stock_futures_oi_history
      (source, symbol, date, expiry, open_interest, oi_change, oi_pct_change, oi_buildup,
       rollover_pct, oi_pcr, futures_price, spot_price, basis, contracts, futures_volume,
       lot_size, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source, symbol, date, expiry) DO UPDATE SET
      open_interest=excluded.open_interest, oi_change=excluded.oi_change,
      oi_pct_change=excluded.oi_pct_change, oi_buildup=excluded.oi_buildup,
      rollover_pct=excluded.rollover_pct, oi_pcr=excluded.oi_pcr,
      futures_price=excluded.futures_price, spot_price=excluded.spot_price,
      basis=excluded.basis, contracts=excluded.contracts,
      futures_volume=excluded.futures_volume, lot_size=excluded.lot_size,
      fetched_at=excluded.fetched_at
"""


def write_rows(rows: list[dict], as_of: str) -> int:
    """Upsert parsed rows. Split out from run() so the live_datasource test can drive the
    REAL write path against a throwaway schema and read the row back."""
    if not rows:
        return 0
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload = [
        (SOURCE, r["symbol"], as_of, r["expiry"], r["open_interest"], r["oi_change"],
         r["oi_pct_change"], r["oi_buildup"], r["rollover_pct"], r["oi_pcr"],
         r["futures_price"], r["spot_price"], r["basis"], r["contracts"],
         r["futures_volume"], r["lot_size"], now)
        for r in rows if r.get("expiry") and r.get("symbol")
    ]
    executemany(_UPSERT, payload)
    return len(payload)


def load_mc_symbol_map(symbols: list[str] | None = None) -> dict:
    """{NSE symbol: mcsymbol}. Resolution comes from nse_stocks, never constructed by
    convention -- MC's scId is opaque (data-sources.md)."""
    rows = query_all(
        "SELECT symbol, mcsymbol FROM nse_stocks "
        "WHERE mcsymbol IS NOT NULL AND mcsymbol != ''"
    )
    m = {r["symbol"]: r["mcsymbol"] for r in rows}
    if symbols:
        want = {s.strip().upper() for s in symbols}
        m = {k: v for k, v in m.items() if k.upper() in want}
    return m


def fetch_symbol(sc_id: str, max_expiries: int = 1) -> list[dict]:
    """Near-expiry contract(s) for one stock. Defaults to the near month only: that is where
    essentially all stock-futures liquidity sits, and it keeps this to 2 requests per name."""
    expiries = parse_expiries(_get(_EXPIRY_URL.format(sc_id=sc_id)))
    today = datetime.date.today().isoformat()
    future = [e for e in expiries if e >= today] or expiries
    out = []
    for exp in future[:max_expiries]:
        row = parse_futures(_get(_FUTURES_URL.format(sc_id=sc_id, expiry=exp)))
        if row:
            out.append(row)
    return out


def run(symbols: list[str] | None = None, dry_run: bool = False, sleep: float = 0.25) -> int:
    ensure_schema()
    as_of = logical_trading_date()
    mapping = load_mc_symbol_map(symbols)
    if not mapping:
        log.warning("no symbols with an mcsymbol -- nothing to fetch")
        return 0

    rows, failed = [], 0
    for i, (sym, sc_id) in enumerate(sorted(mapping.items()), 1):
        try:
            for r in fetch_symbol(sc_id):
                # Not every NSE name has a futures contract; MC answers with an empty payload
                # for those, which parse_futures already turns into None.
                r["symbol"] = sym
                rows.append(r)
        except Exception as exc:
            failed += 1
            log.warning("[%d/%d] %s (%s) failed: %s", i, len(mapping), sym, sc_id, exc)
        time.sleep(sleep)
        if i % 100 == 0:
            log.info("progress %d/%d, %d rows so far", i, len(mapping), len(rows))

    log.info("fetched %d contract rows for %s (%d symbols attempted, %d failed)",
             len(rows), as_of, len(mapping), failed)
    if dry_run:
        for r in rows[:20]:
            log.info("  %s %s OI=%s buildup=%s rollover=%s basis=%s",
                     r["symbol"], r["expiry"], r["open_interest"], r["oi_buildup"],
                     r["rollover_pct"], r["basis"])
        return len(rows)
    written = write_rows(rows, as_of)
    log.info("wrote %d rows into stock_futures_oi_history", written)
    return written


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbols", help="comma-separated NSE symbols (default: all with an mcsymbol)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    run(symbols=a.symbols.split(",") if a.symbols else None, dry_run=a.dry_run)
