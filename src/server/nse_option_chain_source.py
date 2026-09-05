"""NSE's own option chain (`option-chain-v3`) as an authoritative fallback source.

Why this exists
---------------
`so_chain_source.py` recorded NSE's option-chain endpoints as dead: "HTTP 200 with a literal
empty `{}` (2 bytes)", verified as upstream rather than a WAF/JA3 problem. Re-measured
2026-09-05, that finding is true only for a call WITHOUT an `expiry` query parameter:

    option-chain-v3?type=Equity&symbol=TCS                        -> 200, 2 bytes, {}
    option-chain-v3?type=Equity&symbol=TCS&expiry=29-Sep-2026     -> 200, 97KB, 47 strikes

The endpoint was never dead; the call was incomplete. Confirmed live for all 8 names
`pcr_fetcher.py` reports as uncovered (RELIANCE, SBIN, SUNPHARMA, TCS, TECHM, TITAN,
ULTRACEMCO, WIPRO) and for indices.

This is NOT a new vendor under `data-sources.md`'s onboarding freeze -- NSE is already the
canonical identifier authority for this entire platform, and this repairs an existing
integration rather than adding a dependency.

What it does and does not carry
-------------------------------
NSE publishes per-strike OI, change-in-OI, volume, IV and last price for both legs. It does
NOT publish Greeks (delta/gamma/theta/vega/rho) or a buildup label, which Trendlyne
SmartOptions and NiftyTrader both do. So this is a COVERAGE fallback, not a replacement:
real OI/IV rows with NULL Greeks beat the zero rows that a starved symbol gets today.

Greeks are written as None rather than 0.0 deliberately. A 0.0 delta is a legitimate value
for a deep-OTM option, so a zero sentinel here would be indistinguishable after the fact from
a real reading -- `recurring-bugs.md`'s sentinel-instead-of-NULL class, which it also records
as NOT retroactively fixable.

Expiry convention, measured 2026-09-05 against live `nt_fno_expiry` and confirmed by this
endpoint's own `expiryDates`: equity F&O expiries are the month's last TUESDAY
(29-Sep/27-Oct/23-Nov, the last shifted back by a holiday), and the weekly Tuesdays
(08/15/22-Sep) are INDEX-only. There is no Thursday expiry -- see `last_tuesday_expiry()`.
"""
from __future__ import annotations

import sys

# The row tuple `save_chain()` inserts. Kept as a named constant so the two parsers that feed
# the same INSERT (this one and so_option_chain_fetcher._parse_chain) cannot silently drift
# apart -- a shape change in either shifts every column by one, with no error.
CHAIN_ROW_FIELDS = 28


def _f(v):
    """Float or None. Never 0.0-for-missing: see the module docstring on sentinels."""
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # NaN check; plain Python != is correct here (not SQL)


def parse_nse_chain(payload: dict, symbol: str, today: str, expiry: str):
    """Parse an `option-chain-v3` response into (chain_rows, summary).

    Returns the identical shapes `so_option_chain_fetcher._parse_chain` returns, so both
    sources feed `save_chain()` unchanged.
    """
    records = (payload or {}).get("records") or {}
    data = records.get("data") or []
    if not data:
        return [], None

    underlying = _f(records.get("underlyingValue"))
    rows = []
    for rec in data:
        strike = _f(rec.get("strikePrice"))
        if strike is None:
            continue
        ce = rec.get("CE") or {}
        pe = rec.get("PE") or {}
        rows.append((
            symbol, today, expiry, strike,
            # CE: price, volume, oi, oi_chg, iv, then iv_chg + 5 Greeks + buildup (unpublished)
            _f(ce.get("lastPrice")), _f(ce.get("totalTradedVolume")),
            _f(ce.get("openInterest")), _f(ce.get("changeinOpenInterest")),
            _f(ce.get("impliedVolatility")),
            None, None, None, None, None, None, None,
            # PE, same layout
            _f(pe.get("lastPrice")), _f(pe.get("totalTradedVolume")),
            _f(pe.get("openInterest")), _f(pe.get("changeinOpenInterest")),
            _f(pe.get("impliedVolatility")),
            None, None, None, None, None, None, None,
        ))

    if not rows:
        return [], None

    total_ce_oi = sum(r[6] or 0.0 for r in rows)
    total_pe_oi = sum(r[18] or 0.0 for r in rows)

    # ATM = strike nearest spot. Falls back to the middle strike when NSE omits
    # underlyingValue, rather than raising -- an ATM we cannot pin down is not a reason to
    # discard a chain whose OI is perfectly good.
    if underlying is not None:
        atm_row = min(rows, key=lambda r: abs(r[3] - underlying))
    else:
        atm_row = sorted(rows, key=lambda r: r[3])[len(rows) // 2]

    # NSE does not publish max pain, so compute it the same way pcr_fetcher does: the strike
    # minimising total intrinsic value payable to option holders at expiry.
    best_pain, max_pain = float("inf"), atm_row[3]
    for sp, _x, _y in ((r[3], None, None) for r in rows):
        pain = 0.0
        for r in rows:
            st = r[3]
            if sp > st:
                pain += (r[6] or 0.0) * (sp - st)     # calls ITM
            elif sp < st:
                pain += (r[18] or 0.0) * (st - sp)    # puts ITM
        if pain < best_pain:
            best_pain, max_pain = pain, sp

    summary = {
        "symbol": symbol,
        "date": today,
        "expiry": expiry,
        "max_pain": max_pain,
        "atm": atm_row[3],
        "mwpl": None,          # NSE publishes MWPL separately, not on this endpoint
        "iv_call": atm_row[8],
        "iv_put": atm_row[20],
        "pcr": (total_pe_oi / total_ce_oi) if total_ce_oi else None,
        "fut_price": None,
        "fut_oi": None,
        "fut_oi_chg": None,
    }
    return rows, summary


CHAIN_V3_URL = (
    "https://www.nseindia.com/api/option-chain-v3"
    "?type={kind}&symbol={symbol}&expiry={expiry}"
)


def fetch_nse_chain(session, symbol: str, expiry_ddmmmyyyy: str, is_index: bool = False):
    """Fetch one chain. `expiry_ddmmmyyyy` must be NSE's own format, e.g. '29-Sep-2026'.

    `session` must be a warmed NSE session (`preopen_fetcher._nse_session()`); a cold session
    is refused by NSE's WAF regardless of headers.
    """
    url = CHAIN_V3_URL.format(
        kind="Indices" if is_index else "Equity",
        symbol=symbol.upper(),
        expiry=expiry_ddmmmyyyy,
    )
    try:
        r = session.get(url, timeout=25)
        if not r.ok or len(r.text or "") < 100:
            return None
        return r.json()
    except Exception as e:
        print(f"[NSEChain] {symbol}/{expiry_ddmmmyyyy}: fetch error - {e}", file=sys.stderr)
        return None


def to_nse_expiry(iso_date: str) -> str:
    """'2026-09-29' -> '29-Sep-2026', the only format this endpoint accepts."""
    import datetime
    d = datetime.date.fromisoformat(iso_date[:10])
    return f"{d.day:02d}-{d.strftime('%b')}-{d.year}"
