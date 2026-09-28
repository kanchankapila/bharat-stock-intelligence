import dataclasses
import datetime as dt

import numpy as np
import pandas as pd
import pytest


def test_ear_is_abnormal_reaction_usable_from_day_plus_one(conn):
    from bharat_alpha.db import read_df, upsert
    from bharat_alpha.features import EAR_HOLD, earnings_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate
    from bharat_alpha.timeutil import IST

    sim = simulate(n_stocks=6, n_days=140, seed=5)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    idx, cols = p.close.index, list(p.close.columns)
    a, b = cols[0], cols[1]

    # flat market; A reacts +10% then +5% on results with 3x volume; B's results fall on a Saturday
    close = pd.DataFrame(100.0, index=idx, columns=cols)
    close.loc[idx[60]:, a] = 110.0
    close.loc[idx[61]:, a] = 115.5
    sat = next(d for d in pd.date_range(idx[80], idx[90]) if d.weekday() == 5)
    s0b = int(np.searchsorted(idx, sat))
    close.loc[idx[s0b]:, b] = 95.0
    volume = pd.DataFrame(1000.0, index=idx, columns=cols)
    volume.loc[[idx[60], idx[61]], a] = 3000.0
    traded = pd.DataFrame(True, index=idx, columns=cols)
    p = dataclasses.replace(p, close=close, volume=volume, traded=traded)

    k = lambda d: dt.datetime.combine(d, dt.time(17, 0), tzinfo=IST)  # noqa: E731
    rows = [
        # first intimation for A said idx[55]; a later one rescheduled it to idx[60]
        {"instrument_id": a, "event_date": idx[55].date(), "knowable_at": k(idx[40].date())},
        {"instrument_id": a, "event_date": idx[60].date(), "knowable_at": k(idx[50].date())},
        {"instrument_id": b, "event_date": sat.date(), "knowable_at": k(idx[70].date())},
    ]
    upsert(conn, "alpha.corporate_event", [{"source": "nse_board_meetings", "event_type": "results", "detail": None,
                                            **r} for r in rows], key=("source", "instrument_id", "event_type", "event_date"))
    conn.commit()
    assert len(read_df(conn, "SELECT 1 FROM alpha.corporate_event")) == 3

    f = earnings_features(conn, p)
    ear, shock, age = f["earn_ear"], f["earn_vol_shock"], f["earn_age"]
    assert ear[a].iloc[:61].isna().all()                  # nothing before day +1: not the superseded date, not day 0
    assert ear[a].iloc[61] == pytest.approx(0.15) and ear[a].iloc[61 + EAR_HOLD - 1] == pytest.approx(0.15)
    assert np.isnan(ear[a].iloc[61 + EAR_HOLD])
    assert shock[a].iloc[61] == pytest.approx(np.log(3.0)) and age[a].iloc[61] == 0 and age[a].iloc[70] == 9
    assert np.isnan(ear[b].iloc[s0b]) and ear[b].iloc[s0b + 1] == pytest.approx(-0.05)   # Saturday -> Monday
    assert ear[cols[2]].isna().all()                      # no results, no feature
