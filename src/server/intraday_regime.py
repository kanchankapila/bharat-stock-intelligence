#!/usr/bin/env python3
"""
Intraday regime nowcast — fuses the fast market-risk signals that are already fetched intraday
into ONE label the intraday ranker gates on:

  - India VIX          (macro_asset_prices INDIAVIX/INDIA_VIX)   — fear gauge
  - USDINR chg%        (macro_asset_prices USDINR_CHG_PCT)       — currency risk
  - Nifty futures basis(macro_asset_prices NIFTY_BASIS_PCT)      — positioning
  - Nifty PCR (OI)     (macro_asset_prices NIFTY_PUT_CALL_OI_RATIO) — options positioning
  - Market Mood Index  (macro_asset_prices INDIA_MMI)            — sentiment
  - Intraday breadth   (intraday_breadth_snapshots.breadth_score)— live participation

Publishes RISK_ON | NEUTRAL | RISK_OFF to app_settings.intraday_regime and appends a row to
intraday_regime_history. Runs every 15 min (market hours) inside the market-regime-refresh worker,
AFTER market_regime_fetcher.py has refreshed the macro inputs.

This is a fast intraday *nowcast* — separate from the daily HMM in regime_detector.py, which stays
the authority for the positional pipeline.

Run:  python intraday_regime.py
"""
import json
import datetime

from db_compat import connect

# Fusion weights (sum need not be 1 — renormalized over present inputs). Breadth + VIX carry most
# weight as the most reliable real-time risk gauges.
W = {"breadth": 0.30, "vix": 0.25, "mmi": 0.20, "usdinr": 0.15, "basis": 0.10, "pcr": 0.15}

# Label thresholds on the [-1, +1] composite (risk-on positive).
RISK_ON_AT, RISK_OFF_AT = 0.25, -0.25

# Breadth is written every ~5 min by intradayBreadth.ts off the Node server's own refresh
# loop (not a BullMQ job with catch-up) -- a restart or a slow fetchAllLiveStocks cycle can
# leave the latest row hours (or, observed 2026-07-17, TWO DAYS) old with nothing to signal
# that. A stale breadth_score still looks like a valid float, so an unguarded "latest row"
# read silently fuses yesterday's tape into today's label. Same failure class as reading any
# other should-be-fresh intraday feed without checking its age.
BREADTH_MAX_AGE_MIN = 20


def _parse_ts(raw) -> datetime.datetime:
    """snapshot_at is stored as TEXT (ISO8601, e.g. '...Z') on both SQLite and Postgres."""
    if isinstance(raw, datetime.datetime):
        dt = raw
    else:
        dt = datetime.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


def _vix_subscore(vix: float) -> float:
    """India VIX → risk-on subscore. Low vol = risk-on."""
    if vix < 12: return 1.0
    if vix < 15: return 0.5
    if vix < 20: return 0.0
    if vix < 28: return -0.5
    return -1.0


def _pcr_subscore(pcr: float) -> float:
    """Nifty put/call OI ratio → risk-on subscore. PCR ~1.0 is neutral; elevated put OI
    (>1, defensive hedging) is risk-off, call-heavy OI (<1) is risk-on. 0.35 spans the
    typical ~0.65-1.35 range most sessions trade within."""
    return max(-1.0, min(1.0, (1.0 - pcr) / 0.35))


def fuse_intraday_regime(vix=None, mmi=None, usdinr_chg=None, basis=None, breadth_score=None, pcr=None):
    """Return (label, composite). Each input is optional; weights renormalize over what's present."""
    terms = []  # (weight, subscore in [-1, 1])
    if vix is not None:
        terms.append((W["vix"], _vix_subscore(vix)))
    if mmi is not None:
        terms.append((W["mmi"], max(-1.0, min(1.0, (mmi - 50) / 25.0))))
    if usdinr_chg is not None:
        # Rupee weakening (positive chg) = risk-off; strengthening = risk-on.
        terms.append((W["usdinr"], max(-1.0, min(1.0, -usdinr_chg / 0.5))))
    if basis is not None:
        # Positive basis (contango) mildly risk-on. Scale unknown → sign only, small weight.
        terms.append((W["basis"], 0.3 if basis > 0 else -0.3))
    if breadth_score is not None:
        terms.append((W["breadth"], max(-1.0, min(1.0, (breadth_score - 0.5) * 2.0))))
    if pcr is not None:
        terms.append((W["pcr"], _pcr_subscore(pcr)))

    if not terms:
        return "NEUTRAL", 0.0
    wsum = sum(w for w, _ in terms)
    composite = sum(w * s for w, s in terms) / wsum
    label = "RISK_ON" if composite >= RISK_ON_AT else "RISK_OFF" if composite <= RISK_OFF_AT else "NEUTRAL"
    return label, round(composite, 4)


def _latest_macro(conn, symbols):
    """Today's close for the first of `symbols` that has one (fallback chain across symbol
    aliases only, NOT across dates) -- market_regime_fetcher.py runs immediately before this
    script in the same job chain, so a missing today row means that fetch failed, not that
    yesterday's VIX/basis/chg% is still a fair stand-in for today's risk state. Dropping the
    term (renormalizing the rest) is the correct degrade, same as a missing symbol today."""
    today = datetime.date.today().isoformat()
    for sym in symbols:
        r = conn.execute(
            "SELECT close FROM macro_asset_prices WHERE symbol=? AND date=?", (sym, today)
        ).fetchone()
        if r and r["close"] is not None:
            return float(r["close"])
    return None


def _fresh_breadth(conn):
    """Latest breadth_score, discarded if older than BREADTH_MAX_AGE_MIN (see module docstring)."""
    row = conn.execute(
        "SELECT breadth_score, snapshot_at FROM intraday_breadth_snapshots ORDER BY snapshot_at DESC LIMIT 1"
    ).fetchone()
    if not row or row["breadth_score"] is None:
        return None
    age_min = (datetime.datetime.now(datetime.timezone.utc) - _parse_ts(row["snapshot_at"])).total_seconds() / 60
    if age_min > BREADTH_MAX_AGE_MIN:
        print(f"[IntradayRegime] breadth snapshot stale ({age_min:.0f}m old, limit {BREADTH_MAX_AGE_MIN}m) -- dropped from fusion")
        return None
    return float(row["breadth_score"])


def _ensure_schema(conn) -> None:
    try:
        conn.execute("ALTER TABLE intraday_regime_history ADD COLUMN IF NOT EXISTS pcr REAL")
        conn.commit()
    except Exception:
        conn.rollback()


def run(conn=None):
    conn = conn or connect()
    _ensure_schema(conn)
    vix = _latest_macro(conn, ["INDIAVIX", "INDIA_VIX"])
    mmi = _latest_macro(conn, ["INDIA_MMI"])
    usdinr_chg = _latest_macro(conn, ["USDINR_CHG_PCT"])
    basis = _latest_macro(conn, ["NIFTY_BASIS_PCT"])
    # NIFTY_PUT_CALL_OI_RATIO is written by pcr_fetcher.py --gex, which now also runs every 15
    # min in the same market-regime-refresh chain immediately before this script (previously
    # only refreshed once/day EOD, so this term would have been reading yesterday's PCR all
    # session -- same _latest_macro "today only" guard as the other macro inputs applies here.
    pcr = _latest_macro(conn, ["NIFTY_PUT_CALL_OI_RATIO"])
    breadth = _fresh_breadth(conn)

    label, composite = fuse_intraday_regime(vix, mmi, usdinr_chg, basis, breadth, pcr)

    conn.execute(
        """INSERT INTO app_settings(key, value) VALUES('intraday_regime', ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (label,))
    conn.execute(
        """INSERT INTO intraday_regime_history
             (computed_at, date, regime, composite, vix, mmi, usdinr_chg, basis, breadth_score, pcr)
           VALUES (CURRENT_TIMESTAMP, CURRENT_DATE, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(computed_at) DO NOTHING""",
        (label, composite, vix, mmi, usdinr_chg, basis, breadth, pcr))
    conn.commit()
    print(json.dumps({"intraday_regime": label, "composite": composite,
                      "inputs": {"vix": vix, "mmi": mmi, "usdinr_chg": usdinr_chg,
                                 "basis": basis, "breadth": breadth, "pcr": pcr}}))
    return label


if __name__ == "__main__":
    run()
