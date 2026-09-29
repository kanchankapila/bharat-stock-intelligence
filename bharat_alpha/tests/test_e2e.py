"""End-to-end on a synthetic market with KNOWN ground truth.

The pair of gate tests is the system's core negative control: the same code must promote a
model when a real (planted) edge exists and must refuse when returns are pure noise. A
pipeline that leaks the future passes the first and FAILS the second.
"""
import datetime as dt

import numpy as np
import pandas as pd
import pytest

from bharat_alpha.db import read_df
from bharat_alpha.features import build_features
from bharat_alpha.ingest.base import run_connector
from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
from bharat_alpha.ingest.sources.nse_corporate import NseSymbolChange
from bharat_alpha.ingest.sources.nse_market import NseFiiDii, NseIndexClose
from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars, load_panel
from bharat_alpha.modeling.dataset import build_dataset
from bharat_alpha.modeling.gate import evaluate_gate
from bharat_alpha.modeling.registry import decide
from bharat_alpha.modeling.train import train_model
from bharat_alpha.sim import simulate

pytestmark = pytest.mark.slow


@pytest.fixture()
def fast_settings(monkeypatch, artifacts):
    for k, v in dict(BQA_SEEDS="[11]", BQA_CV_FOLDS="3", BQA_TRAIN_MIN_DATES="150", BQA_HORIZONS="[5]",
                     BQA_PRIMARY_HORIZON="5", BQA_TOP_K="15", BQA_MIN_HISTORY_DAYS="20").items():
        monkeypatch.setenv(k, v)
    from bharat_alpha.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def ingest_sim(conn, sim, upto=None):
    for d in sim.dates[: upto]:
        assert run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])[0] == "success"
        run_connector(conn, NseIndexClose(), d, raw=sim.index_files[d])
        run_connector(conn, NseFiiDii(), d, raw=sim.fii_dii[d])
    run_connector(conn, NseSymbolChange(), sim.dates[-1], raw=sim.symbol_changes_csv)
    flag_suspect_bars(conn)
    derive_adjustments(conn)
    conn.commit()


@pytest.mark.parametrize("signal, should_pass", [(1.0, True), (0.0, False)])
def test_gate_finds_planted_edge_and_rejects_noise(conn, fast_settings, signal, should_pass):
    sim = simulate(n_stocks=120, n_days=520, signal_strength=signal, seed=11)
    ingest_sim(conn, sim)
    ds = build_dataset(conn, sim.dates[0], sim.dates[-1], 5)
    res = train_model(conn, ds)
    verdict = evaluate_gate(res.report)
    assert verdict.passed is should_pass, verdict.as_dict()
    ens = res.report["ensemble"]
    if should_pass:
        assert ens["mean_ic"] > 0.04 and ens["reliable"]
        assert res.report["backtest"]["t_net_excess"] > 2
        # the planted edge is visible only through delivery %: it must rank among the drivers
        imp = pd.Series(res.bundle.members[0].models[0].feature_importances_, index=res.bundle.feature_cols)
        assert any(c.startswith("deliv") for c in imp.nlargest(5).index), imp.nlargest(5)
    else:
        assert "ic_significant" in verdict.failures or "net_excess_significant" in verdict.failures


def test_features_have_train_serve_parity(conn, fast_settings):
    """The feature row the live pipeline computes for date t from a 300-session window must
    equal the row the training panel computes from full history (legacy: movement_probability
    was trained on one construction and served another)."""
    sim = simulate(n_stocks=40, n_days=420, seed=5)
    ingest_sim(conn, sim)
    t = pd.Timestamp(sim.dates[-1])
    full = build_features(conn, load_panel(conn, sim.dates[0], sim.dates[-1]), pd.DatetimeIndex([t]))
    days = read_df(conn, "SELECT trade_date FROM alpha.trading_day ORDER BY 1 DESC LIMIT 300").trade_date
    live = build_features(conn, load_panel(conn, days.min(), sim.dates[-1]), pd.DatetimeIndex([t]))
    a, b = full.data.sort_index(), live.data.reindex_like(full.data.sort_index())
    num = a.columns.drop([c for c in a.columns if c.startswith("rsi")])     # EWM warm-up differs by < 1e-6
    np.testing.assert_allclose(a[num].to_numpy(), b[num].to_numpy(), rtol=1e-6, atol=1e-6, equal_nan=True)
    np.testing.assert_allclose(a["rsi_14"].to_numpy(), b["rsi_14"].to_numpy(), atol=1e-3, equal_nan=True)


def test_live_loop_predicts_grades_adapts_and_publishes(conn, fast_settings):
    from bharat_alpha.pipeline.daily import run_daily

    # 39 live dates at h=5 is only ~8 independent windows, so the realised-IC assertion needs a
    # strong planted edge to be a real test rather than a coin flip
    sim = simulate(n_stocks=100, n_days=470, signal_strength=2.5, seed=21)
    ingest_sim(conn, sim)
    cut = 420
    ds = build_dataset(conn, sim.dates[0], sim.dates[cut], 5)
    res = train_model(conn, ds)
    assert decide(conn, res.model_id).passed
    for d in sim.dates[cut + 1: cut + 40]:
        out = run_daily(conn, d, ingest=False)
        failed = {k: v for k, v in out.items() if isinstance(v, dict) and v.get("status") == "failed"}
        assert not failed, failed
    # predictions are immutable and every resolved one is graded against realised returns
    n_pred = read_df(conn, "SELECT count(DISTINCT as_of_date) n FROM alpha.prediction").n[0]
    assert n_pred == 39
    ev = read_df(conn, "SELECT as_of_date, rank_ic FROM alpha.realized_eval WHERE member='ensemble' ORDER BY 1")
    assert len(ev) >= 30 and ev.rank_ic.mean() > 0.03
    # outcome grading matches an independent recomputation for one prediction
    o = read_df(conn, "SELECT o.*, s.symbol FROM alpha.outcome o JOIN alpha.symbol_history s USING (instrument_id) "
                      "WHERE s.valid_to IS NULL ORDER BY o.as_of_date, o.instrument_id LIMIT 1").iloc[0]
    p = load_panel(conn, o.entry_date, o.exit_date)
    raw = p.open.iloc[-1][o.instrument_id] / p.open.iloc[0][o.instrument_id] - 1
    assert o.fwd_return == pytest.approx(raw, abs=0.02)            # equal unless winsorised
    # fast loops ran with point-in-time state
    w = read_df(conn, "SELECT as_of_date, weights FROM alpha.ensemble_weight ORDER BY as_of_date")
    assert len(w) > 0 and abs(sum(w.weights.iloc[-1].values()) - 1) < 1e-9
    a = read_df(conn, "SELECT alpha_t FROM alpha.conformal_state ORDER BY as_of_date DESC LIMIT 1").alpha_t[0]
    assert 0.001 <= a <= 0.999
    # canonical output: one row per eligible instrument, validated edge, BUY list of top_k
    last = sim.dates[cut + 39]
    rec = read_df(conn, "SELECT action, edge_status FROM alpha.recommendation WHERE as_of_date=%s", (last,))
    assert (rec.action == "BUY").sum() == 15 and set(rec.edge_status) <= {"validated", "degraded"}
    # idempotent re-run: nothing duplicated, step skipped
    again = run_daily(conn, last, ingest=False)
    assert again["publish_h5"]["status"] == "skipped"
    runs = read_df(conn, "SELECT status, count(*) n FROM alpha.job_run GROUP BY 1")
    assert "failed" not in set(runs.status)
    dq = read_df(conn, "SELECT check_id, status FROM alpha.dq_result WHERE check_id LIKE 'delivery:%%'")
    assert set(dq.status) == {"pass"}
    # the API serves the canonical table together with its realised track record
    from fastapi.testclient import TestClient

    from bharat_alpha.api.app import app

    api = TestClient(app)
    body = api.get("/recommendations", params={"horizon": 5, "action": "BUY"}).json()
    assert len(body["items"]) == 15 and body["realized_track_record"]["n_dates"] >= 30
    assert body["items"][0]["rank"] == 1 and body["items"][0]["symbol"].startswith("SIM")
    assert api.get(f"/stock/{body['items'][0]['symbol']}", params={"horizon": 5}).status_code == 200
    assert api.get("/models").status_code == 200 and api.get("/health").status_code == 200

