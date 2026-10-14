import numpy as np
import pandas as pd

from bharat_alpha.modeling import registry
from bharat_alpha.learning.adapt import aci_alpha, hedge_weights
from bharat_alpha.modeling.cv import walk_forward_folds
from bharat_alpha.modeling.gate import evaluate_gate
from bharat_alpha.modeling.registry import _evaluate_registry_gate


def test_hedge_moves_weight_away_from_a_member_that_keeps_being_wrong():
    ic = pd.DataFrame({"good": np.full(60, 0.08), "bad": np.full(60, -0.05), "flat": np.zeros(60)})
    w = hedge_weights(ic, eta=2.0, shrink=0.1, horizon=5)
    assert w["good"] > w["flat"] > w["bad"]
    assert w["bad"] >= 0.1 / 3 - 1e-12            # shrinkage floor: never zeroed by one streak
    assert abs(sum(w.values()) - 1) < 1e-12


def test_aci_tightens_when_over_covering_and_widens_when_missing():
    target = 0.8
    assert aci_alpha(pd.Series([1.0] * 50), target, 0.01) > 1 - target      # always covered -> narrower
    assert aci_alpha(pd.Series([0.5] * 50), target, 0.01) < 1 - target      # missing -> wider


def test_walk_forward_folds_purge_label_overlap():
    dates = pd.bdate_range("2022-01-03", periods=400)
    h = 21
    for f in walk_forward_folds(dates, 4, h, 150):
        last_train = dates.get_loc(f.train.max())
        first_test = dates.get_loc(f.test.min())
        assert last_train + 1 + h <= first_test          # every training label realised before the test block
        assert f.train.max() < f.test.min()


def _report(ic=0.06, t=4.0, eff=40.0, net=0.004, net_t=2.5, median_beater=False, same_day=0.05):
    return {"ensemble": {"eff_dates": eff, "mean_ic": ic, "t_nw": t, "median_beater": median_beater,
                         "topk_exc_mean": 0.003, "topk_exc_median": 0.004},
            "backtest": {"mean_net_excess": net, "t_net_excess": net_t, "n_periods": 40, "avg_turnover": 0.3},
            "corr_score_same_day_return": same_day, "config_hash": "a",
            "backtest_periods": {f"2024-01-{i:02d}": 0.004 + 0.001 * (i % 3) for i in range(1, 29)},
            "benchmark": {"factor": "mom_12_1",
                          "backtest_periods": {f"2024-01-{i:02d}": 0.0 for i in range(1, 29)}}}


def test_gate_passes_only_when_every_bar_is_cleared():
    assert evaluate_gate(_report()).passed
    assert "effective_dates" in evaluate_gate(_report(eff=12)).failures              # LOW-DATA never passes
    assert "net_excess_significant" in evaluate_gate(_report(net=-0.001)).failures   # IC without money fails
    assert "not_median_beater" in evaluate_gate(_report(median_beater=True)).failures
    assert "plausible_ic" in evaluate_gate(_report(ic=0.45)).failures                # leak tell
    assert "no_same_day_tracking" in evaluate_gate(_report(same_day=0.6)).failures


def test_gate_paired_test_against_a_different_champion():
    champ = _report()
    champ["config_hash"] = "b"
    worse = _report()
    worse["backtest_periods"] = {k: v - 0.002 for k, v in champ["backtest_periods"].items()}
    assert "vs_champion" in evaluate_gate(worse, champ).failures
    refresh = _report()
    champ_same = _report()
    assert evaluate_gate(refresh, champ_same).checks["vs_champion"]["mode"].startswith("refresh")


def test_registry_gate_uses_absolute_bars_only_when_incumbent_cannot_load():
    candidate = {"model_id": "new", "artifact_path": "new.joblib", "cv_report": _report()}
    incumbent_report = _report()
    incumbent_report["config_hash"] = "old-config"
    incumbent = {"model_id": "old", "artifact_path": "old.joblib", "cv_report": incumbent_report}

    def loader(path):
        if path == "old.joblib":
            raise RuntimeError("model artifact has no runtime manifest")
        return object()

    verdict = _evaluate_registry_gate(candidate, incumbent, loader=loader)

    assert verdict.passed
    assert "vs_champion" not in verdict.checks
    assert verdict.checks["incumbent_runtime_failover"] == {
        "ok": True,
        "mode": "absolute-gates-only",
        "incumbent_model_id": "old",
        "reason": "model artifact has no runtime manifest",
    }


def test_registry_gate_keeps_paired_bar_for_a_loadable_incumbent():
    candidate_report = _report()
    candidate_report["config_hash"] = "new-config"
    candidate = {"model_id": "new", "artifact_path": "new.joblib", "cv_report": candidate_report}
    incumbent_report = _report()
    incumbent_report["config_hash"] = "old-config"
    incumbent = {"model_id": "old", "artifact_path": "old.joblib", "cv_report": incumbent_report}

    verdict = _evaluate_registry_gate(candidate, incumbent, loader=lambda _path: object())

    assert not verdict.passed
    assert "vs_champion" in verdict.failures
    assert "incumbent_runtime_failover" not in verdict.checks


def test_decide_is_idempotent_for_an_existing_champion(monkeypatch):
    stored = {"passed": True, "checks": {"incumbent_runtime_failover": {
        "ok": True, "mode": "absolute-gates-only", "reason": "legacy artifact",
    }}}
    monkeypatch.setattr(registry, "model_row", lambda _conn, _model_id: {
        "model_id": "already-live", "horizon": 1, "status": "champion", "gate_report": stored,
    })
    monkeypatch.setattr(
        registry,
        "champion",
        lambda *_args: (_ for _ in ()).throw(AssertionError("must not compare champion to itself")),
    )

    verdict = registry.decide(object(), "already-live")

    assert verdict.passed
    assert verdict.checks == stored["checks"]
