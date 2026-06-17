import sqlite3, json, os, sys

# Try the main DB paths
DB_CANDIDATES = [
    os.path.join(os.path.dirname(__file__), "..", "src", "server", "bharat_intelligence.db"),
    os.path.join(os.path.dirname(__file__), "..", "src", "server", "stocks.db"),
]

conn = None
for db_path in DB_CANDIDATES:
    db_path = os.path.normpath(db_path)
    try:
        c = sqlite3.connect(db_path)
        cur = c.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        if tables:
            print(f"Using DB: {db_path}")
            print(f"Tables: {tables}")
            conn = c
            break
        c.close()
    except Exception as e:
        print(f"Could not open {db_path}: {e}")

if conn is None:
    print("No populated DB found. Tables are created at server startup.")
    print("Run 'npm run dev' first, then re-run this script.")
    sys.exit(0)

cur = conn.cursor()

try:
    cur.execute("SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1")
    row = cur.fetchone()
    print("Regime:", row)
except Exception as e:
    print("Regime table error:", e)

try:
    cur.execute("""
      WITH ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY symbol ORDER BY signal_date DESC, signal_score DESC
          ) AS rn
        FROM signal_outcomes
        WHERE outcome IN ('WIN','PENDING')
          AND signal_score >= 5
          AND (signals_json LIKE '%RSI_DIVERGENCE%' OR signals_json LIKE '%EMA_BULL_STACK%')
      )
      SELECT
        r.symbol, ns.name, ns.sector,
        r.signal_score, r.entry_price, r.signals_json,
        qs.piotroski_f_score, qs.sharpe_ratio, qs.rank_composite,
        qs.bullish_screener_count, qs.return_12m,
        ur.conviction_level, ur.avg_engine_track_record,
        COALESCE(ur.stop_loss, r.entry_price * 0.95) AS stop_loss,
        COALESCE(ur.target_1,  r.entry_price * 1.12) AS target
      FROM ranked r
      JOIN quant_scores qs ON qs.symbol = r.symbol
      JOIN nse_stocks ns ON ns.symbol = r.symbol
      LEFT JOIN unified_recommendations ur
        ON ur.symbol = r.symbol
        AND ur.computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
      WHERE r.rn = 1
        AND qs.piotroski_f_score >= 7
        AND qs.above_sma200 = 1
        AND qs.sharpe_ratio > 1.0
        AND (ns.sector IN ('Financials','Healthcare','Industrials','Materials','Energy') OR ns.sector = 'Unknown' OR ns.sector IS NULL OR ns.sector = '')
      ORDER BY COALESCE(ur.avg_engine_track_record, 1.0) DESC, qs.rank_composite DESC
      LIMIT 20
    """)
    rows = cur.fetchall()
    print(f"Rows returned: {len(rows)}")
    for r in rows[:5]:
        print(r[0], r[2], "P:", r[6], "Sharpe:", round(r[7], 2) if r[7] else None)
except Exception as e:
    print("Query error:", e)

conn.close()
