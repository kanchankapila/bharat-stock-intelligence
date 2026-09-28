import datetime as dt

import numpy as np
import pandas as pd
import pytest

from bharat_alpha.ingest.sources.nse_market import parse_participant_oi

HEADER = ("Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short\t,"
          "Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,"
          "Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,"
          "Total Long Contracts\t,Total Short Contracts\n")


def file_for(fii_fut=(100000, 300000), fii_calls=(50, 10), fii_puts=(10, 30)):
    row = lambda who, fl, fs, cl, cs, pl, ps: (f"{who},{fl},{fs},1,2,{cl},{pl},{cs},{ps},3,4,5,6,0,0\n")  # noqa: E731
    return ('"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Sep 25, 2026"\n'
            + HEADER
            + row("Client", 400000, 200000, 1, 1, 1, 1)
            + row("DII", 50000, 60000, 1, 1, 1, 1)
            + row("FII", *fii_fut, fii_calls[0], fii_calls[1], fii_puts[0], fii_puts[1])
            + row("Pro", 90000, 90000, 1, 1, 1, 1)
            + row("TOTAL", 1, 1, 1, 1, 1, 1))


def test_parse_finds_header_after_title_and_drops_total():
    rows = parse_participant_oi(file_for(), dt.date(2026, 9, 25))
    assert len(rows) == 4 * 6 and {r["participant"] for r in rows} == {"CLIENT", "DII", "FII", "PRO"}
    fii = next(r for r in rows if r["participant"] == "FII" and r["instrument"] == "fut_idx")
    assert (fii["long_oi"], fii["short_oi"]) == (100000, 300000)
    put = next(r for r in rows if r["participant"] == "FII" and r["instrument"] == "opt_idx_put")
    assert (put["long_oi"], put["short_oi"]) == (10, 30)            # column order is Call L, Put L, Call S, Put S
    with pytest.raises(ValueError):
        parse_participant_oi(file_for().replace("Future Index Short", "Fut Idx Short"), dt.date(2026, 9, 25))
    with pytest.raises(ValueError):
        parse_participant_oi("<html>blocked</html>", dt.date(2026, 9, 25))


def test_positioning_is_used_from_the_next_session(conn):
    from bharat_alpha.features import participant_positioning
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_market import NseParticipantOi
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=20, seed=6)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    d = sim.dates
    assert run_connector(conn, NseParticipantOi(), d[5], raw=file_for())[0] == "success"
    assert run_connector(conn, NseParticipantOi(), d[10], raw=file_for(fii_fut=(300000, 100000)))[0] == "success"
    idx = load_panel(conn, d[0], d[-1]).close.index
    f = participant_positioning(conn, idx)
    ts = pd.Timestamp
    assert np.isnan(f.loc[ts(d[5]), "fii_idxfut_net"])                   # the evening file is not usable that day
    assert f.loc[ts(d[6]), "fii_idxfut_net"] == pytest.approx(-0.5)
    assert f.loc[ts(d[11]), "fii_idxfut_net"] == pytest.approx(0.5)
    assert f.loc[ts(d[6]), "client_idxfut_net"] == pytest.approx(1 / 3)
    assert f.loc[ts(d[6]), "fii_idxopt_bias"] == pytest.approx(((50 - 10) - (10 - 30)) / 100)
