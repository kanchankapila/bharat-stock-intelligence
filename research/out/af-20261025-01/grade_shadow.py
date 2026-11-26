"""AF-20261025-01: grade screener_score_shadow against the live (constant) screener score. Read-only.

Rules in PREREGISTRATION.md beside this file. Run from the repo root.
"""
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, "src/server")
from db_compat import connect  # noqa: E402

START = "2026-10-29"
COST_ROUND_TRIP = 0.30  # percent, 15 bps a side

conn = connect()
conn.execute("SET statement_timeout = '120s'")


def frame(sql, params):
    return pd.DataFrame([dict(r) for r in conn.execute(sql, params).fetchall()])


t0 = time.time()
h = frame("SELECT symbol, computed_at, cycle_at, breakout_score, screener_score, screener_score_shadow "
          "FROM intraday_recommendations_history WHERE computed_at >= ? AND screener_score_shadow IS NOT NULL",
          (START,))
b = frame("SELECT symbol, datetime, open, close FROM intraday_ohlcv WHERE interval='15m' AND datetime >= ?",
          (START,))
conn.rollback()
print(f"read {len(h):,} history rows, {len(b):,} bars in {time.time() - t0:.0f}s")

h["t"] = pd.to_datetime(h["cycle_at"], format="ISO8601").dt.tz_localize("UTC").astype("datetime64[ns, UTC]")
b["t"] = pd.to_datetime(b["datetime"], utc=True).astype("datetime64[ns, UTC]")
b["day"] = b["t"].dt.tz_convert("Asia/Kolkata").dt.strftime("%Y-%m-%d")
b = b.sort_values("t")
exit_close = b.groupby(["symbol", "day"])["close"].last().rename("exit")

m = pd.merge_asof(h.sort_values("t"), b[["symbol", "day", "t", "open"]].rename(columns={"t": "bar_t", "day": "bar_day"}),
                  left_on="t", right_on="bar_t", by="symbol", direction="forward", allow_exact_matches=False)
m = m[(m["bar_day"] == m["computed_at"]) & (m["open"] > 0)].join(exit_close, on=["symbol", "computed_at"])
assert (m["bar_t"] > m["t"]).all(), "entry bar must start after the signal"
m["ret"] = (m["exit"] / m["open"] - 1) * 100
m = m[np.isfinite(m["ret"])].copy()
print(f"graded rows {len(m):,}; dropped {len(h) - len(m):,}; |ret|>20%: {(m['ret'].abs() > 20).sum()}")
m["ret"] = m["ret"].clip(-20, 20)


def blend(d, wb, ws, scr):
    parts = d[["breakout_score", scr]].to_numpy(float)
    w = np.where(np.isfinite(parts), np.array([wb, ws]), 0.0)
    return np.nansum(np.nan_to_num(parts) * w, axis=1) / w.sum(axis=1)


arms = {"alone": m["screener_score_shadow"].to_numpy(float)}
for tag, wb, ws in [("", 0.503, 0.497), ("_const", 0.20, 0.40)]:
    arms["live" + tag] = blend(m, wb, ws, "screener_score")
    arms["shadow" + tag] = blend(m, wb, ws, "screener_score_shadow")
for k, v in arms.items():
    m[k] = v

rows = []
for (day, _), g in m.groupby(["computed_at", "cycle_at"]):
    if len(g) < 50:
        continue
    rr = g["ret"].rank()
    mean = g["ret"].mean()
    for arm in arms:
        s = g[arm]
        if s.nunique() < 2:
            continue
        n = max(1, len(g) // 10)
        top = g.loc[s.sort_values(ascending=False, kind="mergesort").index[:n], "ret"].mean()
        rows.append((day, arm, s.rank().corr(rr), top - mean, top))
daily = pd.DataFrame(rows, columns=["day", "arm", "ic", "top_excess", "top_gross"]).groupby(["arm", "day"]).mean()


def stat(x):
    return x.mean(), x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))


for arm in arms:
    d = daily.loc[arm]
    ic, t = stat(d["ic"])
    print(f"{arm:13s} days {len(d):2d}  IC {ic:+.4f} (t {t:+.2f}, {int((d['ic'] > 0).sum())} positive)  "
          f"top-decile excess {d['top_excess'].mean():+.3f}%  gross {d['top_gross'].mean():+.3f}%  "
          f"net {d['top_gross'].mean() - COST_ROUND_TRIP:+.3f}%")
for tag in ["", "_const"]:
    diff = (daily.loc["shadow" + tag]["ic"] - daily.loc["live" + tag]["ic"]).dropna().sort_index()
    mean, t = stat(diff)
    half = len(diff) // 2
    print(f"shadow-live{tag:7s} days {len(diff)}  IC diff {mean:+.4f} (t {t:+.2f}, better {int((diff > 0).sum())})  "
          f"halves {diff.iloc[:half].mean():+.4f} / {diff.iloc[half:].mean():+.4f}  top-excess diff "
          f"{(daily.loc['shadow' + tag]['top_excess'] - daily.loc['live' + tag]['top_excess']).mean():+.3f}%")
daily.to_csv("research/out/af-20261025-01/daily.csv")

# POST-RESULT diagnostic (not pre-registered): is the gain only dilution of the breakout ranking?
# Shuffle the shadow score within each cycle: same distribution, no information.
if "--placebo" in sys.argv:
    live_ic = daily.loc["live"]["ic"]
    out, dailies = [], []
    for seed in range(5):
        rng = np.random.default_rng(seed)
        m["scr_p"] = m.groupby(["computed_at", "cycle_at"])["screener_score_shadow"].transform(
            lambda s: rng.permutation(s.to_numpy()))
        m["placebo"] = blend(m, 0.503, 0.497, "scr_p")
        ics = [(day, g["placebo"].rank().corr(g["ret"].rank()))
               for (day, _), g in m.groupby(["computed_at", "cycle_at"]) if len(g) >= 50]
        d = pd.DataFrame(ics, columns=["day", "ic"]).groupby("day")["ic"].mean()
        dailies.append(d)
        out.append((d - live_ic).mean())
        print(f"placebo seed {seed}: IC {d.mean():+.4f}  minus live {out[-1]:+.4f}")
    real = (daily.loc["shadow"]["ic"] - live_ic).mean()
    print(f"placebo mean diff {np.mean(out):+.4f} vs real shadow diff {real:+.4f}")

    mean, tstat = stat((daily.loc['shadow']['ic'] - sum(dailies) / len(dailies)).dropna())
    print(f'shadow minus placebo, paired by day: {mean:+.4f} (t {tstat:+.2f})')
