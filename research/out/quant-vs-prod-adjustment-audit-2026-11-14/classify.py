import sys, numpy as np, pandas as pd
S=sys.argv[1]
exec(open(f"{S}/seam_check.py").read().split('per = m.groupby')[0])   # reuse m with rel/bad
g=m[m.bad].groupby("symbol").agg(n=("d","size"),first=("d","min"),last=("d","max"),med=("rel","median"))
tot=m.groupby("symbol").size().rename("tot"); g=g.join(tot); g["pct"]=g.n/g.tot
g=g[g.n>=20]
fsym=fac.groupby("symbol").factor.apply(list)
def klass(r):
    f=fsym.get(r.name,[])
    sq=any(abs(r.med-x*x)/ (x*x)<0.03 for x in f if x<1)   # prod = raw*cum*f^... extra factor applied again
    one=any(abs(r.med-x)/x<0.03 for x in f) or any(abs(r.med-1/x)/(1/x)<0.03 for x in f)
    if r.name and pd.Timestamp("2025-05-05")<=r["last"]<=pd.Timestamp("2025-05-20"): return "A_ends_May2025_seam"
    if abs(r.med-1)>0.03 and one: return "B_factor_ignored_or_double(med==factor^±1)"
    return "C_other(non-integer drift/dividend-like)"
g["cls"]=g.apply(klass,axis=1)
print(g.cls.value_counts().to_string())
print("\nA: last-bad-date histogram (month):"); a=g[g.cls.str.startswith("A")]; print(a["last"].dt.strftime("%Y-%m-%d").value_counts().head(8).to_string())
print("\nA sample med:", a.med.round(3).value_counts().head(6).to_dict())
g.to_csv(f"{S}/seam_classified.csv")
