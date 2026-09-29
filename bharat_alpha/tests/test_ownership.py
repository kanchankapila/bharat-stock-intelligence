import datetime as dt

import numpy as np
import pandas as pd

from bharat_alpha.ingest.sources.ownership import field_name, knowable_for
from bharat_alpha.timeutil import IST


def test_knowable_is_the_filing_deadline_unless_fetched_earlier():
    q = dt.date(2025, 6, 30)
    deadline = dt.datetime(2025, 7, 21, 18, 30, tzinfo=IST)
    assert knowable_for(q, None) == deadline
    assert knowable_for(q, dt.date(2026, 1, 5)) == deadline                   # backfilled long after
    assert knowable_for(q, dt.date(2025, 7, 10)) == dt.datetime(2025, 7, 10, 18, 30, tzinfo=IST)
    assert field_name("fii_holdings_pct") == "own_fii_holdings_pct" and field_name("Promoter") == "own_promoter_pct"


def test_import_and_features_are_point_in_time(conn, legacy_db):
    from bharat_alpha.db import read_df
    from bharat_alpha.features import ownership_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.ownership import SOURCE, import_legacy_shareholding
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=5, n_days=300, seed=4)          # 2022-01-03 .. 2023-02
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    Q = [dt.date(2022, 3, 31), dt.date(2022, 6, 30), dt.date(2022, 9, 30), dt.date(2022, 12, 31)]
    rows = [("SIM003", "promoter_holding_pct", q, v, "2023-01-05") for q, v in zip(Q, (50.0, 51.0, 51.0, 49.0))]
    rows += [("SIM003", "fii_holdings_pct", Q[0], 10.0, "2023-01-05"),       # Q2 missing: no QoQ for Q3
             ("SIM003", "fii_holdings_pct", Q[2], 14.0, "2023-01-05"),
             ("SIM003", "promoter_pledged_pct", Q[0], 150.0, "2023-01-05"),   # not a percentage
             ("NOTLISTED", "promoter_holding_pct", Q[0], 60.0, "2023-01-05")]
    with legacy_db.cursor() as cur:
        cur.execute("CREATE TABLE marketsmojo_shareholding_history (symbol TEXT, category TEXT, period_date DATE, "
                    "value NUMERIC, fetched_at TEXT)")
        cur.executemany("INSERT INTO marketsmojo_shareholding_history VALUES (%s,%s,%s,%s,%s)", rows)
    legacy_db.commit()

    stats = import_legacy_shareholding(conn, legacy_db)
    assert stats == {"rows_read": 8, "rows_written": 6, "unresolved_symbol": 1, "invalid": 1}
    k = read_df(conn, "SELECT period_end, knowable_at FROM alpha.fundamental WHERE source=%s "
                      "AND field='own_promoter_holding_pct' ORDER BY period_end", (SOURCE,))
    assert k.knowable_at[0].astimezone(IST) == dt.datetime(2022, 4, 21, 18, 30, tzinfo=IST)   # deadline
    assert k.knowable_at[3].astimezone(IST) == dt.datetime(2023, 1, 5, 18, 30, tzinfo=IST)    # fetched earlier

    # a later re-fetch only moves fetched_at later: it must not restamp or duplicate history
    with legacy_db.cursor() as cur:
        cur.execute("UPDATE marketsmojo_shareholding_history SET fetched_at='2023-02-20'")
    legacy_db.commit()
    assert import_legacy_shareholding(conn, legacy_db)["rows_written"] == 0

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM003'").iloc[0, 0])
    f = ownership_features(conn, p)
    lvl, qoq = f["own_promoter_holding_pct"][iid], f["own_promoter_holding_pct_qoq"][iid]
    ts = pd.Timestamp
    assert np.isnan(lvl.loc[ts("2022-04-20")]) and lvl.loc[ts("2022-04-21")] == 50.0   # not before the deadline
    assert qoq.loc[ts("2022-07-21")] == 1.0 and qoq.loc[ts("2023-01-05")] == -2.0
    assert f["own_fii_holdings_pct"][iid].loc[ts("2022-10-21")] == 14.0
    assert "own_fii_holdings_pct_qoq" not in f                                         # Q1 -> Q3 is not QoQ
