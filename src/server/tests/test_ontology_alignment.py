"""
Alignment and standards: the interoperability claims, held to the same evidence rule as everything else.

The FIBO decision in this repo is "align, do not adopt", and the reason it is safe to publish is
that *every* assertion carries a strength and a provenance string, and unverified ones are
excluded from the graph. These tests enforce that: a future edit that promotes a remembered IRI
to a verified one without a source fails here, which is the point.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ontology import alignment, build_ontology, standards, vocab  # noqa: E402


class TestAlignmentAssertions:
    def test_every_assertion_has_a_rationale(self):
        for a in alignment.assertions():
            assert a.rationale.strip(), f"{a.subject} -> {a.object} asserts a mapping and explains nothing"

    def test_an_emitted_assertion_must_cite_where_it_was_verified(self):
        """The rule that stopped two inferred-from-module-path IRIs being published as fact."""
        for a in alignment.assertions():
            if a.emitted:
                assert a.verified_from.strip(), (
                    f"{a.subject} -> {a.object} is marked {a.strength!r} but cites no source")

    def test_an_unverified_assertion_cites_nothing(self):
        """Inverse discipline: an unverified claim must not smuggle in partial evidence."""
        for a in alignment.assertions():
            if not a.emitted:
                assert not a.verified_from.strip(), (
                    f"{a.subject} is marked unverified but carries a citation")

    def test_unverified_assertions_are_never_emitted(self):
        emitted = {a.subject for a in alignment.emitted_assertions()}
        for a in alignment.assertions():
            if not a.emitted:
                assert a.subject not in emitted or a.object not in {
                    b.object for b in alignment.emitted_assertions()}

    def test_strength_values_are_from_the_declared_set(self):
        allowed = {"exact", "close", "broad", "narrow", "unverified"}
        for a in alignment.assertions():
            assert a.strength in allowed, a.strength

    def test_predicates_are_skos_match_relations(self):
        allowed = {"skos:exactMatch", "skos:closeMatch", "skos:broadMatch", "skos:narrowMatch"}
        for a in alignment.assertions():
            assert a.predicate in allowed, a.predicate

    def test_every_local_subject_actually_exists_in_the_ontology(self):
        onto = build_ontology()
        known = {f"bsi:{c.name}" for c in onto.classes}
        known |= {f"bsip:{p.name}" for p in onto.properties}
        known |= {f"bsiv:{v.name}" for v in onto.vocabularies}
        for a in alignment.assertions():
            assert a.subject in known, f"alignment subject {a.subject} is not a defined concept"

    def test_the_equity_granularity_mismatch_is_documented_where_it_appears(self):
        """The finding that justified the whole exercise must not be edited out of the record."""
        equity = [a for a in alignment.assertions() if a.subject == "bsi:Equity"]
        assert equity
        assert any("LISTING" in a.rationale.upper() for a in equity)

    def test_the_price_adjustment_gap_is_recorded(self):
        close = [a for a in alignment.assertions() if a.subject == "bsip:close"]
        assert close
        assert any("adjustment_basis" in a.rationale for a in close)

    def test_fibo_curies_expand_into_the_published_iri_space(self):
        for prefix, ns in alignment.FIBO_PREFIXES.items():
            assert ns.startswith("https://spec.edmcouncil.org/fibo/") or "omg.org" in ns, prefix


class TestTheBoundary:
    def test_every_excluded_concept_says_why(self):
        for concept, reason, explanation in alignment.no_counterpart():
            assert reason in {"platform_specific", "out_of_scope", "gap", "unconfirmed"}, reason
            assert explanation.strip().endswith((".", ")", "yet", "session")) or len(explanation) > 40

    def test_excluded_concepts_are_real_concepts(self):
        onto = build_ontology()
        names = {f"bsi:{c.name}" for c in onto.classes}
        for concept, _, _ in alignment.no_counterpart():
            assert concept in names, f"{concept} is listed as having no FIBO counterpart but does not exist"

    def test_a_concept_is_never_both_aligned_and_excluded(self):
        aligned = {a.subject for a in alignment.assertions()}
        excluded = {c for c, _, _ in alignment.no_counterpart()}
        assert not (aligned & excluded), aligned & excluded


class TestStandards:
    def test_every_standard_cites_its_specification_url(self):
        for s in standards.standards():
            assert s.spec_url.startswith("https://"), s.id

    def test_every_standard_records_its_license(self):
        """Publishing a Turtle file that borrows FIBO terms without the MIT notice is a licence bug."""
        for s in standards.standards():
            assert s.license.strip(), s.id

    def test_attribution_required_standards_are_marked(self):
        for s in standards.standards():
            if s.id in {"fibo", "qudt"}:
                assert s.attribution_required, s.id

    def test_the_license_notice_names_the_attribution_required_standards(self):
        notice = standards.license_notice()
        assert "FIBO" in notice and "MIT" in notice

    def test_rejected_alternatives_are_recorded_not_deleted(self):
        """A decision record with no rejected option is indistinguishable from an accident."""
        for s in standards.standards():
            assert s.rejected, s.id

    def test_the_license_notice_is_not_a_claim_of_ownership(self):
        notice = standards.license_notice().lower()
        assert "warranty" in notice or "as is" in notice or "without warranty" in notice