"""Read an option chain out of `so_option_chain` instead of a live vendor API.

Why this exists (2026-09-04)
----------------------------
Both option-chain network sources this platform used went dead on the same day, and BOTH
consumers failed silently rather than loudly:

  - NiftyTrader (`webapi.niftytrader.in/webapi/option/option-chain-data`) answers HTTP 200
    with {"result":0,"resultMessage":"Unauthorized: You are not authorized to access this
    resource."}. This is the path `pcr_fetcher.fetch_symbol_niftytrader` and
    `stock_option_chain_fetcher.fetch_chain` both use.
  - NSE's own `/api/option-chain-equities` AND `/api/option-chain-v3` answer HTTP 200 with a
    literal empty `{}` (2 bytes). Verified upstream rather than a WAF/JA3/cookie problem on
    our side: the SAME warmed curl_cffi session from `preopen_fetcher._nse_session()` pulls
    2.1MB from NSE's `market-data-pre-open?key=ALL` in the same run.

Measured consequence before this module: `pcr_fetcher.py` scored 0/20 symbols, and
`stock_option_chain_fetcher.py` -- the writer that actually produces ~212 `stock_options_oi`
rows a day -- scored 0/214 while still exiting 0, so its ml-daily-ops step reported success.
`stock_options_oi` had gone stale after 2026-09-02 and the
`stock-options-oi-freshness-iv-coverage` data-quality check was failing critical.

This is deliberately NOT a new vendor (see data-sources.md's vendor-onboarding freeze).
`so_option_chain` is already onboarded, already scheduled and already fresh: it is written
daily by `so_option_chain_fetcher.py` from Trendlyne SmartOptions and carries every field
these consumers need (ce_oi/pe_oi/ce_price/pe_price/ce_iv/pe_iv/ce_volume/pe_volume/strike/
expiry). Nothing new is fetched here -- this reads a table we already populate.

Coverage caveat, measured: SmartOptions carries ~179 F&O names in total and 150-165 on a
complete day. A symbol it does not carry returns None here, which callers must report as
"no surviving source covers this" rather than as a fetch failure -- see `has_chain()`.
"""
from __future__ import annotations

import datetime

from sqlalchemy import text

# How far behind so_option_chain's own newest date a per-symbol chain may be and still be
# used. Small on purpose: callers stamp the rows they write with TODAY's date, so anything
# older is a silent-staleness bug, not a degraded read.
MAX_CHAIN_STALENESS_DAYS = 5


def as_date(v) -> datetime.date:
    """Coerce a date column value to `datetime.date`, tolerating both shapes.

    `db_compat` registers a global DATE->str caster (mirroring pgClient.ts's
    `types.setTypeParser(DATE, v => v)`), so a native DATE column arrives here as an ISO
    string even though psycopg2 would otherwise hand back a `datetime.date`. Accept either
    rather than assuming one, so this keeps working if that caster is ever scoped differently.
    """
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    return datetime.date.fromisoformat(str(v)[:10])


def _latest_dates(conn, symbol: str):
    return conn.execute(text(
        "SELECT (SELECT max(date) FROM so_option_chain WHERE symbol = :s) AS sym_d, "
        "       (SELECT max(date) FROM so_option_chain) AS tbl_d"
    ), {"s": symbol}).mappings().first()


def has_chain(engine, symbol: str) -> bool:
    """True when `so_option_chain` holds a chain for `symbol` recent enough to be usable.

    Callers use this to tell "we tried and failed" apart from "no surviving source carries
    this name". Only the first is a fetch failure worth failing a run over; the second is a
    coverage fact, and coverage is judged by the `stock-options-oi-freshness-iv-coverage`
    data-quality check, not by a fetcher's exit code. Conflating them would make the
    ml-daily-ops step fail every single night for as long as the vendors stay down -- and a
    monitor that always fires carries no information (ml-model-bugs.md, drift_detector).
    """
    try:
        with engine.begin() as conn:
            d = _latest_dates(conn, symbol)
        if not d or not d["sym_d"] or not d["tbl_d"]:
            return False
        return (as_date(d["tbl_d"]) - as_date(d["sym_d"])).days <= MAX_CHAIN_STALENESS_DAYS
    except Exception:
        return False


def chain_rows(engine, symbol: str):
    """Return `(as_of, spot, rows)` for the newest usable chain, or None.

    Applies two independent guards, both of which were written against a real observation
    rather than defensively:

    1. Staleness. The per-symbol `max(date)` for a name SmartOptions has since dropped can be
       weeks old, and callers stamp what they write with TODAY's date -- so an August chain
       would be written as today's PCR/IV. (Caught live: RELIANCE resolved to a 2026-08-25
       chain.)
    2. Expiry. An already-passed nearest expiry means the chain describes contracts that no
       longer exist, whatever its date says. PCR/max-pain/expected-move computed off expired
       contracts is meaningless, not merely stale.

    `rows` is restricted to the nearest expiry that has NOT already passed -- front-month,
    matching what the original NSE path used (`expiry_dates[0]`), so the history in
    `stock_options_oi` stays comparable. Taking the furthest-out expiry instead would silently
    change what the pcr/atm_iv columns mean partway through the series.
    """
    with engine.begin() as conn:
        d = _latest_dates(conn, symbol)
        if not d or not d["sym_d"] or not d["tbl_d"]:
            return None
        as_of = d["sym_d"]
        if (as_date(d["tbl_d"]) - as_date(as_of)).days > MAX_CHAIN_STALENESS_DAYS:
            return None

        rows = conn.execute(text(
            "SELECT expiry, strike, ce_oi, pe_oi, ce_iv, pe_iv, ce_volume, pe_volume, "
            "       ce_price, pe_price "
            "FROM so_option_chain WHERE symbol = :s AND date = :d"
        ), {"s": symbol, "d": as_of}).mappings().all()
        if not rows:
            return None

        px = conn.execute(text(
            "SELECT close FROM stock_ohlcv WHERE symbol = :s AND date <= :d "
            "ORDER BY date DESC LIMIT 1"
        ), {"s": symbol, "d": as_of}).mappings().first()

    spot = float(px["close"]) if px and px["close"] is not None else 0.0

    live = [r["expiry"] for r in rows if r["expiry"] and str(r["expiry"]) >= str(as_of)]
    if not live:
        return None
    nearest = min(live)
    return as_of, spot, [r for r in rows if r["expiry"] == nearest]


def as_niftytrader_payload(spot: float, rows: list) -> dict:
    """Shape `chain_rows()` output like a NiftyTrader `resultData` payload.

    Lets `stock_option_chain_fetcher.compute_features()` run UNCHANGED against this source
    instead of growing a second, hand-rolled copy of the same feature maths -- the failure
    mode ml-model-bugs.md records for `cs_ranker.py`/`exit_policy.py`, where a second script
    reimplemented a shared query narrowly and silently trained on a hollowed-out matrix.
    Key names match `_f()`'s first alias for each field.
    """
    return {
        "spotPrice": spot,
        "opDatas": [
            {
                "strike_price": r["strike"],
                "expiry_date":  str(r["expiry"]),
                "calls_oi":     r["ce_oi"],
                "puts_oi":      r["pe_oi"],
                "calls_volume": r["ce_volume"],
                "puts_volume":  r["pe_volume"],
                "calls_iv":     r["ce_iv"],
                "puts_iv":      r["pe_iv"],
                "calls_ltp":    r["ce_price"],
                "puts_ltp":     r["pe_price"],
                "index_close":  spot,
            }
            for r in rows
        ],
    }
