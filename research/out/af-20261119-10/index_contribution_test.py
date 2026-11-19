"""Pre-registered Test B (docs/audits/2026-11-19-oi-and-index-contribution-preregistration.md, AF-20261119-10).

Validation (net_contri vs NIFTY 50 point change), test 1 (R5 -> next 5-session NIFTY 50 return), and with
--conditioner test 2 (5-session reversal IC split by R5 vs its trailing-252 median; heavy read, run outside
09:00-16:00 and 18:50-00:30 IST).

    python research/out/af-20261119-10/index_contribution_test.py <index_contribution.csv> [--conditioner]
"""
import sys

import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr

sys.path.insert(0, "src/server")
import db_compat  # noqa: E402

BAR = 2.58
csv_path = sys.argv[1]
cond = "--conditioner" in sys.argv

ic = pd.read_csv(csv_path, dtype={"date": str})
ic = ic[ic["index_id"] == 9].copy()
for c in ("positive_contri", "negative_contri", "net_contri"):
    ic[c] = ic[c].astype(float)
ic = ic.drop_duplicates("date").set_index("date").sort_index()

conn = db_compat.connect()
conn.execute("SET statement_timeout = '300s'")
nifty = pd.DataFrame(conn.execute(
    "SELECT date::text, open, close FROM stock_ohlcv WHERE symbol = 'NIFTY50' AND date >= '2023-09-01' ORDER BY 1"
).fetchall(), columns=["date", "open", "close"]).astype({"open": float, "close": float}).set_index("date")
nifty["chg"] = nifty["close"].diff()

m = ic.join(nifty, how="inner").dropna(subset=["chg"])
r, _ = pearsonr(m["net_contri"], m["chg"])
print(f"validation: {len(m)} sessions {m.index.min()}..{m.index.max()}, Pearson(net_contri, NIFTY50 point change) = {r:.4f}")
if r < 0.95:
    sys.exit("STOP: net_contri does not track NIFTY 50; series is not what it claims (pre-registered stop)")

ic["R"] = 1 - (ic["positive_contri"] + ic["negative_contri"]).abs() / (ic["positive_contri"] + ic["negative_contri"].abs())
ic["R5"] = ic["R"].rolling(5).mean()

# Test 1: NIFTY 50 log return t+1 open -> t+5 close on standardised R5, non-overlapping periods.
d = ic[["R5"]].join(nifty[["open", "close"]], how="inner")
d["fwd"] = np.log(d["close"].shift(-5) / d["open"].shift(-1))
p = d.dropna().iloc[::5]
z = (p["R5"] - p["R5"].mean()) / p["R5"].std(ddof=1)
X = np.column_stack([np.ones(len(z)), z])
beta, *_ = np.linalg.lstsq(X, p["fwd"].to_numpy(), rcond=None)
resid = p["fwd"].to_numpy() - X @ beta
se = np.sqrt(resid @ resid / (len(z) - 2) / ((z - z.mean()) ** 2).sum())
t1 = beta[1] / se
print(f"test 1: periods={len(p)}, beta per 1 sd R5 = {beta[1] * 1e4:.1f} bps/5 sessions, t = {t1:.2f}, "
      f"{'PASS' if abs(t1) >= BAR else 'FAIL'} (bar {BAR})")

if not cond:
    sys.exit(0)

# Test 2: 5-session reversal IC per period, split by R5 above / below its trailing-252 median (past data only).
px = pd.DataFrame(conn.execute(
    "SELECT symbol, date::text AS date, open, close, volume, COALESCE(is_suspect, 0) AS sus FROM stock_ohlcv "
    "WHERE date BETWEEN '2023-09-01' AND CURRENT_DATE AND symbol NOT LIKE 'NIFTY%' ORDER BY symbol, date"
).fetchall(), columns=["symbol", "date", "open", "close", "volume", "sus"])
conn.close()
for c in ("open", "close", "volume"):
    px[c] = px[c].astype(float)
g = px.groupby("symbol", sort=False)
px["rev5"] = -(px["close"] / g["close"].shift(5) - 1)
px["adt_cr"] = (px["close"] * px["volume"]).groupby(px["symbol"]).transform(lambda s: s.rolling(20, min_periods=15).mean()) / 1e7
bad = px["sus"].astype(int) | g["sus"].shift(-1).fillna(1).astype(int) | g["sus"].shift(-5).fillna(1).astype(int)
px["fwd5"] = np.where(bad == 0, g["close"].shift(-5) / g["open"].shift(-1) - 1, np.nan)
px = px[px["adt_cr"] >= 1].dropna(subset=["rev5", "fwd5"])

ic["med"] = ic["R5"].shift(1).rolling(252, min_periods=252).median()
dates = [x for x in ic.dropna(subset=["med"]).index if x in set(px["date"])][::5]
rows = []
for dt in dates:
    s = px[px["date"] == dt]
    if len(s) < 50:
        continue
    y = s["fwd5"].clip(s["fwd5"].quantile(0.01), s["fwd5"].quantile(0.99))
    rows.append((dt, spearmanr(s["rev5"], y).statistic, ic.at[dt, "R5"] > ic.at[dt, "med"]))
res = pd.DataFrame(rows, columns=["date", "ic", "high_R"])
hi, lo = res.loc[res["high_R"], "ic"], res.loc[~res["high_R"], "ic"]
t2 = (hi.mean() - lo.mean()) / np.sqrt(hi.var(ddof=1) / len(hi) + lo.var(ddof=1) / len(lo))
print(f"test 2: periods high_R={len(hi)} (IC {hi.mean():+.4f}) low_R={len(lo)} (IC {lo.mean():+.4f}), "
      f"diff t = {t2:.2f}, {'PASS' if abs(t2) >= BAR else 'FAIL'} (bar {BAR})")
