import sqlite3, json

conn = sqlite3.connect("database.sqlite")
cur = conn.cursor()
cur.execute("""
  SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1
""")
row = cur.fetchone()
print("Regime:", row)

cur.execute("""
  WITH ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY symbol ORDER BY signal_date DESC, signal_score DESC
      ) AS rn
    FROM signal_outcomes
    WHERE outcome IN ('WIN','PENDING')
      AND signal_score >= 7
      AND signals_json LIKE '%RSI_DIVERGENCE%'
      AND signals_json LIKE '%EMA_BULL_STACK%'
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
    AND ns.sector IN ('Financials','Healthcare','Industrials','Materials','Energy')
  ORDER BY COALESCE(ur.avg_engine_track_record, 1.0) DESC, qs.rank_composite DESC
  LIMIT 20
""")
rows = cur.fetchall()
print(f"Rows returned: {len(rows)}")
for r in rows[:5]:
    print(r[0], r[2], "P:", r[6], "Sharpe:", round(r[7],2))
conn.close()
