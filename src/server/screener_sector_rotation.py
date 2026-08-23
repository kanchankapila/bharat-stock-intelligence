#!/usr/bin/env python3
"""
screener_sector_rotation.py  (Tier 3H — Sector Screener Rotation)
===================================================================
Aggregates screener bullish/bearish signals by sector each day and writes to
screener_sector_rotation table. Surfaces which sectors are gathering screener
momentum and enables cross-sectional sector rotation analysis.

Table: screener_sector_rotation
  sector TEXT, date TEXT, bull_count INT, bear_count INT, net_score REAL,
  top_stocks TEXT (JSON array), stock_count INT, momentum_change REAL,
  tier1_bull_count INT, breadth_score REAL

Run daily after screener_features_fetcher.py.
"""

import json
import datetime
from collections import defaultdict
from db_compat import connect
import as_of

TODAY = datetime.date.today().isoformat()
# trading-day-exempt: reads this script's OWN output table (load_previous_sector_scores) for a
# momentum delta, not a trading-day source. No prior snapshot -> momentum_change 0, which is
# correct behaviour rather than a silent degradation.
YESTERDAY = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()


def ensure_schema(con):
    con.execute("""
        CREATE TABLE IF NOT EXISTS screener_sector_rotation (
            sector       TEXT NOT NULL,
            date         TEXT NOT NULL,
            bull_count   INTEGER DEFAULT 0,
            bear_count   INTEGER DEFAULT 0,
            net_score    REAL DEFAULT 0,
            stock_count  INTEGER DEFAULT 0,
            tier1_bull_count INTEGER DEFAULT 0,
            breadth_score    REAL DEFAULT 0,
            momentum_change  REAL,
            top_stocks   TEXT,
            PRIMARY KEY (sector, date)
        )
    """)
    con.commit()


def load_sector_screener_data(con) -> dict:
    """
    Returns sector -> {bull_count, bear_count, net_score, tier1_bull, breadth, stocks}
    Uses screener_features columns from technical_signals for today.
    Falls back to screener_appearances if features not available.
    """
    # Primary: use pre-computed screener_features on technical_signals
    # Trading days, not calendar days: technical_signals is trading-day-only, so a Monday
    # date.today()-2 window has no session and this primary read silently returns nothing,
    # falling through to the screener_appearances path below. recurring-bugs.md.
    cutoff = as_of.trading_days_back(2, con)[-1].isoformat()
    rows = con.execute("""
        SELECT ts.symbol,
               ns.sector,
               ts.screener_bull_count,
               ts.screener_bear_count,
               ts.screener_tier1_count,
               ts.screener_cat_breadth,
               ts.screener_momentum_score
        FROM technical_signals ts
        JOIN nse_stocks ns ON ns.symbol = ts.symbol
        WHERE ts.date >= ?
          AND ts.screener_bull_count IS NOT NULL
          AND ns.sector IS NOT NULL
        ORDER BY ts.date DESC
    """, (cutoff,)).fetchall()

    # Deduplicate: keep most recent row per symbol
    seen = {}
    for row in rows:
        sym = row[0]
        if sym not in seen:
            seen[sym] = row

    # Aggregate by sector
    sectors = defaultdict(lambda: {
        "bull": 0, "bear": 0, "tier1": 0, "breadth_sum": 0.0,
        "momentum": 0.0, "stocks": [], "n": 0
    })

    for sym, row in seen.items():
        sector      = row[1]
        bull        = float(row[2] or 0)
        bear        = float(row[3] or 0)
        tier1       = float(row[4] or 0)
        breadth     = float(row[5] or 0)
        momentum    = float(row[6] or 0)

        s = sectors[sector]
        s["bull"]         += bull
        s["bear"]         += bear
        s["tier1"]        += tier1
        s["breadth_sum"]  += breadth
        s["momentum"]     += momentum
        s["n"]            += 1
        if bull > bear:
            s["stocks"].append((sym, momentum))

    return dict(sectors)


def load_previous_sector_scores(con) -> dict:
    """Returns sector -> net_score from yesterday for momentum_change computation."""
    rows = con.execute("""
        SELECT sector, net_score FROM screener_sector_rotation WHERE date = ?
    """, (YESTERDAY,)).fetchall()
    return {r[0]: float(r[1] or 0) for r in rows}


def run():
    con = connect()
    try:
        ensure_schema(con)

        print(f"[SectorRotation] Computing sector screener aggregates for {TODAY}...")
        sector_data = load_sector_screener_data(con)
        prev_scores = load_previous_sector_scores(con)

        if not sector_data:
            print("[SectorRotation] No screener features in technical_signals — run screener_features_fetcher.py first")
            return

        rows_written = 0
        for sector, data in sector_data.items():
            n = data["n"]
            if n == 0:
                continue

            bull   = data["bull"]
            bear   = data["bear"]
            net    = round(bull - bear, 2)
            tier1  = data["tier1"]
            breadth = round(data["breadth_sum"] / n, 2) if n else 0
            prev_net = prev_scores.get(sector)
            momentum_change = round(net - prev_net, 2) if prev_net is not None else None

            # Top 10 stocks by momentum_score
            top_stocks = sorted(data["stocks"], key=lambda x: x[1], reverse=True)[:10]
            top_stocks_json = json.dumps([s[0] for s in top_stocks])

            con.execute("""
                INSERT INTO screener_sector_rotation
                (sector, date, bull_count, bear_count, net_score, stock_count,
                 tier1_bull_count, breadth_score, momentum_change, top_stocks)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (sector, date) DO UPDATE SET
                    bull_count       = excluded.bull_count,
                    bear_count       = excluded.bear_count,
                    net_score        = excluded.net_score,
                    stock_count      = excluded.stock_count,
                    tier1_bull_count = excluded.tier1_bull_count,
                    breadth_score    = excluded.breadth_score,
                    momentum_change  = excluded.momentum_change,
                    top_stocks       = excluded.top_stocks
            """, (
                sector, TODAY, int(bull), int(bear), net, n,
                int(tier1), breadth, momentum_change, top_stocks_json
            ))
            rows_written += 1

        con.commit()
        print(f"[SectorRotation] Written {rows_written} sector rows for {TODAY}")

        # Print top sectors
        top = sorted(sector_data.items(),
                     key=lambda x: x[1]["bull"] - x[1]["bear"], reverse=True)[:10]
        print("[SectorRotation] Top sectors by net bullish screener pressure:")
        for sector, data in top:
            net = data["bull"] - data["bear"]
            print(f"  {sector:30s}: net={net:.0f} bull={data['bull']:.0f} "
                  f"bear={data['bear']:.0f} n={data['n']}")

    finally:
        con.close()


if __name__ == "__main__":
    run()
