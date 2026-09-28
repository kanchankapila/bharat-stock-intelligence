import datetime as dt

import numpy as np
import pytest

HEADER = "Company Name,Industry,Symbol,Series,ISIN Code\n"


def roster(symbols: list[str]) -> str:
    return HEADER + "".join(f"{s} Ltd,Banks,{s},EQ,INE{i:03d}A01011\n" for i, s in enumerate(symbols))


def test_membership_diff_records_joins_and_exits_and_a_short_file_is_not_a_mass_exit(conn):
    """The constituent file is a snapshot, so a change is only knowable the session we see it.
    A truncated file would otherwise read as every remaining name leaving the index at once."""
    from bharat_alpha.db import read_df
    from bharat_alpha.features import INDEX_EVENT_WINDOW, index_event_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_constituents import NseConstituents
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=8, n_days=60, seed=29)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    base = ["SIM003", "SIM005", "SIM006", "SIM007"]
    d0, d1, d2, d3 = sim.dates[10], sim.dates[20], sim.dates[30], sim.dates[40]

    def members(on):
        return set(read_df(conn, "SELECT instrument_id FROM alpha.index_membership "
                                 "WHERE index_name = 'NIFTY 500' AND to_date IS NULL").instrument_id)

    def iid(sym):
        return int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (sym,)).iloc[0, 0])

    # first sighting: the whole roster joins
    assert run_connector(conn, NseConstituents(), d0, raw=roster(base))[0] == "success"
    conn.commit()
    assert len(members(d0)) == 4
    # a quiet day changes nothing
    run_connector(conn, NseConstituents(), d1, raw=roster(base))
    conn.commit()
    assert len(members(d1)) == 4
    joins = read_df(conn, "SELECT instrument_id FROM alpha.corporate_event WHERE event_type='index_join'")
    assert len(joins) == 4                                        # not re-recorded on the quiet day

    # SIM007 leaves, SIM004 joins
    changed = ["SIM003", "SIM005", "SIM006", "SIM004"]
    run_connector(conn, NseConstituents(), d2, raw=roster(changed))
    conn.commit()
    assert members(d2) == {iid(s) for s in changed}
    gone = read_df(conn, """SELECT to_date FROM alpha.index_membership
                            WHERE index_name='NIFTY 500' AND instrument_id=%s""", (iid("SIM007"),))
    assert gone.to_date[0] == d2
    exits = read_df(conn, "SELECT instrument_id FROM alpha.corporate_event WHERE event_type='index_exit'")
    assert list(exits.instrument_id) == [iid("SIM007")]

    # a truncated file (1 of 4) must not retire the index
    run_connector(conn, NseConstituents(), d3, raw=roster(["SIM003"]))
    conn.commit()
    assert members(d3) == {iid(s) for s in changed}
    assert len(read_df(conn, "SELECT 1 FROM alpha.corporate_event WHERE event_type='index_exit'")) == 1

    # the feature counts sessions since the change, and only from the session it was seen
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    f = index_event_features(conn, p)
    join = f["idx_days_since_join"][iid("SIM004")]
    assert np.isnan(join.loc[str(sim.dates[29])])                 # nothing before it was visible
    assert join.loc[str(d2)] == 0 and join.loc[str(sim.dates[31])] == 1
    assert np.isnan(join.loc[str(sim.dates[30 + INDEX_EVENT_WINDOW])])   # the window closes
    assert f["idx_days_since_exit"][iid("SIM007")].loc[str(d2)] == 0


def test_sector_and_isin_still_update_when_the_roster_diff_is_skipped(conn):
    """The short-file guard must not also throw away the labels the file legitimately carries."""
    from bharat_alpha.db import read_df
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_constituents import NseConstituents
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=8, n_days=40, seed=31)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    full = ["SIM003", "SIM005", "SIM006", "SIM007"]
    run_connector(conn, NseConstituents(), sim.dates[10], raw=roster(full))
    conn.commit()
    short = HEADER + "Sim Five Ltd,Pharma,SIM005,EQ,INE999A01011\n"
    assert run_connector(conn, NseConstituents(), sim.dates[20], raw=short)[0] == "success"
    conn.commit()
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM005'").iloc[0, 0])
    sector = read_df(conn, "SELECT sector FROM alpha.instrument WHERE instrument_id=%s", (iid,)).sector[0]
    assert sector == "Pharma"                                     # updated despite the skipped diff
    assert len(read_df(conn, "SELECT 1 FROM alpha.corporate_event WHERE event_type='index_exit'")) == 0
