#!/usr/bin/env python3
"""
Intraday regime nowcast — fuses the fast market-risk signals that are already fetched intraday
into ONE label the intraday ranker gates on:

  - India VIX          (macro_asset_prices INDIAVIX/INDIA_VIX)   — fear gauge
  - USDINR chg%        (macro_asset_prices USDINR_CHG_PCT)       — currency risk
  - Nifty futures basis(macro_asset_prices NIFTY_BASIS_PCT)      — positioning
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

from db_compat import connect

# Fusion weights (sum need not be 1 — renormalized over present inputs). Breadth + VIX carry most
# weight as the most reliable real-time risk gauges.
W = {"breadth": 0.30, "vix": 0.25, "mmi": 0.20, "usdinr": 0.15, "basis": 0.10}

# Label thresholds on the [-1, +1] composite (risk-on positive).
RISK_ON_AT, RISK_OFF_AT = 0.25, -0.25


def _vix_subscore(vix: float) -> float:
    """India VIX → risk-on subscore. Low vol = risk-on."""
    if vix < 12: return 1.0
    if vix < 15: return 0.5
    if vix < 20: return 0.0
    if vix < 28: return -0.5
    return -1.0


def fuse_intraday_regime(vix=None, mmi=None, usdinr_chg=None, basis=None, breadth_score=None):
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

    if not terms:
        return "NEUTRAL", 0.0
    wsum = sum(w for w, _ in terms)
    composite = sum(w * s for w, s in terms) / wsum
    label = "RISK_ON" if composite >= RISK_ON_AT else "RISK_OFF" if composite <= RISK_OFF_AT else "NEUTRAL"
    return label, round(composite, 4)


def _latest_macro(conn, symbols):
    """Latest close for the first of `symbols` that has any data (fallback chain)."""
    for sym in symbols:
        r = conn.execute(
            "SELECT close FROM macro_asset_prices WHERE symbol=? ORDER BY date DESC LIMIT 1", (sym,)
        ).fetchone()
        if r and r["close"] is not None:
            return float(r["close"])
    return None


def run(conn=None):
    conn = conn or connect()
    vix = _latest_macro(conn, ["INDIAVIX", "INDIA_VIX"])
    mmi = _latest_macro(conn, ["INDIA_MMI"])
    usdinr_chg = _latest_macro(conn, ["USDINR_CHG_PCT"])
    basis = _latest_macro(conn, ["NIFTY_BASIS_PCT"])
    br = conn.execute(
        "SELECT breadth_score FROM intraday_breadth_snapshots ORDER BY snapshot_at DESC LIMIT 1"
    ).fetchone()
    breadth = float(br["breadth_score"]) if br and br["breadth_score"] is not None else None

    label, composite = fuse_intraday_regime(vix, mmi, usdinr_chg, basis, breadth)

    conn.execute(
        """INSERT INTO app_settings(key, value) VALUES('intraday_regime', ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (label,))
    conn.execute(
        """INSERT INTO intraday_regime_history
             (computed_at, date, regime, composite, vix, mmi, usdinr_chg, basis, breadth_score)
           VALUES (CURRENT_TIMESTAMP, CURRENT_DATE, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(computed_at) DO NOTHING""",
        (label, composite, vix, mmi, usdinr_chg, basis, breadth))
    conn.commit()
    print(json.dumps({"intraday_regime": label, "composite": composite,
                      "inputs": {"vix": vix, "mmi": mmi, "usdinr_chg": usdinr_chg,
                                 "basis": basis, "breadth": breadth}}))
    return label


if __name__ == "__main__":
    run()
