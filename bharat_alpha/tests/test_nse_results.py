import datetime as dt

import numpy as np
import pandas as pd
import pytest

from bharat_alpha.ingest.sources.nse_results import filing_deadline, knowable_for, parse_results
from bharat_alpha.timeutil import IST


def row(pe: str, eps, inc=1000.0, np_=100.0, eps_key="re_basic_eps"):
    return {"re_to_dt": pe, "re_total_inc": inc, "re_net_profit": np_, eps_key: eps}


def test_parse_is_strict_about_shape():
    got = parse_results({"resCmpData": [row("31-Mar-2026", "12.5", "1,200.0"), row("31-Dec-2025", 11.0),
                                        row("31-Mar-2026", 99.0)]})                  # duplicate period: first wins
    assert [(g["period_end"], g["res_eps"], g["res_revenue_lakh"]) for g in got] == [
        (dt.date(2026, 3, 31), 12.5, 1200.0), (dt.date(2025, 12, 31), 11.0, 1000.0)]
    assert parse_results({"resCmpData": [row("31-Dec-2025", 3.0, eps_key="reDilEPS")]})[0]["res_eps"] == 3.0
    with pytest.raises(ValueError):
        parse_results({"data": []})                                                 # not the expected envelope
    with pytest.raises(ValueError):
        parse_results({"resCmpData": [{"re_to_dt": "31-Dec-2025", "re_total_inc": 1, "re_net_profit": 1}]})  # no EPS
    with pytest.raises(ValueError):
        parse_results({"resCmpData": [row("Q3 FY26", 1.0)]})                          # unparseable period


def test_knowable_is_the_results_date_else_the_deadline():
    q, late = dt.date(2025, 12, 31), dt.datetime(2026, 6, 1, tzinfo=IST)
    assert filing_deadline(q) == dt.date(2026, 2, 14) and filing_deadline(dt.date(2026, 3, 31)) == dt.date(2026, 5, 30)
    assert knowable_for(q, [dt.date(2026, 1, 20)], late) == dt.datetime(2026, 1, 20, 23, 0, tzinfo=IST)
    # a meeting before the quarter ended, or after the deadline, is not this quarter's results
    assert knowable_for(q, [dt.date(2025, 11, 5), dt.date(2026, 4, 30)], late) == dt.datetime(2026, 2, 14, 18, 30, tzinfo=IST)
    early = dt.datetime(2026, 1, 10, 9, 0, tzinfo=IST)
    assert knowable_for(q, [], early) == early


def test_eps_yoy_reaches_features_after_the_results_date(conn):
    from bharat_alpha.db import read_df, upsert
    from bharat_alpha.features import results_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_results import write_results
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=400, seed=8)                  # 2022-01-03 .. ~2023-07
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM002'").iloc[0, 0])
    results_day = dt.date(2023, 5, 10)
    upsert(conn, "alpha.corporate_event", [{"source": "nse_board_meetings", "instrument_id": iid, "event_type": "results",
                                            "event_date": results_day, "knowable_at": dt.datetime(2023, 4, 25, 17, 0, tzinfo=IST),
                                            "detail": None}], key=("source", "instrument_id", "event_type", "event_date"))
    quarters = [dt.date(2022, 3, 31), dt.date(2022, 6, 30), dt.date(2022, 9, 30), dt.date(2022, 12, 31), dt.date(2023, 3, 31)]
    rows = [{"instrument_id": iid, "period_end": q, "res_eps": e, "res_revenue_lakh": r, "res_net_profit_lakh": 1.0}
            for q, e, r in zip(quarters, (10.0, 11.0, 12.0, 13.0, 15.0), (100.0, 110.0, 120.0, 130.0, 150.0))]
    # the June quarter has no results event yet: dated by the fetch, which a later re-fetch would move
    rows.append({"instrument_id": iid, "period_end": dt.date(2023, 6, 30), "res_eps": 16.0, "res_revenue_lakh": 160.0,
                 "res_net_profit_lakh": 1.0})
    fetched = dt.datetime(2023, 7, 1, 20, 0, tzinfo=IST)
    assert write_results(conn, rows, fetched) == 18
    assert write_results(conn, rows, fetched + dt.timedelta(days=30)) == 0        # re-fetch never restamps
    conn.commit()

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    f = results_features(conn, p)
    eps, rev = f["res_eps_yoy_px"][iid], f["res_revenue_yoy"][iid]
    ts = pd.Timestamp
    assert np.isnan(eps.loc[ts(results_day)])                                        # released after hours
    nxt = eps.index[eps.index > ts(results_day)][0]
    assert eps.loc[nxt] == pytest.approx(5.0 / p.raw_close.loc[nxt, iid])            # 15 - 10, the same quarter a year earlier
    assert rev.loc[nxt] == pytest.approx(0.5)
    assert eps.loc[:ts(results_day)].isna().all()                                    # only one YoY pair exists
