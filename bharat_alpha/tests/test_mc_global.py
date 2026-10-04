import datetime as dt
import json
from pathlib import Path

import numpy as np
import pytest

from bharat_alpha.ingest.sources.mc_global import parse_gift_nifty

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
PROBE = Path(__file__).resolve().parent / "fixtures" / "payload_probe.json"


def board(rows: list[tuple[str, str]]) -> dict:
    return {"success": 1, "data": [{"name": n, "ltp": v, "chg": "1.0", "chgper": "0.1",
                                    "market_state": "open"} for n, v in rows]}


def test_parses_the_probed_board_including_its_thousands_separator():
    probe = json.loads(PROBE.read_text())
    items = probe if isinstance(probe, list) else next(v for v in probe.values() if isinstance(v, list))
    sample = next(i["sample"] for i in items if isinstance(i, dict)
                  and "get-global-marketdata?section=mi" in i.get("url", ""))
    first = json.loads(sample[: sample.index("},{")] + "}]}")        # the stored sample is truncated
    assert parse_gift_nifty(first) == pytest.approx(24458.50)        # "24,458.50"


@pytest.mark.parametrize("payload,expected", [
    (board([("GIFT Nifty", "24,458.50")]), 24458.50),
    (board([("Dow Jones Futures", "52,542.47"), ("GIFT Nifty", "100.25")]), 100.25),
    (board([("Dow Jones Futures", "52,542.47")]), None),             # FRED owns the rest of the board
    (board([("GIFT Nifty", "-")]), None),
    (board([("GIFT Nifty", "0")]), None),
    ({"success": 0, "data": [{"name": "GIFT Nifty", "ltp": "1"}]}, None),
])
def test_only_gift_nifty_is_taken_and_a_missing_quote_is_not_a_number(payload, expected):
    got = parse_gift_nifty(payload)
    assert got == pytest.approx(expected) if expected is not None else got is None


def test_the_gap_is_against_the_previous_close_and_a_morning_quote_counts_for_that_session(conn):
    """A quote read before 19:00 IST is usable that session; one read after is not, and lands on
    the next. The gap itself is GIFT against the PREVIOUS session's NIFTY 50 close."""
    from bharat_alpha.db import upsert
    from bharat_alpha.features import market_context
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_market import NseIndexClose
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=40, seed=47)
    hdr = ("Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,"
           "Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\n")
    for i, d in enumerate(sim.dates):
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
        close = 20000 + 10 * i
        raw = hdr + f"NIFTY 50,{d:%d-%m-%Y},{close},{close},{close},{close},0,0,0,0,22.0,3.5,1.2\n"
        assert run_connector(conn, NseIndexClose(), d, raw=raw)[0] == "success"
    conn.commit()

    morning, evening = sim.dates[20], sim.dates[30]
    prev_morning_close = 20000 + 10 * 19                     # the close before the morning quote
    rows = [
        {"series": "GIFT_NIFTY", "obs_date": morning, "value": prev_morning_close * 1.01,
         "source": "mc_global", "knowable_at": dt.datetime.combine(morning, dt.time(8, 45), tzinfo=IST)},
        {"series": "GIFT_NIFTY", "obs_date": evening, "value": 25000.0,
         "source": "mc_global", "knowable_at": dt.datetime.combine(evening, dt.time(21, 0), tzinfo=IST)},
    ]
    assert upsert(conn, "alpha.macro_series", rows, key=("series", "obs_date"), update=("value",)) == 2
    conn.commit()

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    gap = market_context(conn, p)["gift_gap"]
    assert gap.loc[str(morning)] == pytest.approx(0.01)       # 1% above the previous close
    assert np.isnan(gap.loc[str(sim.dates[19])])              # nothing before the quote existed
    # read at 21:00, after the 19:00 cutoff: not usable that session, usable the next
    assert np.isnan(gap.loc[str(evening)])
    assert not np.isnan(gap.loc[str(sim.dates[31])])
