"""AF-20261126-11 replay: screener_momentum_score with and without the bias pins. Read-only; run once from repo root.

Rules: docs/audits/2026-11-26-screener-bias-pins-preregistration.md.
"""
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, "scripts")
sys.path.insert(0, "src/server")
import screener_membership_replay as R  # noqa: E402
import screener_features_fetcher as F  # noqa: E402
from db_compat import connect  # noqa: E402
from screener_bias_pins import pinned_bias  # noqa: E402

SINCE, UNTIL, COST = dt.date(2026, 9, 1), dt.date(2026, 11, 19), 0.32
OUT = Path("research/out/screener-intraday-bias-20261126/replay_result.json")
SIGNAL = {"bullish": 2.0, "neutral": 1.0, "bearish": 0.0}
if OUT.exists():
    raise SystemExit("result exists; it is immutable")

production_name_signal = F._name_to_signal


def pinned_name_signal(name):
    pin = pinned_bias(name)
    return SIGNAL[pin] if pin else production_name_signal(name)


con = connect()
con.execute("SET TRANSACTION READ ONLY")
con.execute("SET LOCAL statement_timeout = '600s'")
ep = R.drop_shared(R.load_episodes(con, SINCE), R.shared_screener_ids(con))
ep = R.attach_last_seen(ep, R.load_last_seen(con))
px = pd.DataFrame([tuple(r) for r in con.execute(
    "SELECT symbol, date::date AS date, open, close, volume FROM stock_ohlcv WHERE date >= ? "
    "AND COALESCE(is_suspect,0)=0 AND open>0 AND close>0",
    ((SINCE - dt.timedelta(days=60)).isoformat(),)).fetchall()], columns=["symbol", "date", "open", "close", "volume"])
px["date"] = pd.to_datetime(px["date"]).dt.date
px = px.sort_values(["symbol", "date"])
px["adt"] = (px["close"] * px["volume"]).groupby(px["symbol"]).transform(
    lambda x: x.rolling(20, min_periods=20).mean()) / 1e7
sessions = sorted(px["date"].unique())
bars = px.set_index(["symbol", "date"])

daily = {"old_arm": [], "new_arm": []}
for i, day in enumerate(sessions[:-1]):
    if not SINCE <= day <= UNTIL:
        continue
    entry = sessions[i + 1]
    meta = F.load_screener_meta(con, as_of=day.isoformat())
    after_meta = {k: ({**m, "sentiment": pinned_bias(m["name"])} if pinned_bias(m["name"]) else m)
                  for k, m in meta.items()}
    adt = px[px["date"] <= day].groupby("symbol").last()["adt"].to_dict()
    for arm in daily:
        members = getattr(R, arm)(ep, day)
        F._name_to_signal = production_name_signal
        before = R.features(members, meta, F.compute_features)
        F._name_to_signal = pinned_name_signal
        after = R.features(members, after_meta, F.compute_features)
        F._name_to_signal = production_name_signal
        ret = {}
        for s in before.index:
            if adt.get(s, 0) >= 1 and (s, entry) in bars.index:
                b = bars.loc[(s, entry)]
                r = (b["close"] / b["open"] - 1) * 100
                if np.isfinite(r) and abs(r) <= 40:
                    ret[s] = r
        if len(ret) < 50:
            continue
        p = pd.DataFrame({"ret": ret, "before": before["screener_momentum_score"],
                          "after": after["screener_momentum_score"]}).dropna()
        rec = {"date": str(day), "symbols": len(p), "changed": int((p["before"] != p["after"]).sum())}
        for k in ("before", "after"):
            rec[k + "_ic"] = float(p[k].corr(p["ret"], method="spearman"))
            rec[k + "_top50_net"] = float(p.nlargest(50, k)["ret"].mean() - p["ret"].mean() - COST)
        daily[arm].append(rec)
    print(day, flush=True)
con.rollback()

report = {}
for arm, rows in daily.items():
    d = [r["after_ic"] - r["before_ic"] for r in rows]
    h = len(d) // 2
    report[arm] = {"dates": len(rows), "ic_delta": R.paired_stats(d), "first_half": R.paired_stats(d[:h]),
                   "second_half": R.paired_stats(d[h:]),
                   "net_delta": R.paired_stats([r["after_top50_net"] - r["before_top50_net"] for r in rows]),
                   "before_ic": R.paired_stats([r["before_ic"] for r in rows]),
                   "after_ic": R.paired_stats([r["after_ic"] for r in rows]),
                   "mean_symbols_changed": float(np.mean([r["changed"] for r in rows])), "daily": rows}
p = report["old_arm"]
harmful = any(x["t"] is not None and x["t"] <= -2 for x in (p["first_half"], p["second_half"]))
report["verdict"] = "LOW-DATA: do not ship" if p["dates"] < 20 else ("HARMFUL: do not ship" if harmful else "SHIP")
OUT.write_text(json.dumps(report, indent=1), encoding="utf-8")
for arm in daily:
    print(arm, json.dumps({k: v for k, v in report[arm].items() if k != "daily"}))
print("VERDICT", report["verdict"])
