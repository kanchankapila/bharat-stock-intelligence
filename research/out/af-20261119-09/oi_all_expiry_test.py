"""Pre-registered Test A (docs/audits/2026-11-19-oi-and-index-contribution-preregistration.md, AF-20261119-09).

All-expiry (matched-contract) futures OI change vs near-month OI change, per-date rank IC against next-open
forward returns. Read-only. Run outside 09:00-16:00 and 18:50-00:30 IST.

    python research/out/af-20261119-09/oi_all_expiry_test.py [--counts-only] [--start 2021-01-01] [--end 2026-11-12]
"""
import argparse
import sys
from collections import defaultdict

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

sys.path.insert(0, "src/server")
import db_compat  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--counts-only", action="store_true", help="build the panel and print its shape, no statistics")
ap.add_argument("--start", default="2021-01-01")
ap.add_argument("--end", default="2026-11-12")
a = ap.parse_args()

HS = (1, 5, 10)
BAR = 2.58
conn = db_compat.connect()
conn.execute("SET statement_timeout = '300s'")

fut = pd.DataFrame(conn.execute(
    "SELECT symbol, trade_date::text AS d, expiry::text AS e, expiry_rank AS r, open_interest AS oi "
    "FROM stock_futures_eod_history WHERE instrument = 'STK' AND trade_date BETWEEN ? AND ?",
    (a.start, a.end)).fetchall(), columns=["symbol", "d", "e", "r", "oi"])
fut["oi"] = fut["oi"].astype(float)

# Matched-contract OI change per symbol-day.
recs = []
for sym, g in fut.groupby("symbol", sort=False):
    by_day = defaultdict(dict)
    near = {}
    for d, e, r, oi in g[["d", "e", "r", "oi"]].itertuples(index=False):
        by_day[d][e] = oi
        if r == 1:
            near[d] = e
    days = sorted(by_day)
    for prev, d in zip(days, days[1:]):
        p, c = by_day[prev], by_day[d]
        common = set(p) & set(c)
        base = sum(p[e] for e in common)
        all_pct = (sum(c[e] for e in common) / base - 1) if base > 0 else np.nan
        ne = near.get(d)
        near_pct = (c[ne] / p[ne] - 1) if ne and ne == near.get(prev) and p.get(ne, 0) > 0 else np.nan
        recs.append((sym, d, all_pct, near_pct, near.get(d)))
oi = pd.DataFrame(recs, columns=["symbol", "date", "oi_pct_all", "oi_pct_near", "near_expiry"])

# Expiry week: the near-expiry session and the 4 sessions before it (calendar = sessions in the futures table).
cal = sorted(fut["d"].unique())
pos = {d: i for i, d in enumerate(cal)}
day_expiry = oi.groupby("date")["near_expiry"].agg(lambda s: s.mode().iat[0] if s.notna().any() else None)


def sessions_to_expiry(d):
    e = day_expiry.get(d)
    if not e:
        return np.nan
    j = next((pos[x] for x in cal[pos[d]:] if x >= e), None)
    return np.nan if j is None else j - pos[d]


oi["to_exp"] = oi["date"].map({d: sessions_to_expiry(d) for d in day_expiry.index})
oi["expiry_week"] = oi["to_exp"] <= 4

syms = sorted(oi["symbol"].unique())
px = pd.DataFrame(conn.execute(
    "SELECT symbol, date::text AS date, open, close, volume, COALESCE(is_suspect, 0) AS sus FROM stock_ohlcv "
    "WHERE symbol = ANY(?) AND date BETWEEN (CAST(? AS date) - 40) AND (CAST(? AS date) + 20) ORDER BY symbol, date",
    (syms, a.start, a.end)).fetchall(), columns=["symbol", "date", "open", "close", "volume", "sus"])
conn.close()
for c in ("open", "close", "volume"):
    px[c] = px[c].astype(float)
px = px.sort_values(["symbol", "date"])
gp = px.groupby("symbol", sort=False)
px["ret1"] = gp["close"].pct_change()
px["adt_cr"] = (px["close"] * px["volume"]).groupby(px["symbol"]).transform(lambda s: s.rolling(20, min_periods=15).mean()) / 1e7
for h in HS:
    entry_open = gp["open"].shift(-1)
    exit_close = gp["close"].shift(-h)
    bad = gp["sus"].shift(-1).fillna(1).astype(int) | gp["sus"].shift(-h).fillna(1).astype(int) | px["sus"].astype(int)
    px[f"fwd{h}"] = np.where(bad == 0, exit_close / entry_open - 1, np.nan)

df = oi.merge(px[["symbol", "date", "ret1", "adt_cr"] + [f"fwd{h}" for h in HS]], on=["symbol", "date"], how="inner")
df["oi_conf_all"] = df["oi_pct_all"] * np.sign(df["ret1"])
df = df[(df["adt_cr"] >= 1) & (df["oi_pct_all"].abs() <= 1)]

print(f"panel: {len(df):,} symbol-days, {df['symbol'].nunique()} symbols, {df['date'].nunique()} dates, "
      f"{df['date'].min()}..{df['date'].max()}; expiry-week share {df['expiry_week'].mean():.3f}; "
      f"oi_pct_near defined {df['oi_pct_near'].notna().mean():.3f}")
if a.counts_only:
    sys.exit(0)

FACTORS = ["oi_pct_all", "oi_pct_near", "oi_conf_all"]


def grade(sub, f, h):
    ics, spreads, dates = [], [], []
    for d, g in sub.groupby("date"):
        g = g[[f, f"fwd{h}"]].dropna()
        if len(g) < 50:
            continue
        y = g[f"fwd{h}"].clip(g[f"fwd{h}"].quantile(0.01), g[f"fwd{h}"].quantile(0.99))
        ics.append(spearmanr(g[f], y).statistic)
        q = pd.qcut(g[f].rank(method="first"), 5, labels=False)
        spreads.append(y[q == 4].mean() - y[q == 0].mean())
        dates.append(d)
    s = pd.DataFrame({"date": dates, "ic": ics, "spread": spreads}).sort_values("date")
    ind = s.iloc[::h]
    n = len(ind)
    t = ind["ic"].mean() / ind["ic"].std(ddof=1) * np.sqrt(n) if n > 2 else np.nan
    years = s.assign(y=s["date"].str[:4]).groupby("y")["ic"].mean()
    same = int((np.sign(years) == np.sign(ind["ic"].mean())).sum())
    return dict(factor=f, h=h, dates=len(s), indep=n, mean_ic=round(s["ic"].mean(), 4), t=round(t, 2),
                spread_bps=round(s["spread"].mean() * 1e4, 1), years_same_sign=f"{same}/{len(years)}",
                passes=bool(abs(t) >= BAR and same >= 4))


rows = []
for split, sub in (("all", df), ("ex_expiry_week", df[~df["expiry_week"]])):
    for f in FACTORS:
        for h in HS:
            rows.append({"split": split, **grade(sub, f, h)})
out = pd.DataFrame(rows)
pd.set_option("display.width", 200)
print(out.to_string(index=False))
out.to_csv("research/out/af-20261119-09/oi_all_expiry_results.csv", index=False)
