"""Same-condition screener pairs carrying opposite bias: how many stocks get both votes now. Read-only."""
import csv, sys
sys.path.insert(0, "src/server")
from db_compat import connect

D = "research/out/screener-intraday-bias-20261126/"
S = list(csv.DictReader(open(D + "screeners.csv", encoding="utf-8")))
tl = {x["name"].strip().lower(): x for x in S if x["source"] == "trendlyne"}
PAIRS = []
for m in ("15", "30"):
    PAIRS += [(f"{m} min relative strength index (rsi) bullish", f"overbought on both {m} min mfi and {m} min rsi", "RSI >= 80"),
              (f"oversold on both {m} min rsi and {m} min mfi" if m == "15" else "oversold on both 30 min rsi and 30 min mfi",
               f"{m} min relative strength index (rsi) bearish", "RSI <= 20"),
              (f"price crossed below {m} min bollinger band", f"{m} min bollinger band breakdown", "%B < 0")]
conn = connect()


def members(x):
    return {r["symbol"] for r in conn.execute(
        "SELECT symbol FROM trendlyne_screener_stocks WHERE screener_id=?", (x["id"],)).fetchall()}


for a, b, cond in PAIRS:
    if a not in tl or b not in tl:
        print("missing", a if a not in tl else b)
        continue
    x, y = tl[a], tl[b]
    mx, my = members(x), members(y)
    print(f"{cond:9s} {x['bias']:7s} '{x['name'][:44]}' ({len(mx)}) vs {y['bias']:7s} '{y['name'][:44]}' ({len(my)}) "
          f"-> both: {len(mx & my)}")
sizes = [int(v["members"]) for v in tl.values()]
print(f"trendlyne screeners with exactly 100 members: {sum(s == 100 for s in sizes)} of {len(sizes)}; max {max(sizes)}")
print([dict(r) for r in conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' "
                                     "AND table_name='trendlyne_screener_stocks'").fetchall()])
conn.rollback()
