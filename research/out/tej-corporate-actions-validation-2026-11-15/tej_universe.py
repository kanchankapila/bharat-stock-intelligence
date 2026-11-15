"""Definitive test: prod close vs raw bhavcopy x TEJ's exact split/bonus factors, for every symbol whose prod
deviates from raw x our factor table. Fetches TEJ anonymously, 1 req/s, cached."""
import sys, json, os, time, numpy as np, pandas as pd, requests
S=sys.argv[1]
exec(open(f"{S}/seam_check_nse.py").read().split('per = m.groupby')[0])      # defines m (rel, bad) from prod.csv/nse_raw.csv/fac.csv
A=sorted(m[m.bad].groupby("symbol").size().loc[lambda s:s>=20].index)
print("symbols to test:",len(A),flush=True)
os.makedirs(f"{S}/tej_cache",exist_ok=True)
def get(sym):
    p=f"{S}/tej_cache/{sym}.json"
    if os.path.exists(p): return json.load(open(p))
    r=requests.get(f"https://api.tejhq.dev/v1/actions/{sym}",timeout=25); time.sleep(1.0)
    j=r.json() if r.status_code==200 else {"data":[],"http":r.status_code}
    json.dump(j,open(p,"w")); return j
def factors(j):
    seen={}
    for a in j.get("data",[]):
        if a["type"] not in("split","bonus") or pd.Timestamp(a["ex_date"])<pd.Timestamp("2020-06-01"): continue
        if a["type"]=="bonus" and a.get("ratio_num") and a.get("ratio_den"): f=a["ratio_den"]/(a["ratio_num"]+a["ratio_den"])
        elif a["type"]=="split" and a.get("face_value_from") and a.get("face_value_to"): f=a["face_value_to"]/a["face_value_from"]
        else: continue
        seen[(a["ex_date"],a["type"],a.get("ratio_num"),a.get("ratio_den"),a.get("face_value_from"),a.get("face_value_to"))]=f
    byd={}
    for (d,*_),f in seen.items(): byd[d]=byd.get(d,1.0)*f
    return sorted((pd.Timestamp(d),f) for d,f in byd.items())
rows=[]
for i,s in enumerate(A):
    try: j=get(s)
    except Exception as e: rows.append((s,"TEJ_ERROR",0,np.nan,str(e)[:40])); continue
    fs=factors(j); g=m[m.symbol==s]
    cum=np.ones(len(g))
    for ex,f in fs: cum=np.where(g.d.values<np.datetime64(ex),cum*f,cum)
    rel=g.close_prod.values/(g.close_raw.values*cum)
    ok=np.abs(rel-1)<=0.03
    rows.append((s,"PROD_MATCHES_TEJ" if ok.mean()>=0.97 else "PROD_OFF_VS_TEJ",len(g),round(float(np.median(rel)),3),f"{(~ok).sum()} bars off; tej={[(str(e.date()),round(f,4)) for e,f in fs][-3:]}"))
    if i%25==0: print(i,len(A),flush=True)
r=pd.DataFrame(rows,columns=["symbol","verdict","bars","median_prod_over_tej_truth","detail"]); r.to_csv(f"{S}/tej_universe.csv",index=False)
print(r.verdict.value_counts().to_string())
print(r[r.verdict=="PROD_OFF_VS_TEJ"].sort_values("median_prod_over_tej_truth").to_string(index=False))
