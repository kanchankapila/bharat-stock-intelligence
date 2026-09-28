import datetime as dt

import numpy as np
import pandas as pd
import pytest

from bharat_alpha.db import read_df
from bharat_alpha.evaluation.compare import compare, to_wide
from bharat_alpha.features import estimate_features
from bharat_alpha.ingest.base import run_connector
from bharat_alpha.ingest.sources.mc_estimates import McEstimates, parse_estimates, write_estimates
from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
from bharat_alpha.marketdata import load_panel
from bharat_alpha.reference.provider_ids import provider_keys, singleton_map, store_provider_ids
from bharat_alpha.sim import simulate
from bharat_alpha.timeutil import IST


def _ingest(conn, sim, n=None):
    for d in sim.dates[:n]:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()


def test_ambiguous_provider_codes_are_dropped_not_guessed(conn):
    ok, amb = singleton_map([("KMF", "KOTAKBANK"), ("KMF", "MAHINDRA"), ("RI", "RELIANCE"), ("RI", "RELIANCE")])
    assert ok == {"RI": "RELIANCE"} and amb == {"KMF": {"KOTAKBANK", "MAHINDRA"}}
    sim = simulate(n_stocks=6, n_days=5, seed=1)
    _ingest(conn, sim)
    stats = store_provider_ids(conn, "moneycontrol",
                               [("A1", "SIM000"), ("B1", "SIM001"), ("B1", "SIM002"),   # ambiguous code
                                ("C1", "SIM003"), ("C2", "SIM003"),                    # two codes, one company
                                ("Z9", "NOTLISTED")], "test")
    assert stats["ambiguous_keys"] == 1 and stats["multi_key_instruments"] == 1 and stats["unknown_symbols"] == 1
    assert list(provider_keys(conn, "moneycontrol").values()) == ["A1"]


def test_parse_estimates_uses_legacy_live_shapes():
    rating = {"success": 1, "data": {"analystCount": "12", "finalRating": "Buy",
                                     "ratings": [{"name": "Strong Buy", "value": 5}, {"name": "Buy", "value": 3},
                                                 {"name": "Hold", "value": 3}, {"name": "Sell", "value": 1}]}}
    price = {"success": 1, "data": {"high": "1800", "mean": "1500", "low": 0}}
    earn = {"success": 1, "data": {"eps": [{"avg": 40, "actual": 38}, {"avg": 45, "actual": None}],
                                   "revenue": [{"avg": 0, "actual": ""}]}}
    out = parse_estimates(rating, price, earn)
    assert out == {"est_n_analysts": 12.0, "est_buy_pct": 8 / 12, "est_target_mean": 1500.0,
                   "est_target_high": 1800.0, "est_eps_next": 45.0}       # 0 = "no estimate", not a value
    assert parse_estimates({"success": 0}, None, {}) == {}


def test_estimates_stored_only_on_change_and_revisions_are_point_in_time(conn):
    sim = simulate(n_stocks=6, n_days=140, seed=2)
    _ingest(conn, sim)
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM005'").iloc[0, 0])

    def at(i):
        return dt.datetime.combine(sim.dates[i], dt.time(18, 0), tzinfo=IST)

    rows = [{"instrument_id": iid, "field": "est_eps_next", "value": 10.0, "knowable_at": at(i)} for i in (5, 6, 7)]
    rows += [{"instrument_id": iid, "field": "est_eps_next", "value": 12.0, "knowable_at": at(100)}]
    # published after the 19:00 IST cutoff: usable only from the NEXT session
    rows += [{"instrument_id": iid, "field": "est_target_mean", "value": 999.0,
              "knowable_at": dt.datetime.combine(sim.dates[120], dt.time(21, 0), tzinfo=IST)}]
    assert write_estimates(conn, "mc_estimates", rows) == 3             # unchanged repeats skipped
    conn.commit()
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    f = estimate_features(conn, p)
    rev = f["est_eps_rev"][iid]
    assert rev.loc[:str(sim.dates[99])].dropna().eq(0).all()           # no knowledge of the revision before it
    assert rev.loc[str(sim.dates[100])] == pytest.approx(0.2)           # 10 -> 12 seen on day 100
    up = f["est_target_upside"][iid]
    assert np.isnan(up.loc[str(sim.dates[120])]) and not np.isnan(up.loc[str(sim.dates[121])])


def test_estimates_connector_uses_provider_ids_via_prepare(conn):
    sim = simulate(n_stocks=6, n_days=3, seed=3)
    _ingest(conn, sim)
    store_provider_ids(conn, "moneycontrol", [("X1", "SIM000")], "test")

    class Fake(McEstimates):
        def fetch(self, client, on):
            assert [k for _, k in self.ids] == ["X1"]
            return {i: ({"success": 1, "data": {"analystCount": 3}}, None, None) for i, _ in self.ids}

    assert run_connector(conn, Fake(), sim.dates[-1], client=object()) == ("success", 1)


def test_to_wide_maps_premarket_scores_to_previous_close(conn):
    sim = simulate(n_stocks=6, n_days=5, seed=4)
    _ingest(conn, sim)
    idx = pd.DatetimeIndex(pd.to_datetime(sim.dates))
    d2 = sim.dates[2]
    w = to_wide(conn, pd.DataFrame({"date": [pd.Timestamp(d2) + pd.Timedelta(hours=7, minutes=30),
                                             pd.Timestamp(d2) + pd.Timedelta(hours=20)],
                                    "symbol": ["SIM000", "SIM001"], "score": [1.0, 2.0]}), idx)
    iid = {s: int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (s,)).iloc[0, 0])
           for s in ("SIM000", "SIM001")}
    assert w[iid["SIM000"]].dropna().index[0].date() == sim.dates[1]   # 07:30 on d2 -> decided at d1's close
    assert w[iid["SIM001"]].dropna().index[0].date() == d2             # 20:00 on d2 -> decided at d2's close


@pytest.mark.slow
def test_compare_prefers_the_ranking_that_actually_predicts(conn, monkeypatch, artifacts):
    monkeypatch.setenv("BQA_MIN_HISTORY_DAYS", "20")
    monkeypatch.setenv("BQA_TOP_K", "15")
    from bharat_alpha.config import get_settings

    get_settings.cache_clear()
    sim = simulate(n_stocks=100, n_days=420, signal_strength=2.0, seed=9)
    _ingest(conn, sim)
    rng = np.random.default_rng(0)
    decision = sim.dates[60:400]
    good = [(d, s, sim.alpha.loc[str(d), s]) for d in decision for s in sim.alpha.columns]
    noise = [(d, s, rng.normal()) for d in decision for s in sim.alpha.columns]
    a = pd.DataFrame(noise, columns=["date", "symbol", "score"])
    b = pd.DataFrame(good, columns=["date", "symbol", "score"])
    r = compare(conn, a, b, horizon=5)
    assert r["common_dates"] >= 300
    assert r["bharat_alpha"]["mean_ic"] > 0.05 > abs(r["legacy"]["mean_ic"])
    assert r["paired"]["ic_diff_t_nw"] > 3 and r["verdict"] == "bharat_alpha better"
    swapped = compare(conn, b, a, horizon=5)                          # negative control: sides swapped
    assert swapped["verdict"] == "legacy better" and swapped["paired"]["ic_diff_t_nw"] < -3
    get_settings.cache_clear()
