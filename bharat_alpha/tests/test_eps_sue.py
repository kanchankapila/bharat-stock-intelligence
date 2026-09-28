import datetime as dt

import numpy as np
import pytest

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def _eps_rows(iid: int, first_quarter_end: dt.date, values: list[float]) -> list[dict]:
    """One reported-EPS fact per quarter, each knowable a month after the quarter it covers."""
    from bharat_alpha.ingest.sources.nse_results import SOURCE

    rows = []
    for i, v in enumerate(values):
        pe = first_quarter_end + dt.timedelta(days=91 * i)
        rows.append({"source": SOURCE, "instrument_id": iid, "field": "res_eps", "period_end": pe, "value": v,
                     "knowable_at": dt.datetime.combine(pe + dt.timedelta(days=30), dt.time(18, 0), tzinfo=IST)})
    return rows


def test_sue_divides_the_surprise_by_the_stock_s_own_earnings_volatility(conn):
    """Two stocks print the same +10 year-on-year EPS jump. For the volatile earner that is
    ordinary; for the steady one it is a shock. The raw change cannot tell them apart."""
    from bharat_alpha.db import read_df, upsert
    from bharat_alpha.features import results_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=8, n_days=760, seed=17)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    ids = {s: int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (s,)).iloc[0, 0])
           for s in ("SIM005", "SIM006")}
    q0 = sim.dates[0] + dt.timedelta(days=20)
    # year 1-2 set each stock's own history; the last quarter is the same +10 jump for both
    steady = [10, 10, 10, 10, 8, 12, 8, 12, 6, 14, 6, 22]              # prior surprises ±2
    volatile = [30, 30, 30, 30, 10, 50, 10, 50, -10, 70, -10, 60]       # prior surprises ±20
    rows = _eps_rows(ids["SIM005"], q0, steady) + _eps_rows(ids["SIM006"], q0, volatile)
    assert upsert(conn, "alpha.fundamental", rows,
                  key=("source", "instrument_id", "field", "knowable_at"), update=()) == len(rows)
    conn.commit()

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    f = results_features(conn, p)
    last = str(sim.dates[-1])
    sue_steady, sue_vol = f["res_eps_sue"][ids["SIM005"]].loc[last], f["res_eps_sue"][ids["SIM006"]].loc[last]
    raw_steady = f["res_eps_yoy_px"][ids["SIM005"]].loc[last] * p.raw_close[ids["SIM005"]].loc[last]
    raw_vol = f["res_eps_yoy_px"][ids["SIM006"]].loc[last] * p.raw_close[ids["SIM006"]].loc[last]

    assert raw_steady == pytest.approx(10.0) and raw_vol == pytest.approx(10.0)   # identical raw surprise
    assert sue_steady > 4 * sue_vol and sue_vol > 0                                # SUE tells them apart
    # the dispersion is the stock's own earlier surprises, nothing else
    prior_steady = [s - b for s, b in zip(steady[4:11], steady[0:7])]
    assert sue_steady == pytest.approx(10.0 / np.std(prior_steady, ddof=1))


def test_sue_is_fixed_when_it_is_published_and_needs_a_history_first(conn):
    """A quarter's SUE must not move when later quarters arrive: its dispersion may only use
    surprises already known. And a stock with too few prior surprises has none at all."""
    from bharat_alpha.db import read_df, upsert
    from bharat_alpha.features import SUE_MIN_PRIOR, results_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=8, n_days=760, seed=19)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM005'").iloc[0, 0])
    q0 = sim.dates[0] + dt.timedelta(days=20)
    history = [10, 12, 9, 13, 14, 15, 12, 17, 18, 20, 16, 25]
    key, upd = ("source", "instrument_id", "field", "knowable_at"), ()
    upsert(conn, "alpha.fundamental", _eps_rows(iid, q0, history), key=key, update=upd)
    conn.commit()
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    early = results_features(conn, p)["res_eps_sue"][iid]
    published = early.dropna()
    # one surprise per quarter after the first year; the first SUE_MIN_PRIOR of them carry no SUE
    n_surprises = len(history) - 4
    assert published.groupby(published).ngroups == n_surprises - SUE_MIN_PRIOR > 0

    # a huge later quarter must not rewrite what was known before it
    upsert(conn, "alpha.fundamental", _eps_rows(iid, q0, history + [500.0])[-1:], key=key, update=upd)
    conn.commit()
    after = results_features(conn, p)["res_eps_sue"][iid]
    assert after.loc[published.index].equals(published)
