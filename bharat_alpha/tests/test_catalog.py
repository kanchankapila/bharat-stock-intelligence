"""Every URL in the repo's urls.txt must be triaged to a catalog family (derived from the file,
not a hand-kept list), and every 'integrated' family must name a real registered connector."""
from pathlib import Path

import pytest

from bharat_alpha.ingest.catalog import audit, classify, load_catalog, triage
from bharat_alpha.ingest.registry import CONNECTORS

REPO = Path(__file__).resolve().parents[2]
URLS = REPO / "urls.txt"


@pytest.mark.parametrize("name", ["urls.txt", "unique_urls.txt"])
def test_every_url_is_triaged(name):
    if not (REPO / name).exists():
        pytest.skip(f"{name} lives in the parent repo")
    urls = (REPO / name).read_text().splitlines()
    counts, unmatched = triage(urls)
    assert not unmatched, unmatched[:10]
    assert sum(counts.values()) == len([u for u in urls if u.strip()])


def test_integrated_families_point_at_real_connectors():
    fams = load_catalog()
    for f in fams:
        if f.verdict == "integrated":
            assert f.connector in CONNECTORS, f.id
    assert {f.verdict for f in fams} <= {"integrated", "superseded", "backlog-high", "backlog-medium",
                                         "backlog-low", "rejected"}


def test_first_match_wins_and_mangled_urls_normalise():
    fams = load_catalog()
    assert classify("https://kayal.trendlyne.com/broker-webview/kayal/all-in-one-screener-data-get/?x=1", fams).id \
        == "trendlyne_screeners"
    assert classify("https:////api.moneycontrol.com//mcapi//v1//swot//details?scId=BE03", fams).id == "mc_vendor_composites"
    assert classify("https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260925_F_0000.csv.zip",
                    fams).id == "nse_archives_fo"


@pytest.mark.skipif(not (REPO / ".git").exists() or not URLS.exists(), reason="audits the parent repo's git checkout")
def test_no_data_host_in_the_codebase_is_unevaluated():
    """Every URL written anywhere in the legacy codebase (fetchers, docs, scripts), not just the
    corpus files, must map to a catalog family, so a new source cannot be wired in without a verdict."""
    fams = load_catalog()
    res = audit(REPO, fams)
    assert res["urls"] > 5000 and not res["unevaluated"], res["unevaluated"]
    # the check can fail: without the news family its hosts surface as unevaluated
    blind = audit(REPO, [f for f in fams if f.id != "news_feeds"])["unevaluated"]
    assert "api.gdeltproject.org" in blind and "www.livemint.com" in blind


@pytest.mark.parametrize("url,family", [
    ("https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_20102023.csv", "nse_participant_oi"),
    ("https://nsearchives.nseindia.com/content/fo/fo_secban_25092026.csv", "nse_fo_secban"),
    ("https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260925_F_0000.csv.zip", "nse_archives_fo"),
    ("https://www.nseindia.com/api/results-comparision?symbol=INFY", "nse_api_results"),
    ("https://www.nseindia.com/api/market-status", "nse_api_other"),
    ("https://stocks.sapphirebroking.com", "sapphire"),                    # bare host, empty path
])
def test_specific_families_win_over_broad_ones(url, family):
    """First match wins, so a narrow family must sit above the broad family for its host."""
    assert classify(url, load_catalog()).id == family
