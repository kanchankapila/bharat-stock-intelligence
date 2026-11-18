"""Parity of own-data price-analysis fields vs stored Trendlyne values (read-only measurement)."""
import sys
import numpy as np
import pandas as pd
from pandas.tseries.offsets import DateOffset

S = sys.argv[1]
AS_OF = pd.Timestamp("2026-11-11")   # rows dated 11-12 were fetched ~10:00 IST, before that close
px = pd.read_csv(f"{S}/ohlcv6y.csv", parse_dates=["d"]).sort_values(["symbol", "d"])
nifty = pd.read_csv(f"{S}/nifty.csv", parse_dates=["d"]).set_index("d")["price"].sort_index()
tl = pd.read_csv(f"{S}/tl_pa.csv").set_index("symbol")

WIN = {"1m": 1, "3m": 3, "6m": 6, "1y": 12, "3y": 36, "5y": 60}


def ret_at(series, months):
    """% return from the last close on/before AS_OF - months to the last close on/before AS_OF."""
    s = series[series.index <= AS_OF]
    if s.empty or s.index[-1] < AS_OF - pd.Timedelta(days=5):
        return np.nan
    base = s[s.index <= AS_OF - DateOffset(months=months)]
    if base.empty or base.index[-1] < AS_OF - DateOffset(months=months) - pd.Timedelta(days=7):
        return np.nan
    return (s.iloc[-1] / base.iloc[-1] - 1) * 100


own = {}
for sym, g in px.groupby("symbol"):
    if sym not in tl.index:
        continue
    c = g.set_index("d")["close"]
    row = {f"stock_ret_{k}": ret_at(c, m) for k, m in WIN.items()}
    w = g[(g.d <= AS_OF) & (g.d > AS_OF - DateOffset(months=3))]
    last = c[c.index <= AS_OF]
    if len(w) > 20 and not last.empty:
        row["dist_3m_high_pct"] = (w.high.max() / last.iloc[-1] - 1) * 100
        row["dist_3m_low_pct"] = (last.iloc[-1] / w.low.min() - 1) * 100
    own[sym] = row
own = pd.DataFrame(own).T
for k, m in WIN.items():
    own[f"nifty_ret_{k}"] = ret_at(nifty, m)
for k in ("1m", "3m", "6m"):
    own[f"alpha_nifty_{k}"] = own[f"stock_ret_{k}"] - own[f"nifty_ret_{k}"]

print(f"symbols compared: {len(own)} of {len(tl)} stored rows (as-of {AS_OF.date()})\n")
print(f"{'column':20s} {'n':>5s} {'corr':>6s} {'median|diff|':>12s} {'within 1pt':>10s} {'within 5pt':>10s}")
for col in [c for c in own.columns if c in tl.columns]:
    a = pd.to_numeric(own[col], errors="coerce")
    b = pd.to_numeric(tl.loc[own.index, col], errors="coerce")
    ok = a.notna() & b.notna()
    if ok.sum() < 10:
        print(f"{col:20s} {int(ok.sum()):5d}  (too few)")
        continue
    d = (a[ok] - b[ok]).abs()
    corr = np.corrcoef(a[ok], b[ok])[0, 1]
    print(f"{col:20s} {int(ok.sum()):5d} {corr:6.3f} {d.median():12.2f} {100*(d <= 1).mean():9.1f}% {100*(d <= 5).mean():9.1f}%")
own.to_csv(f"{S}/pa_own.csv")
