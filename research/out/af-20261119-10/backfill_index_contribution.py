"""Backfill Moneycontrol getAllIndexContribution, one session per call, to a CSV (no DB writes).

AF-20261119-10. fromDate must be the previous session and toDate the session; the same date twice is refused.
History reaches ~late 2023. Resumable: sessions already in the CSV are skipped.

    python research/out/af-20261119-10/backfill_index_contribution.py <out.csv> [start=2023-10-01]
"""
import csv
import os
import sys
import time

import requests

sys.path.insert(0, "src/server")
import db_compat  # noqa: E402

OUT = sys.argv[1]
START = sys.argv[2] if len(sys.argv) > 2 else "2023-10-01"
IDS = "9,23,27,6,28,49,7,53,31,113,36,136"  # the doc's verified set (NIFTY 50 = 9, NIFTY 500 = 7)
URL = "https://api.moneycontrol.com/mcapi/v1/indices/getAllIndexContribution"
H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
     "Referer": "https://www.moneycontrol.com/", "Accept": "application/json, text/plain, */*"}
FIELDS = ["date", "prev_date", "index_id", "index_name", "positive_contri", "negative_contri", "net_contri", "message"]

conn = db_compat.connect()
sessions = [str(r[0]) for r in conn.execute(
    "SELECT DISTINCT date FROM stock_ohlcv WHERE symbol = 'RELIANCE' AND date >= ? ORDER BY 1", (START,)).fetchall()]
conn.close()

done = set()
if os.path.exists(OUT):
    with open(OUT, encoding="utf-8") as f:
        done = {r["date"] for r in csv.DictReader(f)}
new = not os.path.exists(OUT)
f = open(OUT, "a", newline="", encoding="utf-8")
w = csv.DictWriter(f, FIELDS)
if new:
    w.writeheader()

ok = refused = 0
for prev, d in zip(sessions, sessions[1:]):
    if d in done:
        continue
    for attempt in range(3):
        try:
            j = requests.get(URL, params={"ex": "N", "fromDate": prev, "toDate": d, "deviceType": "W", "indexIds": IDS},
                             headers=H, timeout=25).json()
            break
        except (requests.RequestException, ValueError) as e:
            j = {"message": f"error: {e}"[:120], "data": None}
            time.sleep(5)
    rows = (j.get("data") or {}).get("list") or []
    if not rows:
        refused += 1
        w.writerow({"date": d, "prev_date": prev, "message": j.get("message", "")[:120]})
    for x in rows:
        ok += 1
        w.writerow({"date": d, "prev_date": prev, "index_id": x["indexId"], "index_name": x["index_name"],
                    "positive_contri": x["positive_contri"], "negative_contri": x["negative_contri"],
                    "net_contri": x["net_contri"], "message": ""})
    f.flush()
    time.sleep(1.0)
f.close()
print(f"sessions={len(sessions) - 1} index_rows={ok} refused_sessions={refused}")
