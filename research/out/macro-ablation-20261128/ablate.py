"""AF-20261008-22 drop-one ablation. Rules: docs/audits/2026-11-28-overdue-measurements-preregistration.md.

Run from the repo root with backend-python/venv. Read-only; writes result.json beside this file.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

sys.path.insert(0, "src/server")
import factor_edge as fe  # noqa: E402
import ml_ensemble as me  # noqa: E402
from db_compat import connect  # noqa: E402
from plan_rule_measure import summarise  # noqa: E402

SINCE, H, FIRST_TRAIN, STEP, PURGE = "2026-06-30", 5, 40, 5, 6

_read_df = me.read_df
me.read_df = lambda q, *a, **k: _read_df(
    f"SELECT * FROM ({q}) q_ WHERE q_.horizon_days = {H} AND q_.signal_date::text >= '{SINCE}'", *a, **k)

df = me.load_training_data("triple_barrier").reset_index(drop=True)
X = me.build_features(df).reset_index(drop=True).astype("float32")
assert len(X) == len(df), (len(X), len(df))
day = pd.to_datetime(df["signal_date"].astype(str)).dt.normalize()
y = df["outcome"].astype(int)

per_day_max = X.groupby(day).nunique().max()
block = [c for c in X.columns if per_day_max[c] <= 1 and X[c].nunique() > 1]
print(f"rows={len(X)} dates={day.nunique()} features={X.shape[1]} block={len(block)}: {block}", flush=True)

con = connect()
oh = fe._forward_returns(con, SINCE, [H], entry="open")[["symbol", "date", f"fwd_{H}"]]
adt = pd.DataFrame(con.execute(
    "SELECT symbol, date, avg(close * volume) OVER (PARTITION BY symbol ORDER BY date ROWS 19 PRECEDING) AS adt "
    "FROM stock_ohlcv WHERE date >= '2026-05-01' AND (is_suspect IS NULL OR is_suspect = 0)").fetchall(),
    columns=["symbol", "date", "adt"])
adt["date"] = pd.to_datetime(adt["date"])
px = oh.merge(adt, on=["symbol", "date"])
key = pd.DataFrame({"symbol": df["symbol"], "date": day}).merge(px, on=["symbol", "date"], how="left")
assert len(key) == len(X)

dates = sorted(day.unique())
pred = {"full": np.full(len(X), np.nan), "drop": np.full(len(X), np.nan)}
for i in range(FIRST_TRAIN, len(dates), STEP):
    train = day.isin(dates[: i - PURGE]).to_numpy()
    test = day.isin(dates[i: i + STEP]).to_numpy()
    for arm, cols in (("full", list(X.columns)), ("drop", [c for c in X.columns if c not in block])):
        m = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=4,
                                           min_samples_leaf=200, random_state=0)
        m.fit(X.loc[train, cols], y[train])
        pred[arm][test] = m.predict_proba(X.loc[test, cols])[:, 1]
    print(f"block from {pd.Timestamp(dates[i]).date()} done", flush=True)

out = pd.DataFrame({"date": day, "fwd": key[f"fwd_{H}"], "adt": pd.to_numeric(key["adt"]),
                    "full": pred["full"], "drop": pred["drop"]}).dropna()
out = out[out["adt"] >= 1e7]
ics = {"full": [], "drop": []}
for _, g in out.groupby("date"):
    if len(g) < 30:
        continue
    for arm in ics:
        ics[arm].append(g[arm].rank().corr(g["fwd"].rank()))
diff = [a - b for a, b in zip(ics["full"], ics["drop"])]
result = {"rows": int(len(X)), "labelled_dates": len(dates), "block_columns": block,
          "test_dates": len(diff), "graded_rows": int(len(out)),
          "ic_full": summarise(ics["full"], H), "ic_drop": summarise(ics["drop"], H),
          "full_minus_drop": summarise(diff, H),
          "note": "mean_pct is the mean rank IC x 100"}
Path(__file__).with_name("result.json").write_text(json.dumps(result, indent=2))
print(json.dumps({k: v for k, v in result.items() if k != "block_columns"}, indent=2))
