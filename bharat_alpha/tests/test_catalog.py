"""Every URL in the repo's urls.txt must be triaged to a catalog family (derived from the file,
not a hand-kept list), and every 'integrated' family must name a real registered connector."""
from pathlib import Path

import pytest

from bharat_alpha.ingest.catalog import classify, load_catalog, triage
from bharat_alpha.ingest.registry import CONNECTORS

URLS = Path(__file__).resolve().parents[2] / "urls.txt"


@pytest.mark.skipif(not URLS.exists(), reason="urls.txt lives in the parent repo")
def test_every_url_is_triaged():
    urls = URLS.read_text().splitlines()
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
