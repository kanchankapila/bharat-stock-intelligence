"""Live round-trips against the real upstreams. Skipped unless RUN_LIVE_DATASOURCE_TESTS=1 —
a third-party outage must never redden CI, but these must be run by hand before trusting a
connector and periodically as a canary.

Each test uses the connector's OWN fetch + parse + write (never a re-implementation), on the
most recent completed session, and treats "empty on a trading day" as a FAILURE, not a skip.
"""

import pytest

from bharat_alpha.db import read_df
from bharat_alpha.ingest.base import run_connector
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.ingest.registry import CONNECTORS
from bharat_alpha.ingest.sources.investsights import InvestsightsFundamentals
from bharat_alpha.timeutil import latest_completed_session

pytestmark = pytest.mark.live_datasource


@pytest.fixture(scope="module")
def client():
    return HttpClient()


@pytest.fixture()
def session():
    return latest_completed_session()


def test_bhavcopy_live(conn, client, session):
    status, n = run_connector(conn, CONNECTORS["nse_bhavcopy"](), session, client=client)
    assert status == "success" and n > 1500, (status, n)
    bars = read_df(conn, "SELECT count(*) n, avg((deliv_pct IS NOT NULL)::int) d FROM alpha.daily_bar")
    assert bars.d[0] > 0.85
    sym = read_df(conn, "SELECT symbol FROM alpha.symbol_history WHERE symbol='RELIANCE'")
    assert len(sym) == 1


@pytest.mark.parametrize("name", ["nse_fo_bhavcopy", "nse_index_close", "nse_fii_dii", "nse_participant_oi",
                                  "nse_board_meetings",
                                  "nse_insider_pit", "nse_symbol_change"])
def test_connector_live(conn, client, session, name):
    assert run_connector(conn, CONNECTORS["nse_bhavcopy"](), session, client=client)[0] == "success"
    status, n = run_connector(conn, CONNECTORS[name](), session, client=client)
    assert status == "success", (name, status, read_df(conn, "SELECT detail FROM alpha.ingest_run ORDER BY run_id DESC LIMIT 1"))


def test_investsights_live(conn, client, session):
    assert run_connector(conn, CONNECTORS["nse_bhavcopy"](), session, client=client)[0] == "success"
    status, n = run_connector(conn, InvestsightsFundamentals(["RELIANCE", "INFY", "HDFCBANK"]), session, client=client)
    assert status == "success" and n >= 10
    f = read_df(conn, "SELECT field, value FROM alpha.fundamental WHERE field='return_on_equity'")
    assert len(f) >= 2 and f.value.abs().max() < 5            # a fraction, not a percent

