import datetime as dt

import numpy as np
import pandas as pd
import pytest

from bharat_alpha.ingest.sources.fred import knowable_at, parse_fred_csv
from bharat_alpha.timeutil import IST


def test_parse_both_header_variants_and_skips_missing():
    new = "observation_date,SP500\n2026-09-24,6000.5\n2026-09-25,.\n2026-09-26,6050\n"
    old = "DATE,SP500\n2026-09-24,6000.5\n"
    assert [(r["obs_date"], r["value"]) for r in parse_fred_csv(new, "SP500")] == [
        (dt.date(2026, 9, 24), 6000.5), (dt.date(2026, 9, 26), 6050.0)]
    assert len(parse_fred_csv(old, "SP500")) == 1
    with pytest.raises(ValueError):
        parse_fred_csv(new, "VIXCLS")                              # the series column must be the one asked for
    with pytest.raises(ValueError):
        parse_fred_csv("<html>blocked</html>", "SP500")


def test_us_close_is_the_next_ist_morning_across_dst():
    assert knowable_at(dt.date(2026, 7, 10)).astimezone(IST) == dt.datetime(2026, 7, 11, 1, 30, tzinfo=IST)   # EDT
    assert knowable_at(dt.date(2026, 1, 9)).astimezone(IST) == dt.datetime(2026, 1, 10, 2, 30, tzinfo=IST)   # EST


def test_global_cues_use_the_previous_us_session(conn):
    from bharat_alpha.features import global_cues
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.fred import FredSeries
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=30, seed=9)                  # business days from 2022-01-03
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    us_days = pd.bdate_range("2021-12-20", "2022-02-15")
    level = pd.Series(np.exp(np.arange(len(us_days)) * 0.01) * 4000, index=us_days)
    level[pd.Timestamp("2022-01-07")] *= 1.05                     # a Friday jump
    text = "observation_date,SP500\n" + "".join(f"{d.date()},{v:.6f}\n" for d, v in level.items())
    status, _ = run_connector(conn, FredSeries(series=("SP500",)), sim.dates[-1], raw={"SP500": text})
    assert status == "success"
    idx = load_panel(conn, sim.dates[0], sim.dates[-1]).close.index
    ret1 = global_cues(conn, idx)["us_spx_ret_1"]
    jump = np.log(level["2022-01-07"] / level["2022-01-06"])
    assert ret1.loc[pd.Timestamp("2022-01-07")] == pytest.approx(0.01)        # Friday NSE: Thursday's US close
    assert ret1.loc[pd.Timestamp("2022-01-10")] == pytest.approx(jump)        # Monday NSE: Friday's US close
