import sys, numpy as np, pandas as pd
S = sys.argv[1]
raw = pd.read_csv(f"{S}/nse_raw.csv", parse_dates=["d"]).drop_duplicates(["symbol", "d"])
prod = pd.read_csv(f"{S}/prod.csv", parse_dates=["d"]).drop_duplicates(["symbol", "d"])
fac = pd.read_csv(f"{S}/fac.csv", parse_dates=["ex_date"])
print("factor rows", len(fac), "dup (symbol,ex_date):", fac.duplicated(["symbol", "ex_date"]).sum())
fac = fac.sort_values(["symbol", "ex_date", "source"]).drop_duplicates(["symbol", "ex_date"])

m = raw.merge(prod, on=["symbol", "d"], suffixes=("_raw", "_prod"))
m = m[(m.close_raw > 0) & (m.close_prod > 0) & (m.d <= "2026-11-13")].copy()
m["cum"] = 1.0
for sym, g in fac.groupby("symbol"):
    ex = g.ex_date.values
    suf = np.append(np.cumprod(g.factor.values[::-1])[::-1], 1.0)
    idx = m.index[m.symbol == sym]
    if len(idx) == 0:
        continue
    pos = np.searchsorted(ex, m.loc[idx, "d"].values, side="right")
    m.loc[idx, "cum"] = suf[pos]
m["rel"] = m.close_prod / (m.close_raw * m.cum)
m["bad"] = (m.rel - 1).abs() > 0.03
print("shared symbols", m.symbol.nunique(), "shared rows", len(m), "bad rows", int(m.bad.sum()))
per = m.groupby("symbol").agg(n=("bad", "size"), bad=("bad", "sum"), first_bad=("d", lambda s: None))
per["bad_pct"] = (100 * per.bad / per.n).round(1)
badsyms = per[per.bad > 0].sort_values("bad", ascending=False)
print("symbols with any bad row:", len(badsyms), "| with >=20 bad rows:", int((badsyms.bad >= 20).sum()), "| >=50% bad:", int((badsyms.bad_pct >= 50).sum()))
rows = []
for sym in badsyms.index[:40]:
    g = m[(m.symbol == sym) & m.bad]
    rows.append((sym, len(g), g.d.min().date(), g.d.max().date(), round(g.rel.median(), 3)))
print(pd.DataFrame(rows, columns=["symbol", "bad_rows", "from", "to", "median_prod_over_expected"]).to_string(index=False))
badsyms.drop(columns=["first_bad"]).to_csv(f"{S}/seam_bad_symbols.csv")
