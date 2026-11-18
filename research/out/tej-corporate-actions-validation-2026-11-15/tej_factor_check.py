"""Compare our ohlcv_adjustment_factors with TEJ's per-symbol corporate actions (anonymous, 1 req/s)."""
import json, os, sys, time
import pandas as pd
import requests

S = sys.argv[1]
cache = os.path.join(S, "tej_cache"); os.makedirs(cache, exist_ok=True)
fac = pd.read_csv(f"{S}/fac.csv", parse_dates=["ex_date"])
cls = pd.read_csv(f"{S}/factor_class_nse.csv")
syms = sorted(set(cls.symbol) | {"TRENT", "DBEIL", "E2E", "KRISHANA", "MBAPL", "ANANDRATHI", "HARDWYN", "TVSMOTOR", "SIYSIL", "LAGNAM", "CCAVENUE", "MCL"})


def tej(sym):
    p = os.path.join(cache, f"{sym}.json")
    if os.path.exists(p):
        return json.load(open(p))
    r = requests.get(f"https://api.tejhq.dev/v1/actions/{sym}", timeout=25)
    time.sleep(1.0)
    j = r.json() if r.status_code == 200 else {"status": r.status_code, "data": []}
    json.dump(j, open(p, "w"))
    return j


def implied(a):
    """Price factor for old prices implied by one TEJ action, or None if it carries no ratio."""
    if a["type"] == "bonus" and a.get("ratio_num") and a.get("ratio_den"):
        return a["ratio_den"] / (a["ratio_num"] + a["ratio_den"])
    if a["type"] == "split" and a.get("face_value_from") and a.get("face_value_to"):
        return a["face_value_to"] / a["face_value_from"]
    return None


out = []
for s in syms:
    try:
        j = tej(s)
    except Exception as e:
        out.append((s, None, None, "TEJ_ERROR", str(e)[:50])); continue
    acts = [a for a in j.get("data", []) if a["type"] in ("split", "bonus")]
    byd = {}
    for a in acts:
        byd.setdefault(a["ex_date"], {}).setdefault((a["type"], a.get("ratio_num"), a.get("ratio_den"), a.get("face_value_from"), a.get("face_value_to")), a)
    for _, f in fac[fac.symbol == s].iterrows():
        if f.ex_date < pd.Timestamp("2021-01-01"):
            continue
        near = [(d, v) for d, v in byd.items() if abs((pd.Timestamp(d) - f.ex_date).days) <= 5]
        if not near:
            out.append((s, f.ex_date.date(), f.factor, "NO_TEJ_ACTION", f.source)); continue
        fs = []
        for d, v in near:
            ims = [implied(a) for a in v.values()]
            if any(i is None for i in ims):
                fs.append(None)
            else:
                p = 1.0
                for i in ims: p *= i
                fs.append(p)
        if all(x is None for x in fs):
            out.append((s, f.ex_date.date(), f.factor, "TEJ_NO_RATIO", f.source))
        elif any(x is not None and abs(x / f.factor - 1) <= 0.02 for x in fs):
            out.append((s, f.ex_date.date(), f.factor, "MATCH", f.source))
        else:
            out.append((s, f.ex_date.date(), f.factor, "MISMATCH", f"tej={[round(x,4) for x in fs if x]} {f.source}"))
r = pd.DataFrame(out, columns=["symbol", "ex_date", "our_factor", "verdict", "detail"])
print("symbols queried:", len(syms), "| our factor rows >=2021 checked:", len(r))
print(r.verdict.value_counts().to_string())
r.to_csv(f"{S}/tej_factor_check.csv", index=False)
for v in ("MISMATCH", "NO_TEJ_ACTION", "TEJ_NO_RATIO"):
    print(f"\n--- {v}")
    print(r[r.verdict == v].head(40).to_string(index=False))
