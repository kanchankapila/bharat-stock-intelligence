"""For each factor row TEJ did not confirm, test whether the RAW close actually jumps by that ratio."""
import sys, json, os
import numpy as np
import pandas as pd

S = sys.argv[1]
chk = pd.read_csv(f"{S}/tej_factor_check.csv", parse_dates=["ex_date"])
raw = pd.read_csv(f"{S}/nse_raw.csv", parse_dates=["d"])
raw = raw[raw.symbol.isin(chk.symbol.unique())].sort_values(["symbol", "d"])
raw["prev"] = raw.groupby("symbol").close.shift()
raw["r"] = raw.close / raw.prev


def tej_implied(sym, ex):
    p = os.path.join(S, "tej_cache", f"{sym}.json")
    if not os.path.exists(p):
        return None
    out = []
    byd = {}
    for a in json.load(open(p)).get("data", []):
        if a["type"] not in ("split", "bonus") or abs((pd.Timestamp(a["ex_date"]) - ex).days) > 5:
            continue
        i = None
        if a["type"] == "bonus" and a.get("ratio_num") and a.get("ratio_den"):
            i = a["ratio_den"] / (a["ratio_num"] + a["ratio_den"])
        elif a["type"] == "split" and a.get("face_value_from") and a.get("face_value_to"):
            i = a["face_value_to"] / a["face_value_from"]
        byd.setdefault((a["ex_date"], a["type"], a.get("ratio_num"), a.get("ratio_den"), a.get("face_value_from"), a.get("face_value_to")), i)
    vals = [v for v in byd.values() if v]
    return float(np.prod(vals)) if vals and len(vals) == len(byd) else None


rows = []
for _, c in chk.iterrows():
    if c.verdict == "MATCH":
        continue
    w = raw[(raw.symbol == c.symbol) & (raw.d >= c.ex_date - pd.Timedelta(days=5)) & (raw.d <= c.ex_date + pd.Timedelta(days=5)) & raw.r.notna()]
    if w.empty:
        rows.append((c.symbol, c.ex_date.date(), c.our_factor, c.verdict, None, None, "NO_RAW_BARS")); continue
    tj = tej_implied(c.symbol, c.ex_date)
    best_our = w.r.iloc[(np.log(w.r / c.our_factor)).abs().argmin()]
    ours_ok = abs(best_our / c.our_factor - 1) <= 0.12
    tej_ok = tj is not None and abs(w.r.iloc[(np.log(w.r / tj)).abs().argmin()] / tj - 1) <= 0.12
    band = 0.75 <= c.our_factor <= 1.25
    if c.verdict == "NO_TEJ_ACTION":
        v = ("CIRCUIT_BAND_ARTIFACT" if band else ("REAL_JUMP_TEJ_MISSES" if ours_ok else "SPURIOUS_NO_JUMP"))
    elif c.verdict == "TEJ_NO_RATIO":
        v = "RAW_JUMP_PRESENT" if ours_ok else "NO_JUMP_NON_EQUITY_OR_SPURIOUS"
    else:   # MISMATCH
        v = ("TEJ_RIGHT" if tej_ok and not ours_ok else "OURS_RIGHT" if ours_ok and not tej_ok else "BOTH_PLAUSIBLE" if ours_ok and tej_ok else "NEITHER")
    rows.append((c.symbol, c.ex_date.date(), c.our_factor, c.verdict, None if tj is None else round(tj, 4), round(float(best_our), 4), v))

r = pd.DataFrame(rows, columns=["symbol", "ex_date", "our_factor", "tej_verdict", "tej_factor", "raw_jump_nearest_ours", "arbiter"])
print(pd.crosstab(r.tej_verdict, r.arbiter).to_string())
r.to_csv(f"{S}/tej_raw_arbiter.csv", index=False)
for v in ("TEJ_RIGHT", "OURS_RIGHT", "BOTH_PLAUSIBLE", "NEITHER", "REAL_JUMP_TEJ_MISSES", "SPURIOUS_NO_JUMP", "NO_JUMP_NON_EQUITY_OR_SPURIOUS", "RAW_JUMP_PRESENT"):
    x = r[r.arbiter == v]
    if len(x):
        print(f"\n--- {v} ({len(x)})"); print(x.head(30).to_string(index=False))
