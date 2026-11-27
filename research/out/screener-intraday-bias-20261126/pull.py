"""Distinct screeners feeding intraday_ranker's membership, with their stored bias. Read-only; run from repo root."""
import csv, sys
sys.path.insert(0, "src/server")
from db_compat import connect

conn = connect()
SRC = [("trendlyne", "trendlyne_screener_stocks", "screener_id"),
       ("moneycontrol", "moneycontrol_screener_stocks", "scan_id"),
       ("etnow", "etnow_screener_stocks", "screener_id")]
rows = []
for source, table, key in SRC:
    for r in conn.execute(
            f"SELECT sc.screener_id id, sc.screener_name name, sc.category, sc.subcategory, sc.signal_bias bias, "
            f"sc.confidence, sc.investment_horizon hz, count(*) members FROM {table} ss "
            f"JOIN screener_catalog sc ON sc.screener_id=ss.{key} AND LOWER(sc.source)='{source}' "
            f"WHERE sc.investment_horizon IN ('intraday','short_term') "
            f"GROUP BY 1,2,3,4,5,6,7").fetchall():
        rows.append(dict(source=source, **dict(r)))
conn.rollback()
with open("research/out/screener-intraday-bias-20261126/screeners.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader(); w.writerows(rows)
from collections import Counter
print("screeners", len(rows), "memberships", sum(r["members"] for r in rows))
for k in ("source", "bias", "category"):
    print(k, dict(Counter(r[k] for r in rows).most_common()))
print("memberships by bias", {b: sum(r["members"] for r in rows if r["bias"] == b) for b in {r["bias"] for r in rows}})
