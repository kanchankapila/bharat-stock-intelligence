#!/usr/bin/env python3
"""
Early Hours Spotter / Breakout Predictor
========================================
Combines 4 criteria at market open to spot aggressive breakout moves:
1. High Pre-Open Order Book Imbalance (buy skew > 0.3)
2. Previous Day Corporate Action Filters (screen filings after market close)
3. Immediate Technical Moving Average Breakouts (iep crossing SMA20, 50, or 200)
4. Post-Close Delivery Volume Spikes (T-1 delivery volume vs 5-day average)

Writes to early_hours_predictions table and outputs candidates.
"""

import polars as pl
import sys
import os
import argparse
import datetime
import json
import logging
import numpy as np
import pandas as pd

# Path setup
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from db_compat import connect, translate, use_postgres

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS early_hours_predictions (
            symbol                 TEXT NOT NULL,
            date                   TEXT NOT NULL,
            score                  REAL NOT NULL,
            iep_gap_pct            REAL,
            preopen_imbalance      REAL,
            delivery_spike_pct     REAL,
            has_corporate_action   INTEGER DEFAULT 0,
            corporate_action_title TEXT,
            breakout_signals       TEXT, -- comma-separated tags e.g. "SMA20 Breakout,Bullish Trend"
            reasons_json           TEXT, -- details of triggers for UI tooltip
            computed_at            TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """))
    cur.execute(translate("CREATE INDEX IF NOT EXISTS idx_ehp_date ON early_hours_predictions(date DESC)"))
    con.commit()


def get_trading_dates(con, target_date: str) -> list[str]:
    """Retrieve target_date T-1, T-2... T-6 from stock_delivery_volume."""
    cur = con.cursor()
    # Find dates strictly before target_date
    cur.execute(translate("""
        SELECT DISTINCT date 
        FROM stock_delivery_volume 
        WHERE date < ? 
        ORDER BY date DESC 
        LIMIT 6
    """), [target_date])
    rows = cur.fetchall()
    return [r[0] for r in rows]


def fetch_preopen_snapshots(con, target_date: str) -> dict[str, dict]:
    """Fetch preopen snapshot for a given date."""
    cur = con.cursor()
    cur.execute(translate("""
        SELECT symbol, iep, prev_close, iep_gap_pct, total_buy_qty, total_sell_qty, preopen_imbalance
        FROM preopen_stock_snapshot
        WHERE snapshot_date = ?
    """), [target_date])
    rows = cur.fetchall()
    
    out = {}
    for r in rows:
        sym = r[0]
        out[sym] = {
            "symbol": sym,
            "iep": r[1],
            "prev_close": r[2],
            "iep_gap_pct": r[3],
            "total_buy_qty": r[4],
            "total_sell_qty": r[5],
            "preopen_imbalance": r[6]
        }
    return out


def fetch_delivery_data(con, dates: list[str]) -> pd.DataFrame:
    """Fetch delivery volume data for the specified dates."""
    if not dates:
        return pd.DataFrame()
    
    cur = con.cursor()
    placeholders = ",".join(["?"] * len(dates))
    query = f"""
        SELECT symbol, date, deliverable_qty, qty_traded, delivery_pct
        FROM stock_delivery_volume
        WHERE date IN ({placeholders})
    """
    cur.execute(translate(query), dates)
    rows = cur.fetchall()
    
    data = []
    for r in rows:
        data.append({
            "symbol": r[0],
            "date": r[1],
            "deliverable_qty": r[2],
            "qty_traded": r[3],
            "delivery_pct": r[4]
        })
    return pd.DataFrame(data)


def fetch_corporate_announcements(con, t1_date: str, t0_date: str) -> dict[str, list[dict]]:
    """Fetch BSE corporate announcements after market close of T-1 up to market open of T-0."""
    cur = con.cursor()
    # Window: T-1 15:30:00 (close) up to T-0 09:15:00 (open) — the upper bound matters for
    # historical/backfill runs (run_predictor with an explicit --date): without it, same-day
    # or later announcements leak into the +15-point has_corporate_action score component.
    cutoff = f"{t1_date} 15:30:00"
    open_cutoff = f"{t0_date} 09:15:00"

    cur.execute(translate("""
        SELECT symbols_json, title, summary, published_at
        FROM news_sentiment_items
        WHERE source = 'BSE Announcements'
          AND published_at >= ?
          AND published_at < ?
    """), [cutoff, open_cutoff])
    rows = cur.fetchall()
    
    out = {}
    keywords = [
        "e-voting", "evoting", "resolution", "postal ballot", "agm", "egm",
        "meeting", "dividend", "merger", "demerger", "bonus", "split", "buyback",
        "rights issue", "acquisition", "takeover", "order", "contract", "filing"
    ]
    
    for r in rows:
        sym_json, title, summary, pub_at = r[0], r[1], r[2], r[3]
        if not sym_json:
            continue
        try:
            symbols = json.loads(sym_json)
        except Exception:
            continue
            
        full_text = f"{title or ''} {summary or ''}".lower()
        matched_kw = [kw for kw in keywords if kw in full_text]
        
        if matched_kw:
            event = {
                "title": title,
                "summary": summary,
                "published_at": pub_at,
                "keywords": matched_kw
            }
            for sym in symbols:
                sym_upper = sym.upper()
                if sym_upper not in out:
                    out[sym_upper] = []
                out[sym_upper].append(event)
                
    return out


def fetch_historical_ohlcv(con, symbol: str, cutoff_date: str, limit: int = 200) -> list[float]:
    """Fetch last N closes up to but not including cutoff_date."""
    cur = con.cursor()
    cur.execute(translate("""
        SELECT close 
        FROM stock_ohlcv 
        WHERE symbol = ? AND date < ? 
        ORDER BY date DESC 
        LIMIT ?
    """), [symbol, cutoff_date, limit])
    rows = cur.fetchall()
    return [float(r[0]) for r in rows]


def run_predictor(target_date: str = None) -> list[dict]:
    con = connect()
    ensure_schema(con)
    
    cur = con.cursor()
    if not target_date:
        # Default to latest date in preopen snapshot
        cur.execute(translate("SELECT MAX(snapshot_date) FROM preopen_stock_snapshot"))
        target_date = cur.fetchone()[0]
        if not target_date:
            target_date = datetime.date.today().strftime("%Y-%m-%d")
            
    log.info("Running Early Hours Predictor for date: %s", target_date)
    
    # 1. Fetch preopen snapshots
    preopen_snaps = fetch_preopen_snapshots(con, target_date)
    if not preopen_snaps:
        log.warning("No pre-open snapshots found for %s", target_date)
        con.close()
        return []
    
    # 2. Retrieve trading dates (T-1 ... T-6)
    prev_dates = get_trading_dates(con, target_date)
    if len(prev_dates) < 6:
        log.warning("Insufficient historical delivery dates found prior to %s (found: %s)", target_date, prev_dates)
        con.close()
        return []
    
    t1_date = prev_dates[0]
    t2_t6_dates = prev_dates[1:6]
    log.info("Target T0: %s | T-1: %s | T-2..T-6: %s", target_date, t1_date, t2_t6_dates)
    
    # 3. Fetch delivery data
    df_delivery = fetch_delivery_data(con, prev_dates)
    
    # 4. Fetch BSE corporate announcements
    corp_announcements = fetch_corporate_announcements(con, t1_date, target_date)
    
    # 5. Score candidates
    candidates = []
    
    # Filter preopen items to Nifty/F&O list
    symbols_to_process = list(preopen_snaps.keys())
    
    # Fetch historical closes in bulk where possible, or on the fly
    for symbol in symbols_to_process:
        snap = preopen_snaps[symbol]
        iep_gap = snap["iep_gap_pct"] or 0.0
        imbalance = snap["preopen_imbalance"] or 0.0
        
        # We only scan stocks showing positive momentum (gap-up > 0)
        if iep_gap <= 0:
            continue
            
        # Compute delivery volume spike
        delivery_spike_pct = 0.0
        if not df_delivery.empty:
            sym_del = df_delivery[df_delivery["symbol"] == symbol]
            if not sym_del.empty:
                t1_del = sym_del[sym_del["date"] == t1_date]
                t2_t6_del = sym_del[sym_del["date"].isin(t2_t6_dates)]
                
                if not t1_del.empty and not t2_t6_del.empty:
                    # deliverable_qty = qty_traded * delivery_pct / 100 or deliverable_qty directly
                    # The table has deliverable_qty or delivery_qty. Our ensure_schema/fetcher uses deliverable_qty.
                    qty_t1 = float(t1_del.iloc[0]["deliverable_qty"] or 0)
                    qty_t2_t6 = t2_t6_del["deliverable_qty"].dropna().astype(float).tolist()
                    
                    if qty_t2_t6:
                        avg_5d = np.mean(qty_t2_t6)
                        if avg_5d > 0:
                            delivery_spike_pct = ((qty_t1 - avg_5d) / avg_5d) * 100.0

        # Check corporate announcements
        has_corp = 0
        corp_title = None
        reasons_corp = []
        if symbol in corp_announcements:
            has_corp = 1
            events = corp_announcements[symbol]
            corp_title = events[0]["title"]
            reasons_corp = [e["title"] for e in events]
            
        # Check moving average breakouts
        closes = fetch_historical_ohlcv(con, symbol, target_date, limit=200)
        breakout_tags = []
        ma_reasons = []
        
        if len(closes) >= 200 and snap["iep"]:
            closes_rev = closes[::-1] # order chronologically
            sma20 = np.mean(closes_rev[-20:])
            sma50 = np.mean(closes_rev[-50:])
            sma200 = np.mean(closes_rev[-200:])
            
            prev_close = snap["prev_close"] or closes[0]
            iep = snap["iep"]
            
            # Check crosses
            if prev_close <= sma20 and iep > sma20:
                breakout_tags.append("SMA20 Breakout")
                ma_reasons.append(f"Price crossed above 20 DMA ({sma20:.2f})")
            if prev_close <= sma50 and iep > sma50:
                breakout_tags.append("SMA50 Breakout")
                ma_reasons.append(f"Price crossed above 50 DMA ({sma50:.2f})")
            if prev_close <= sma200 and iep > sma200:
                breakout_tags.append("SMA200 Breakout")
                ma_reasons.append(f"Price crossed above 200 DMA ({sma200:.2f})")
                
            # Trend context
            if sma20 > sma50:
                breakout_tags.append("Short-term Bullish")
            if sma50 > sma200:
                breakout_tags.append("Long-term Bullish")
            if prev_close > sma200:
                breakout_tags.append("Above 200 DMA")
                
        # Calculate combined score
        score = 0.0
        
        # Preopen Imbalance (Max 25 pts)
        if imbalance > 0.40:
            score += 25
        elif imbalance > 0.20:
            score += 15
        elif imbalance > 0.0:
            score += 5
            
        # Opening Gap (Max 25 pts)
        if iep_gap > 2.0:
            score += 25
        elif iep_gap > 1.0:
            score += 15
        elif iep_gap > 0.5:
            score += 10
            
        # Delivery Spike (Max 25 pts)
        if delivery_spike_pct > 100.0:
            score += 25
        elif delivery_spike_pct > 50.0:
            score += 20
        elif delivery_spike_pct > 30.0:
            score += 15
        elif delivery_spike_pct > 0.0:
            score += 5
            
        # Corporate actions (Max 15 pts)
        if has_corp:
            score += 15
            
        # Breakouts (Max 10 pts)
        if any("Breakout" in tag for tag in breakout_tags):
            score += 10
        elif "Above 200 DMA" in breakout_tags:
            score += 5

        # We keep candidates that score reasonably well, or have strong imbalance + gap
        if score >= 35 or (imbalance > 0.30 and iep_gap > 1.0):
            reasons = []
            if imbalance > 0.0:
                reasons.append(f"Order book skewed buy heavy ({imbalance:+.2f})")
            if iep_gap > 0.0:
                reasons.append(f"Opening gap-up of {iep_gap:+.2f}%")
            if delivery_spike_pct > 0.0:
                reasons.append(f"Delivery volume spiked by {delivery_spike_pct:+.1f}% vs 5-day average")
            reasons.extend(reasons_corp)
            reasons.extend(ma_reasons)
            
            candidates.append({
                "symbol": symbol,
                "date": target_date,
                "score": float(score),
                "iep_gap_pct": float(iep_gap) if iep_gap is not None else None,
                "preopen_imbalance": float(imbalance) if imbalance is not None else None,
                "delivery_spike_pct": float(delivery_spike_pct) if delivery_spike_pct is not None else 0.0,
                "has_corporate_action": int(has_corp),
                "corporate_action_title": corp_title,
                "breakout_signals": ",".join(breakout_tags),
                "reasons_json": json.dumps(reasons)
            })
            
    # Sort candidates by score descending
    candidates.sort(key=lambda x: x["score"], reverse=True)
    
    # Save to database
    if candidates:
        cur = con.cursor()
        for c in candidates:
            cur.execute(translate("""
                INSERT INTO early_hours_predictions
                    (symbol, date, score, iep_gap_pct, preopen_imbalance, delivery_spike_pct,
                     has_corporate_action, corporate_action_title, breakout_signals, reasons_json, computed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(symbol, date) DO UPDATE SET
                    score = excluded.score,
                    iep_gap_pct = excluded.iep_gap_pct,
                    preopen_imbalance = excluded.preopen_imbalance,
                    delivery_spike_pct = excluded.delivery_spike_pct,
                    has_corporate_action = excluded.has_corporate_action,
                    corporate_action_title = excluded.corporate_action_title,
                    breakout_signals = excluded.breakout_signals,
                    reasons_json = excluded.reasons_json,
                    computed_at = CURRENT_TIMESTAMP
            """), [
                c["symbol"], c["date"], c["score"], c["iep_gap_pct"], c["preopen_imbalance"],
                c["delivery_spike_pct"], c["has_corporate_action"], c["corporate_action_title"],
                c["breakout_signals"], c["reasons_json"]
            ])
        con.commit()
        log.info("Saved %d candidates for date %s", len(candidates), target_date)
    else:
        log.info("No candidates qualified for date %s", target_date)
        
    con.close()
    return candidates


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Predict early hours breakout candidates.")
    parser.add_argument("--date", type=str, help="Target prediction date (YYYY-MM-DD)")
    args = parser.parse_args()
    
    res = run_predictor(args.date)
    print(f"\n--- Flagged candidates ({len(res)}) ---")
    for idx, c in enumerate(res[:15]):
        print(f"{idx+1}. {c['symbol']} - Score: {c['score']:.0f} | Gap: {c['iep_gap_pct']:.2f}% | Imbalance: {c['preopen_imbalance']:.2f} | Del Spike: {c['delivery_spike_pct']:.1f}%")
        print(f"   Signals: {c['breakout_signals']}")
        print(f"   Reasons: {json.loads(c['reasons_json'])}")
        print()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
