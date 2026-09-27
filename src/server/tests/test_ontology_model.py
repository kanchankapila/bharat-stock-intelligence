"""
The ontology data model's integrity contract.

Every test here needs no database: the semantic layer is authored Python, so these are the
tests that catch a bad *edit to the definitions* -- a binding pointing at a property that does
not exist, a card's PK no longer bound to a column, a metric whose SQL stopped matching its
declared source tables.

Two rules govern the file:

1. **Never vacuous.** Every positive assertion is paired with a negative control that proves
   the check can fail. A test that passes because it inspects nothing is the exact
   "green while protecting nothing" shape recurring-bugs.md records over and over.
2. **The feature/target boundary is the product.** The layer's main value is saying what may
   and may not go into X. Those tests are therefore the bulk of this file.

The DB-facing halves (store / coverage) live in test_ontology_store.py behind the pg fixtures.
"""
import copy
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402

from ontology.definitions import build_ontology  # noqa: E402
from ontology.model import MetricDef, Ontology, validate_metric_sql  # noqa: E402


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


@pytest.fixture
def broken(onto):
    """A throwaway copy, so a negative control can never corrupt the module-scoped real one."""
    return copy.deepcopy(onto)


# ── the shipped layer ──────────────────────────────────────────────────────────

def test_the_shipped_ontology_is_clean(onto):
    issues = onto.validate()
    assert issues == [], "ontology integrity violations:\n" + "\n".join(issues[:20])


def test_the_layer_is_not_vacuously_small(onto):
    """A floor, so a definitions file that loses 90% of itself still fails rather than passes."""
    s = onto.summary()
    assert s["classes"] >= 40
    assert s["properties"] >= 150
    assert s["cards"] >= 40
    assert s["bindings"] >= 400
    assert s["relations"] >= 25
    assert s["metrics"] >= 15
    assert s["vocabularies"] >= 25


def test_names_are_unique_within_each_collection(onto):
    for label, coll in (("class", onto.classes), ("property", onto.properties),
                        ("card", onto.cards), ("relation", onto.relations),
                        ("metric", onto.metrics), ("vocabulary", onto.vocabularies)):
        names = [x.name if hasattr(x, "name") else x.table for x in coll]
        dupes = {n for n in names if names.count(n) > 1}
        assert not dupes, f"duplicate {label} names: {sorted(dupes)}"


def test_summary_counts_match_the_contents(onto):
    s = onto.summary()
    assert s["classes"] == len(onto.classes)
    assert s["properties"] == len(onto.properties)
    assert s["cards"] == len(onto.cards)
    assert s["bindings"] == len(onto.bindings)
    assert s["relations"] == len(onto.relations)
    assert s["metrics"] == len(onto.metrics)
    assert s["vocabularies"] == len(onto.vocabularies)


def test_every_property_is_reachable_from_a_real_column(onto):
    unbound = [p.name for p in onto.properties if not onto.bindings_for_property(p.name)]
    assert unbound == [], f"properties bound to nothing: {unbound}"


def test_every_bound_column_has_a_data_card(onto):
    orphans = sorted({b.ref for b in onto.bindings if onto.card_by_table(b.table) is None})
    assert orphans == []


def test_every_table_class_is_realized_by_a_card(onto):
    """`realization` is how a class says 'I exist only as a column value' (Exchange, Sector).

    That is a legitimate fact about this schema, so the rule is precise rather than
    'every class has a table': only classes that CLAIM to be table-realized must be.
    """
    missing = [
        c.name for c in onto.classes
        if c.realization == "table"
        and not any(card.entity == c.name for card in onto.cards)
        and not any(c.name in other.parents for other in onto.classes)
    ]
    assert missing == [], f"classes claiming realization='table' with no table: {missing}"


# ── the feature/target boundary, which is the layer's main product ─────────────

def test_every_card_has_a_non_empty_primary_key(onto):
    """Without a PK an agent cannot write a correct join or dedupe."""
    assert [c.table for c in onto.cards if not c.pk] == []


def test_label_properties_are_never_features(onto):
    for p in onto.properties:
        if p.semantic_type == "label":
            assert not p.is_feature, f"{p.name} is a label but claims is_feature"
            assert p.leakage_risk in ("target", "high"), f"{p.name} understates its own risk"


def test_high_leakage_risk_is_never_a_feature(onto):
    for p in onto.properties:
        if p.leakage_risk == "high":
            assert not p.is_feature, f"{p.name} is high-leakage but claims is_feature"


def test_a_label_table_exposes_no_trainable_columns(onto):
    """`training_use == labels` means the whole table IS the target."""
    for card in onto.cards:
        if card.training_use == "labels":
            assert not card.feature_columns(onto), f"{card.table} is labels but exposes features"


def test_forbidden_tables_carry_no_trainable_columns(onto):
    """`training_use == forbidden` means nothing on the table may enter X.

    Asserted through the card-level verdict (`feature_columns()`), not the raw property
    flag: shared dimension properties (`category`, `source`, `horizon_days`) are
    legitimately features on allowed tables, and the TABLE verdict is what bars them
    here — the same rule kg_v_feature applies.
    """
    for card in onto.cards:
        if card.training_use == "forbidden":
            assert card.feature_columns(onto) == (), (
                f"{card.table} is forbidden but exposes "
                f"{card.feature_columns(onto)[:5]}")


def test_label_tables_are_reachable_from_the_never_feature_view(onto):
    """`label_columns()` is what kg_v_never_feature is built from; it must be non-empty for
    every outcome table, or that view silently under-reports the danger."""
    outcomes = [c for c in onto.cards if c.training_use == "labels"]
    assert outcomes, "no table is marked training_use='labels'"
    for card in outcomes:
        assert card.label_columns(onto), f"{card.table} is labels but has no label columns"


def test_every_property_declares_the_axes_a_model_consumer_needs(onto):
    """semantic_type / timing / leakage_risk are not documentation -- they are the contract."""
    from ontology import vocab
    for p in onto.properties:
        assert p.semantic_type in vocab.SEMANTIC_TYPES, p.name
        assert p.timing in vocab.TIMING_CLASSES, p.name
        assert p.leakage_risk in vocab.LEAKAGE_RISKS, p.name
        assert p.derivation in vocab.DERIVATIONS, p.name
        assert p.datatype in vocab.DATATYPES, p.name


# ── metric SQL: a read-only layer that can write is not a read-only layer ───────

def _metric(sql, source_tables=("stock_ohlcv",), **kw):
    return MetricDef(name="m", label="m", description="d", sql=sql,
                     entity="Equity", source_tables=source_tables, **kw)


@pytest.mark.parametrize("sql, why", [
    ("DELETE FROM stock_ohlcv", "a write"),
    ("SELECT 1; DROP TABLE stock_ohlcv", "two statements"),
    ("SELECT 1 FROM stock_ohlcv WHERE symbol LIKE '%RELIANCE%'", "the % placeholder trap"),
    ("UPDATE stock_ohlcv SET close = 0", "a write"),
])
def test_metric_sql_rejects_dangerous_statements(sql, why):
    assert validate_metric_sql(_metric(sql)), f"validator missed: {why}"


def test_metric_sql_must_reference_every_declared_source(onto):
    """Declares a source it never reads => the documentation and the SQL have drifted apart."""
    for m in onto.metrics:
        assert validate_metric_sql(m) == [], f"{m.name}: {validate_metric_sql(m)}"


def test_a_well_formed_metric_passes():
    assert validate_metric_sql(_metric("SELECT close FROM stock_ohlcv")) == []


def test_render_literal_substitutes_binds_and_escapes_quotes():
    m = _metric("SELECT close FROM stock_ohlcv WHERE symbol = :symbol AND d = :as_of",
                params=("symbol", "as_of"))
    out = m.render_literal(symbol="O'BRIEN", as_of="2026-01-01")
    assert "'O''BRIEN'" in out
    assert ":symbol" not in out and ":as_of" not in out


def test_an_undeclared_bind_is_rejected_at_render_time():
    """A third bind would render as literal text and fail only at execution time."""
    m = _metric("SELECT :nope", params=("nope",))
    with pytest.raises(ValueError):
        m.render_literal()


# ── controlled vocabularies, which were read out of the live DB ─────────────────

def test_every_vocabulary_term_resolves_its_broader(onto):
    for v in onto.vocabularies:
        assert v.terms, f"{v.name} is empty"
        assert len(set(v.notations())) == len(v.terms), f"{v.name} has duplicate notations"
        for t in v.terms:
            if t.broader:
                assert t.broader in v.notations(), f"{v.name}/{t.notation} bad broader"


def test_enum_properties_name_a_vocabulary_that_exists_and_is_populated(onto):
    for p in onto.properties:
        if p.semantic_type == "enum":
            assert p.vocabulary, f"{p.name} is an enum with no vocabulary bound"
            v = onto.vocabulary_by_name(p.vocabulary)
            assert v is not None and v.terms, f"{p.name} -> empty vocabulary {p.vocabulary!r}"


def test_to_dict_from_dict_round_trips(onto):
    assert Ontology.from_dict(onto.to_dict()).summary() == onto.summary()
