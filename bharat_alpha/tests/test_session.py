"""Next-session engine on synthetic markets with a planted (or absent) capitulation effect."""
import datetime as dt

import pandas as pd
import pytest

from bharat_alpha.db import read_df
from bharat_alpha.ingest.base import run_connector
from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
from bharat_alpha.ingest.sources.nse_preopen import NsePreopen, parse_preopen, usable_before_open
from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars, load_panel
from bharat_alpha.session import (
    capitulation, day_flags, day_level, next_session_oc, preopen_features, session_universe,
)
from bharat_alpha.sim import simulate
from bharat_alpha.timeutil import IST


@pytest.fixture()
def fast(monkeypatch, artifacts):
    for k, v in dict(BQA_SEEDS="[11]", BQA_CV_FOLDS="3", BQA_TRAIN_MIN_DATES="150").items():
        monkeypatch.setenv(k, v)
    from bharat_alpha.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _ingest(conn, sim):
    for d in sim.dates:
        assert run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])[0] == "success"
    flag_suspect_bars(conn)                     # the same quality step production runs
    derive_adjustments(conn)
    conn.commit()


def _iid(conn, sym):
    return int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (sym,)).iloc[0, 0])


PREOPEN = {"data": [
    {"metadata": {"symbol": "SIM010", "iep": "95.5", "previousClose": "100", "lastPrice": "95.5"},
     "detail": {"preOpenMarket": {"totalBuyQuantity": 3000, "totalSellQuantity": 1000, "finalQuantity": 1500}}},
    {"metadata": {"symbol": "SIM011", "iep": "-", "previousClose": "50"}, "detail": {}},     # no auction print
]}


def test_preopen_parse_and_point_in_time_use(conn):
    rows = parse_preopen(PREOPEN)
    assert len(rows) == 1 and rows[0]["iep_gap"] == pytest.approx(-0.045) and rows[0]["imbalance"] == pytest.approx(0.5)
    sim = simulate(n_stocks=20, n_days=30, seed=2)
    _ingest(conn, sim)
    d = sim.dates[20]
    early = NsePreopen(fetched_at=dt.datetime.combine(d, dt.time(9, 10), tzinfo=IST))
    assert run_connector(conn, early, d, raw=PREOPEN) == ("success", 1)
    late = NsePreopen(fetched_at=dt.datetime.combine(d, dt.time(11, 0), tzinfo=IST))
    assert run_connector(conn, late, d, raw=PREOPEN)[0] == "success"    # re-run: first capture kept
    k = read_df(conn, "SELECT knowable_at FROM alpha.preopen_snapshot").knowable_at[0]
    assert usable_before_open(k, d)
    assert not usable_before_open(dt.datetime.combine(d, dt.time(9, 20), tzinfo=IST), d)
    f = preopen_features(conn, load_panel(conn, sim.dates[0], sim.dates[-1]))
    col = f["po_iep_gap"][_iid(conn, "SIM010")]
    # session d's auction appears on the decision row d-1, and nowhere else
    assert col.dropna().index.tolist() == [pd.Timestamp(sim.dates[19])]


def _rule(conn, sim):
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    uni = session_universe(p)
    flags = day_flags(p, uni)
    return p, uni, flags, day_level(capitulation(flags), next_session_oc(p), uni, p)


def test_capitulation_flags_find_planted_events(conn):
    sim = simulate(n_stocks=100, n_days=160, seed=4, capitulations_per_day=2, capitulation_effect=0.0)
    _ingest(conn, sim)
    p, uni, flags, _ = _rule(conn, sim)
    cap = capitulation(flags)
    planted = [(d, s) for d, s in sim.events["capitulations"]]
    hit = sum(bool(cap.loc[str(d), _iid(conn, s)]) for d, s in planted)
    assert hit / len(planted) > 0.8
    assert cap.to_numpy().sum() <= len(planted) * 1.5          # few false positives from noise


@pytest.mark.parametrize("effect, validated", [(0.015, True), (0.0, False)])
def test_rule_day_level_detects_edge_and_rejects_null(conn, effect, validated):
    sim = simulate(n_stocks=100, n_days=320, seed=6, capitulations_per_day=2, capitulation_effect=effect)
    _ingest(conn, sim)
    *_, res = _rule(conn, sim)
    assert res.n_days > 200
    assert (res.t >= 2 and res.mean_net_spread > 0) is validated, res.summary()


@pytest.mark.slow
def test_session_model_learns_the_rule_and_picks_are_graded(conn, fast):
    from bharat_alpha.modeling.gate import evaluate_gate
    from bharat_alpha.session.model import build_session_dataset, train_session_model
    from bharat_alpha.session.publish import publish_session, resolve_session, session_track_record

    sim = simulate(n_stocks=100, n_days=360, seed=8, capitulations_per_day=2, capitulation_effect=0.015)
    _ingest(conn, sim)
    ds = build_session_dataset(conn, sim.dates[0], sim.dates[-1])
    model_id, rep, bundle, _ = train_session_model(conn, ds)
    ens = rep["ensemble"]
    assert ens["mean_ic"] > 0 and ens["t_nw"] > 2
    imp = pd.Series(bundle.members[0].models[0].feature_importances_, index=bundle.feature_cols)
    assert set(imp.nlargest(6).index) & {"flag_capitulation", "flag_open_eq_low", "s_open_loc", "s_gap", "flag_gap_down"}
    # the gate compares BOOKS: a diluted top-10 must beat the concentrated rule, not just be positive
    v = evaluate_gate(rep)
    rule_mean = pd.Series(rep["benchmark"]["backtest_periods"]).mean()
    model_mean = pd.Series(rep["backtest_periods"]).mean()
    assert ("beats_benchmark" in v.failures) == (model_mean <= rule_mean)

    # publish on a capitulation day, grade after the next session, check against raw bars
    d, sym = next((d, s) for d, s in sim.events["capitulations"] if d > sim.dates[300])
    i = sim.dates.index(d)
    out = publish_session(conn, d)
    assert out["capitulation_rule"] >= 1
    assert resolve_session(conn, sim.dates[i + 1]) >= 1
    row = read_df(conn, """SELECT so.oc_return FROM alpha.session_outcome so WHERE so.strategy='capitulation_rule'
                           AND so.instrument_id=%s""", (_iid(conn, sym),))
    bar = read_df(conn, "SELECT open, close FROM alpha.daily_bar WHERE instrument_id=%s AND trade_date=%s",
                  (_iid(conn, sym), sim.dates[i + 1]))
    assert row.oc_return[0] == pytest.approx(bar.close[0] / bar.open[0] - 1)
    assert session_track_record(conn, "capitulation_rule")["n_days"] == 1
