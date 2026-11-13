"""The signal catalog's contracts: references resolve, dependencies are real edges, and a
published version is immutable. No database needed."""
import json
import sys
from dataclasses import replace
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from ontology import signals


def test_catalog_validates():
    assert signals.validate() == []


def test_published_version_is_immutable():
    path = Path(signals.CATALOG_DIR) / f"v{signals.SIGNAL_CATALOG_VERSION}.json"
    assert path.exists(), "export the catalog: python -m ontology signals export"
    published = json.loads(path.read_text(encoding="utf-8"))
    assert published == json.loads(json.dumps(signals.catalog())), (
        "a definition changed without bumping SIGNAL_CATALOG_VERSION")


def test_stated_dependencies_are_edges():
    rel = {(r["subject"], r["predicate"], r["object"]) for r in signals.catalog()["relations"]}
    assert ("oi_buildup", "requires", "futures_oi_change") in rel
    assert ("futures_oi_change", "requires", "futures_open_interest") in rel
    assert ("pcr_oi", "requires", "option_open_interest") in rel
    assert ("pcr_oi", "derived_from", "option") in rel
    assert ("delivery_pct", "requires", "traded_volume") in rel


def test_validate_flags_a_broken_reference_and_an_underived_option_signal(monkeypatch):
    broken = tuple(
        replace(s, requires=("nonexistent",)) if s.name == "oi_buildup"
        else replace(s, instruments=("equity",)) if s.name == "pcr_oi"
        else s for s in signals.SIGNALS)
    monkeypatch.setattr(signals, "SIGNALS", broken)
    issues = signals.validate()
    assert any("oi_buildup" in i and "nonexistent" in i for i in issues)
    assert any("pcr_oi" in i and "option" in i for i in issues)


def test_every_signal_names_an_availability_and_a_measured_verdict():
    for s in signals.SIGNALS:
        assert len(s.availability) > 15 and len(s.measured) > 10, s.name
