import dataclasses
import datetime as dt

import numpy as np
import pandas as pd
import pytest
from xml.sax.saxutils import escape

from bharat_alpha.ingest.sources.nse_corporate import parse_results_rss
from bharat_alpha.timeutil import IST


def rss(items: list[tuple[str, str]]) -> str:
    body = "".join(f"<item><title>{escape(t)}</title><link>{escape(l)}</link><pubDate>x</pubDate></item>" for t, l in items)
    return f'<?xml version="1.0"?><rss version="2.0"><channel><title>Financial Results</title>{body}</channel></rss>'


def link(sym: str, when: dt.datetime) -> str:
    return f"https://nsearchives.nseindia.com/corporate/{sym}_{when:%d%m%Y%H%M%S}_Outcome.pdf"


def test_parse_takes_symbol_and_time_from_the_filing_link():
    t1, t2 = dt.datetime(2026, 5, 13, 14, 14, 32), dt.datetime(2026, 5, 13, 17, 5, 0)
    rows = parse_results_rss(rss([("Titan", link("TITAN", t1)), ("M&M", link("M&M", t2)),
                                  ("no stamp", "https://nsearchives.nseindia.com/corporate/a.pdf")]))
    assert [(r["symbol"], r["filed_at"]) for r in rows] == [("TITAN", t1.replace(tzinfo=IST)), ("M&M", t2.replace(tzinfo=IST))]
    with pytest.raises(ValueError):
        parse_results_rss("<html><body>blocked</body></html>")


def test_filing_time_pins_the_reaction_day(conn):
    from bharat_alpha.db import read_df, upsert
    from bharat_alpha.features import earnings_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_corporate import NseResultsRss
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=140, seed=12)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    idx, cols = p.close.index, list(p.close.columns)
    sym = {int(i): s for s, i in read_df(conn, "SELECT symbol, instrument_id FROM alpha.symbol_history").itertuples(index=False)}
    a, b = cols[0], cols[1]
    close = pd.DataFrame(100.0, index=idx, columns=cols)
    close.loc[idx[61]:, a] = 108.0                       # results filed after the close of day 60
    close.loc[idx[62]:, a] = 110.16
    close.loc[idx[80]:, b] = 95.0                        # results filed at 11:00 on day 80
    p = dataclasses.replace(p, close=close, volume=pd.DataFrame(1000.0, index=idx, columns=cols),
                            traded=pd.DataFrame(True, index=idx, columns=cols))
    # the board-meeting intimation said day 60 for A; the filing time moves the reaction to day 61
    upsert(conn, "alpha.corporate_event", [{"source": "nse_board_meetings", "instrument_id": a, "event_type": "results",
                                            "event_date": idx[60].date(), "detail": None,
                                            "knowable_at": dt.datetime.combine(idx[45].date(), dt.time(17), tzinfo=IST)}],
           key=("source", "instrument_id", "event_type", "event_date"))
    filings = [(sym[a], dt.datetime.combine(idx[60].date(), dt.time(17, 5))),
               (sym[b], dt.datetime.combine(idx[80].date(), dt.time(11, 0)))]
    status, n = run_connector(conn, NseResultsRss(), sim.dates[-1], raw=rss([(s, link(s, t)) for s, t in filings]))
    assert status == "success" and n == 2
    ear = earnings_features(conn, p)["earn_ear"]
    assert np.isnan(ear[a].iloc[61])                                   # the reaction was not complete at day 61's close
    assert ear[a].iloc[62] == pytest.approx(0.10)                      # days 61 + 62 (0.08 + 0.02), not 60 + 61 (= 0.08)
    assert ear[b].iloc[81] == pytest.approx(-0.05)                     # filed intraday: day 80 is day 0
