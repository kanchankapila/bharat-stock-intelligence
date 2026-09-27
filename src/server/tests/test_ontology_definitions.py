"""Round-trip of the ontology through JSON, and the invariants that only matter once it is
a build artifact: a consumer should get the same layer back that this repo has in memory."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ontology.definitions import build_ontology  # noqa: E402
from ontology.model import Ontology  # noqa: E402


def test_json_round_trip_is_lossless():
    original = build_ontology()
    revived = Ontology.from_dict(json.loads(json.dumps(original.to_dict())))
    assert revived.validate() == []
    assert revived.summary() == original.summary()


def test_round_trip_preserves_every_named_entity():
    a, b = build_ontology(), None
    b = Ontology.from_dict(json.loads(json.dumps(a.to_dict())))
    for name in (c.name for c in a.classes):
        assert b.class_by_name(name) is not None, name
    for name in (p.name for p in a.properties):
        assert b.property_by_name(name) is not None, name
    for name in (c.table for c in a.cards):
        assert b.card_by_table(name) is not None, name
    for name in (m.name for m in a.metrics):
        assert b.metric_by_name(name) is not None, name


def test_version_is_recorded():
    """An exported ontology with no version is undatable: you cannot tell later whether a
    consumer's cached copy is stale."""
    o = build_ontology()
    assert o.version
    assert o.to_dict()["version"] == o.version


def test_counts_are_stable_enough_to_catch_an_accidental_deletion():
    """Not a snapshot of today's numbers -- a floor. A hand-edit that drops a dozen classes
    or bindings fails here instead of quietly shipping a thinner ontology."""
    s = build_ontology().summary()
    assert s["classes"] >= 40
    assert s["properties"] >= 200
    assert s["cards"] >= 45
    assert s["bindings"] >= 500
    assert s["relations"] >= 25
    assert s["metrics"] >= 15
    assert s["vocabularies"] >= 25
    assert s["vocabulary_terms"] >= 100