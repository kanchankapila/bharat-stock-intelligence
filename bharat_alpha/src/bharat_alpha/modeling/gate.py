"""Promotion gate.

A candidate becomes champion only on out-of-fold, cost-aware evidence:
  1. enough INDEPENDENT dates (overlap-corrected) — LOW-DATA can never pass;
  2. positive rank IC, Newey-West significant;
  3. positive NET excess vs the equal-weight universe mean, significant over disjoint periods
     (the arbiter: IC is a claim about ordering, not about money);
  4. not a median-beater (beats the median name but loses to the mean);
  5. beats the momentum_12_1 benchmark on the same periods;
  6. plausibility: an IC above what this market has ever shown, or a score that tracks the
     same-day return, blocks automatic promotion as a leak tell;
  7. versus an existing champion with a DIFFERENT configuration: a paired per-period test on
     the shared periods. A same-configuration retrain (a refresh on newer data) only needs
     to clear the absolute bars.

The gate never compares self-reported CV numbers across different labels (legacy: changing
the label froze the gate forever, because CV AUC is only comparable within one target).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from bharat_alpha.config import get_settings

MAX_PLAUSIBLE_IC = 0.30
MAX_SAME_DAY_IC = 0.35


@dataclass
class GateVerdict:
    passed: bool
    checks: dict[str, dict]

    @property
    def failures(self) -> list[str]:
        return [k for k, v in self.checks.items() if not v["ok"]]

    def as_dict(self) -> dict:
        return {"passed": self.passed, "failures": self.failures, "checks": self.checks}


def _paired(a: dict[str, float], b: dict[str, float]) -> tuple[float, float, int]:
    common = sorted(set(a) & set(b))
    if len(common) < 3:
        return float("nan"), float("nan"), len(common)
    d = np.array([a[k] - b[k] for k in common])
    sd = d.std(ddof=1)
    return float(d.mean()), float(d.mean() / (sd / np.sqrt(len(d)))) if sd > 0 else float("nan"), len(common)


def evaluate_gate(report: dict, champion_report: dict | None = None) -> GateVerdict:
    s = get_settings()
    ens, bt = report["ensemble"], report["backtest"]
    c: dict[str, dict] = {}

    def check(name, ok, **detail):
        c[name] = {"ok": bool(ok), **{k: (None if isinstance(v, float) and not np.isfinite(v) else v)
                                     for k, v in detail.items()}}

    check("effective_dates", ens["eff_dates"] >= s.min_effective_dates, eff_dates=ens["eff_dates"],
          required=s.min_effective_dates)
    check("ic_significant", ens["mean_ic"] > 0 and (ens["t_nw"] or 0) >= s.promotion_min_t,
          mean_ic=ens["mean_ic"], t_nw=ens["t_nw"])
    check("net_excess_significant", (bt.get("mean_net_excess") or -1) > 0 and (bt.get("t_net_excess") or 0) >= s.promotion_min_t,
          mean_net_excess=bt.get("mean_net_excess"), t=bt.get("t_net_excess"), n_periods=bt.get("n_periods"),
          turnover=bt.get("avg_turnover"))
    check("not_median_beater", not ens["median_beater"], topk_exc_mean=ens["topk_exc_mean"],
          topk_exc_median=ens["topk_exc_median"])
    bench = report.get("benchmark")
    if bench:
        diff, t, n = _paired(report.get("backtest_periods", {}), bench.get("backtest_periods", {}))
        check("beats_benchmark", np.isfinite(diff) and diff > 0, mean_diff=diff, paired_t=t, n=n,
              benchmark=bench["factor"])
    check("plausible_ic", ens["mean_ic"] <= MAX_PLAUSIBLE_IC, mean_ic=ens["mean_ic"], max=MAX_PLAUSIBLE_IC)
    sd = report.get("corr_score_same_day_return")
    check("no_same_day_tracking", sd is None or abs(sd) <= MAX_SAME_DAY_IC, same_day_ic=sd, max=MAX_SAME_DAY_IC)
    if champion_report is not None:
        if champion_report.get("config_hash") == report.get("config_hash"):
            check("vs_champion", True, mode="refresh (same configuration, newer data)")
        else:
            diff, t, n = _paired(report.get("backtest_periods", {}), champion_report.get("backtest_periods", {}))
            check("vs_champion", np.isfinite(t) and diff > 0 and t >= s.promotion_min_paired_t,
                  mode="paired", mean_diff=diff, paired_t=t, n=n, required_t=s.promotion_min_paired_t)
    return GateVerdict(all(v["ok"] for v in c.values()), c)
