import datetime as dt

import numpy as np
import pandas as pd
import pytest

from bharat_alpha.ingest.sources.nse_fo import parse_fo_ban


def ban_file(d: dt.date, syms: list[str]) -> str:
    body = "".join(f"{i},{s}\n" for i, s in enumerate(syms, 1)) or "NIL\n"
    return f"Securities in Ban For Trade Date {d.strftime('%d-%b-%Y').upper()}:\n" + body


def test_parse_takes_the_date_from_the_header_and_handles_nil():
    assert parse_fo_ban(ban_file(dt.date(2026, 9, 28), ["SIM001", "SAIL"])) == (dt.date(2026, 9, 28), ["SIM001", "SAIL"])
    assert parse_fo_ban(ban_file(dt.date(2026, 9, 29), [])) == (dt.date(2026, 9, 29), [])
    with pytest.raises(ValueError):
        parse_fo_ban("<html>Access denied</html>")


def test_ban_status_streak_exit_and_unknown_days(conn):
    from bharat_alpha.db import read_df
    from bharat_alpha.features import ban_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_fo import NseFoBan
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=20, seed=10)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    d = sim.dates
    plan = {d[4]: [], d[5]: ["SIM002"], d[6]: ["SIM002"], d[7]: ["SIM002"], d[8]: [], d[9]: []}
    for day, syms in plan.items():
        status, _ = run_connector(conn, NseFoBan(), day, raw=ban_file(day, syms))
        assert status == "success"                               # a no-ban day is data, not an empty run
    assert read_df(conn, "SELECT count(*) n FROM alpha.fo_ban_day").n[0] == 6
    run_connector(conn, NseFoBan(), d[5], raw=ban_file(d[5], ["SIM002", "SIM004"]))
    run_connector(conn, NseFoBan(), d[5], raw=ban_file(d[5], ["SIM002"]))       # re-published list replaces the day
    assert read_df(conn, "SELECT count(*) n FROM alpha.fo_ban WHERE trade_date = %s", (d[5],)).n[0] == 1
    p = load_panel(conn, d[0], d[-1])
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM002'").iloc[0, 0])
    other = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM003'").iloc[0, 0])
    f = ban_features(conn, p)
    ts = lambda k: pd.Timestamp(d[k])  # noqa: E731
    ban, days, exit_ = f["fo_ban"][iid], f["fo_ban_days"][iid], f["fo_ban_exit"][iid]
    assert np.isnan(ban.loc[ts(3)])                               # no file processed: unknown, not 0
    assert [ban.loc[ts(k)] for k in range(4, 10)] == [0, 1, 1, 1, 0, 0]
    assert [days.loc[ts(k)] for k in (5, 6, 7)] == [1, 2, 3]
    assert exit_.loc[ts(8)] == 1 and exit_.loc[ts(9)] == 0
    assert f["fo_ban"][other].loc[ts(6)] == 0
