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
                                  "nse_fo_secban", "nse_results_rss", "nse_pr_bc",
                                  "nse_board_meetings",
                                  "nse_insider_pit", "nse_symbol_change", "nse_equity_master"])
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


def test_investsights_estimates_live(conn, client, session):
    """Settles whether FMP still covers large NSE names and that EPS is per share, not per lakh."""
    from bharat_alpha.ingest.sources.investsights_estimates import InvestsightsEstimates

    assert run_connector(conn, CONNECTORS["nse_bhavcopy"](), session, client=client)[0] == "success"
    status, n = run_connector(conn, InvestsightsEstimates(["RELIANCE", "INFY", "HDFCBANK"]), session, client=client)
    assert status == "success" and n >= 6, read_df(conn, "SELECT detail FROM alpha.ingest_run ORDER BY run_id DESC LIMIT 1")
    eps = read_df(conn, "SELECT value FROM alpha.fundamental WHERE source='investsights_estimates' AND field LIKE 'est_is_eps_fy%%'")
    assert len(eps) >= 3 and eps.value.abs().between(0.01, 10_000).all()

def test_mojo_shareholding_live(conn, client, session):
    """Settles that the endpoint still answers unauthenticated and still nests the pledge series."""
    from bharat_alpha.ingest.sources.mojo_shareholding import MojoShareholding

    assert run_connector(conn, CONNECTORS["nse_bhavcopy"](), session, client=client)[0] == "success"
    with conn.cursor() as cur:            # Neuland Labs: the sid the legacy fetcher verified live
        cur.execute("""INSERT INTO alpha.provider_id(provider, provider_key, instrument_id, resolution)
                       SELECT 'marketsmojo', '229993', instrument_id, 'manual' FROM alpha.symbol_history
                       WHERE symbol = 'NEULANDLAB' LIMIT 1""")
    status, n = run_connector(conn, MojoShareholding(), session, client=client)
    assert status == "success" and n >= 5, read_df(conn, "SELECT detail FROM alpha.ingest_run ORDER BY run_id DESC LIMIT 1")
    held = read_df(conn, """SELECT value FROM alpha.fundamental WHERE source = 'mojo_shareholding'
                            AND field = 'own_promoter_holding_pct'""")
    assert len(held) >= 2 and held.value.between(0, 100).all()

def test_nse_results_live(conn, client, session):
    """Settles the results-comparison field names nse_results.parse_results is strict about."""
    from bharat_alpha.ingest.sources.nse_results import NseResults

    assert run_connector(conn, CONNECTORS["nse_bhavcopy"](), session, client=client)[0] == "success"
    status, n = run_connector(conn, NseResults(["RELIANCE", "INFY", "HDFCBANK"]), session, client=client)
    assert status == "success" and n >= 9, read_df(conn, "SELECT detail FROM alpha.ingest_run ORDER BY run_id DESC LIMIT 1")
    eps = read_df(conn, "SELECT value FROM alpha.fundamental WHERE source='nse_results' AND field='res_eps'")
    assert eps.value.abs().between(0.01, 10_000).all()


def test_fred_live(conn, client, session):
    from bharat_alpha.ingest.sources.fred import FredSeries

    status, n = run_connector(conn, FredSeries(series=("SP500", "VIXCLS"), start="2026-01-01"), session, client=client)
    assert status == "success" and n >= 100, read_df(conn, "SELECT detail FROM alpha.ingest_run ORDER BY run_id DESC LIMIT 1")
