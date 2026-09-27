"""
The published artifacts must be well-formed, complete and internally consistent.

Export is the only place where a mistake becomes *public*: a Turtle file that does not parse, a
SHACL shape with a dangling class reference, or a manifest that advertises a file it did not
write all survive a local edit and only surface in GraphDB, Protege, or a downstream agent.
These tests parse and cross-check rather than snapshot, so a legitimate content change does not
need the fixture rewritten.

Pure stdlib on purpose: Turtle is checked by balanced-delimiter scanning and prefix resolution
rather than rdflib, which is not a dependency of this repo (see requirements.txt -- no new
runtime dependency for an export path).
"""
import json
import os
import re
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ontology import alignment, build_ontology, export, standards  # noqa: E402


@pytest.fixture(scope="module")
def onto():
    return build_ontology()


@pytest.fixture(scope="module")
def artifacts(onto, tmp_path_factory):
    """Build the whole artifact set once and share it across the module."""
    out = tmp_path_factory.mktemp("ontology-export")
    manifest = export.export_all(onto, str(out), coverage={"counts": {"live_tables": 0}})
    blobs = {name: (out / name).read_bytes() for name in export.ARTIFACTS
             if (out / name).exists()}
    return manifest, blobs, out


def _balanced(text):
    """Every opener closed in order, ignoring delimiters inside quotes."""
    pairs = {"<": ">", "[": "]", "{": "}", "(": ")"}
    stack = []
    quote = None
    prev = ""
    for ch in text:
        if quote:
            if ch == quote and prev != "\\":
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch in pairs:
            stack.append(pairs[ch])
        elif ch in ">]})":
            assert stack and stack[-1] == ch, (
                f"unbalanced {ch!r}: expected {stack[-1]!r}" if stack
                else f"unbalanced closing {ch!r}")
            stack.pop()
        prev = ch
    assert not stack, f"unclosed {stack[-1]!r}"


class TestTurtle:
    def test_every_turtle_artifact_is_bracketed(self, artifacts):
        _, blobs, _ = artifacts
        for name in ("ontology.ttl", "ontology.shacl.ttl", "ontology.prov.ttl", "catalog.ttl"):
            _balanced(blobs[name].decode("utf-8"))

    def test_declared_prefixes_resolve_for_every_curie_in_use(self, artifacts):
        """An unresolvable CURIE is the one Turtle error a consumer cannot recover from."""
        _, blobs, _ = artifacts
        text = blobs["ontology.ttl"].decode("utf-8")
        declared = set(re.findall(r"@prefix\s+(\w+):", text))
        assert declared, "no @prefix declarations found"
        used = set(re.findall(r"(?<![\w:/#-])([a-z][a-z0-9]*):[A-Za-z_]", text))
        # The lookbehind must also exclude '-': hyphenated alignment prefixes
        # (fibo-ind-mkt-bas:MarketIndex) would otherwise be misread as a bare
        # `bas:` CURIE, though the full prefix IS declared.
        external = {"xsd", "rdfs", "owl", "skos", "prov", "schema", "rdf"}
        external |= {p for p in used if p.startswith(("fibo-", "cmns-", "qudt", "dcat", "dct"))}
        assert not used - declared - external, (
            f"undeclared prefixes in use: {sorted(used - declared - external)}")

    def test_it_declares_the_fibo_alignment_prefixes(self, artifacts):
        _, blobs, _ = artifacts
        text = blobs["ontology.ttl"].decode("utf-8")
        for prefix in alignment.FIBO_PREFIXES:
            assert f"@prefix {prefix}:" in text, f"{prefix} asserted but never declared"

    def test_every_emitted_alignment_assertion_reaches_the_turtle(self, artifacts):
        """The mapping layer is only useful if it is serialized, not merely importable."""
        _, blobs, _ = artifacts
        text = blobs["ontology.ttl"].decode("utf-8")
        for a in alignment.emitted_assertions():
            assert a.object.split(":", 1)[1] in text, f"{a.object} asserted but absent from ttl"

    def test_an_unverified_alignment_never_reaches_the_artifacts(self, artifacts):
        """The negative control for the FIBO correction: recalled IRIs must stay out.

        Two recalled derivatives IRIs (options, futures) were marked `strength=
        "unverified"` when the published prefixes could not confirm them. The exporter
        filters on `emitted`; if that filter is ever dropped, an unverified mapping becomes
        published fact and a consumer reasons from a class that may not exist.
        """
        _, blobs, _ = artifacts
        text = "\n".join(
            blobs[n].decode("utf-8")
            for n in ("ontology.ttl", "ontology.jsonld", "catalog.ttl", "ontology.md"))
        unverified = [a for a in alignment.assertions() if not a.emitted]
        assert unverified, "no unverified assertions exist — the negative control is vacuous"
        for a in unverified:
            # The FULL CURIE is the identity (same string the positive test greps for);
            # a bare local name would collide with our own class names in prose (the
            # unverified Option IRI vs `OptionChainRow` in the mermaid rendering).
            assert a.object not in text, f"unverified {a.object} leaked into the artifacts"
            assert alignment.fibo(a.object) not in text, (
                f"unverified expanded IRI {alignment.fibo(a.object)} leaked")

    def test_the_alignment_says_what_it_excluded(self, artifacts):
        """The boundary is half the value: unaligned concepts must be recorded, not forgotten."""
        _, blobs, _ = artifacts
        text = blobs["ontology.md"].decode("utf-8")
        for concept, _reason, _why in alignment.no_counterpart():
            assert concept.split(":", 1)[1] in text, f"{concept} unaligned but undocumented"


class TestShacl:
    """SHACL is the one artifact whose value depends on being *loadable*, not just readable."""

    def test_every_node_shape_targets_a_class_that_exists(self, onto, artifacts):
        _, blobs, _ = artifacts
        text = blobs["ontology.shacl.ttl"].decode("utf-8")
        targets = set(re.findall(r"sh:targetClass\s+\w+:(\w+)", text))
        known = {c.name for c in onto.classes}
        assert targets, "no node shapes emitted"
        assert not targets - known, (
            f"SHACL targets classes absent from the ontology: {sorted(targets - known)}")

    def test_it_shapes_every_bound_column_of_a_documented_table(self, onto, artifacts):
        """If the shapes are not derived from the bindings they will drift from the cards."""
        _, blobs, _ = artifacts
        text = blobs["ontology.shacl.ttl"].decode("utf-8")
        shapes = set(re.findall(r"sh:targetNode\s+bsis:(\w+)\.(\w+)", text))
        expected = {(b.table, b.column) for b in onto.bindings}
        assert expected <= shapes, (
            f"{len(expected - shapes)} bound columns have no shape, e.g. "
            f"{sorted(expected - shapes)[:5]}")

    def test_label_columns_are_marked_read_only(self, onto, artifacts):
        """A writable label column is a feature/target mix-up waiting to happen."""
        _, blobs, _ = artifacts
        text = blobs["ontology.shacl.ttl"].decode("utf-8")
        read_only = set(re.findall(
            r"sh:targetNode\s+bsis:\w+\.(\w+)\s*;[^.]*?sh:readOnly\s+true", text, re.S))
        labels = set()
        for card in onto.cards:
            labels.update(onto.label_columns(card.table))
        assert labels <= read_only, (
            f"label columns not read-only in SHACL: {sorted(labels - read_only)[:8]}")


class TestGraphml:
    def test_it_is_parseable_xml_with_matching_edge_refs(self, artifacts):
        import xml.etree.ElementTree as ET

        _, blobs, _ = artifacts
        root = ET.fromstring(blobs["ontology.graphml"].decode("utf-8"))
        ns = {"g": "http://graphml.graphdrawing.org/xmlns"}
        ids = {n.get("id") for n in root.iterfind(".//g:node", ns)}
        refs = [(e.get("source"), e.get("target")) for e in root.iterfind(".//g:edge", ns)]
        assert ids, "no nodes emitted"
        dangling = [r for r in refs if r[0] not in ids or r[1] not in ids]
        assert not dangling, f"{len(dangling)} edges reference a missing node, e.g. {dangling[:3]}"


class TestCypher:
    def test_identity_nodes_are_merged_so_the_script_is_replayable(self, artifacts):
        """`store` output must be idempotent; a bare CREATE makes every rerun grow."""
        _, blobs, _ = artifacts
        text = blobs["ontology.cypher"].decode("utf-8")
        bare = re.findall(r"^MATCH \([^:]+:(Class|Property|Table|Column|Relation|Metric|Term) ",
                          text, re.M)
        assert not bare, f"identity nodes matched but not MERGEd: {sorted(set(bare))}"
        assert len(re.findall(r"^MERGE ", text, re.M)) > 0


class TestMachineReadable:
    def test_markdown_documents_every_class_and_table(self, onto, artifacts):
        _, blobs, _ = artifacts
        text = blobs["ontology.md"].decode("utf-8")
        missing = [c.name for c in onto.classes if c.name not in text]
        assert not missing, f"classes missing from the human artifact: {missing[:10]}"
        missing_tables = [c.table for c in onto.cards if c.table not in text]
        assert not missing_tables, f"tables missing from the human artifact: {missing_tables[:10]}"

    def test_context_binds_the_local_and_alignment_prefixes(self, artifacts):
        """The @context is what lets a downstream consumer substitute the FIBO IRIs."""
        _, blobs, _ = artifacts
        ctx = json.loads(blobs["context.jsonld"].decode("utf-8"))["@context"]
        for prefix in ("bsi", "bsip", "bsir", "bsim", "bsiv", "bsis"):
            assert prefix in ctx, f"@context does not bind {prefix}"
        for prefix in alignment.FIBO_PREFIXES:
            assert prefix in ctx, f"@context does not bind aligned prefix {prefix}"

    def test_jsonld_is_valid_json_and_carries_the_guardrails(self, artifacts):
        _, blobs, _ = artifacts
        data = json.loads(blobs["ontology.jsonld"].decode("utf-8"))
        assert data, "json-ld is not a JSON object"
        assert "guardrail" in json.dumps(data).lower(), (
            "the agent-facing artifact does not carry the leakage guardrails")

    def test_every_curie_used_in_the_jsonld_is_bound_in_the_context(self, artifacts):
        """A term used in the graph but absent from the @context silently degrades to a string."""
        _, blobs, _ = artifacts
        ctx = json.loads(blobs["context.jsonld"].decode("utf-8"))["@context"]
        graph = json.dumps(json.loads(blobs["ontology.jsonld"].decode("utf-8")))
        used = set(re.findall(r'"([a-z][a-z0-9-]*):[A-Za-z]', graph))
        unbound = {u for u in used if u.split(":", 1)[0] not in ctx}
        assert not unbound, f"curies used but not in @context: {sorted(unbound)}"


class TestCatalog:
    def test_it_describes_every_documented_table_as_a_dataset(self, onto, artifacts):
        _, blobs, _ = artifacts
        for name in ("catalog.ttl", "catalog.jsonld"):
            text = blobs[name].decode("utf-8")
            missing = [c.table for c in onto.cards if c.table not in text]
            assert not missing, f"{name} omits {len(missing)} tables, e.g. {missing[:5]}"

    def test_cadence_is_declared_on_every_dataset(self, onto, artifacts):
        """DCAT's whole point is periodicity; a catalog without it is just a table list."""
        _, blobs, _ = artifacts
        text = blobs["catalog.ttl"].decode("utf-8")
        blocks = text.split("bsis:")[1:]
        for card in onto.cards:
            block = next((b for b in blocks if b.startswith(card.table)), "")
            assert "accrualPeriodicity" in block, (
                f"{card.table} has cadence {card.cadence!r} but the catalog states no periodicity")



class TestManifest:
    def test_it_accounts_for_every_artifact(self, artifacts):
        manifest, _, out = artifacts
        written = {row["file"] for row in manifest["files"]}
        on_disk = {n for n in os.listdir(out) if not n.endswith(".pyc")}
        assert written == on_disk, (
            f"manifest/on-disk mismatch: only manifest {written - on_disk}, "
            f"only disk {on_disk - written}")

    def test_each_row_carries_the_hash_of_the_bytes_written(self, artifacts):
        import hashlib

        manifest, blobs, _ = artifacts
        for row in manifest["files"]:
            if row["file"] == "manifest.json":
                continue        # a manifest cannot contain its own hash
            data = blobs[row["file"]]
            assert hashlib.sha256(data).hexdigest() == row["sha256"], row["file"]
            assert len(data) == row["bytes"], row["file"]

    def test_it_records_the_alignment_boundary_not_just_the_assertions(self, artifacts):
        """Publishing 12 mappings without the 17 no-counterparts gives a reader the wrong
        impression of coverage, so the manifest carries both numbers."""
        manifest, _, _ = artifacts
        a = manifest["alignment"]
        assert a["assertions"] >= a["emitted"]
        assert a["no_counterpart"] > 0
        assert len(a["unverified_excluded"]) == a["assertions"] - a["emitted"]

    def test_it_names_every_attribution_required_standard(self, artifacts):
        manifest, _, _ = artifacts
        adopted = set(manifest["standards"])
        required = {s.id for s in standards.standards() if s.attribution_required}
        assert required <= adopted, f"attribution-required standards missing: {required - adopted}"

    def test_it_says_so_when_coverage_was_not_measured(self, onto):
        """A stale coverage.json must not be mistaken for a current verdict."""
        out = tempfile.mkdtemp()
        manifest = export.export_all(onto, out, coverage=None)
        assert manifest["coverage"]["status"] == "unavailable"
        assert not os.path.exists(os.path.join(out, "coverage.json"))


class TestRefusalToExport:
    def test_an_invalid_ontology_is_not_exported(self, onto):
        """The whole safety argument: a published card pointing at a dropped column is worse
        than no card, because a model trusts it. Proved with a real injected defect."""
        from dataclasses import replace

        broken_card = replace(onto.cards[0], freshness_column="column_that_does_not_exist")
        broken = type(onto)(
            version=onto.version,
            classes=onto.classes,
            properties=onto.properties,
            cards=(broken_card,) + onto.cards[1:],
            bindings=onto.bindings,
            relations=onto.relations,
            metrics=onto.metrics,
            vocabularies=onto.vocabularies,
        )
        assert broken.validate(), "the injected defect did not register"
        with pytest.raises(ValueError, match="refusing to export"):
            export.export_all(broken, tempfile.mkdtemp())

    def test_a_manifest_gap_is_named_not_discovered_three_frames_later(self, onto, monkeypatch):
        """Regression: an ARTIFACTS entry with no generator used to fail inside _write with
        `'NoneType' object has no attribute 'replace'` -- naming neither the artifact nor the
        reason, which is how this file's first export run failed."""
        monkeypatch.setattr(export, "ARTIFACTS", export.ARTIFACTS + ("ghost.artifact",))
        with pytest.raises(ValueError, match="ghost.artifact"):
            export.export_all(onto, tempfile.mkdtemp())

    def test_the_cypher_load_script_cannot_destroy_anything(self, artifacts):
        """`ontology.cypher` is handed to `cypher-shell` by a human; a generated script that
        contains DELETE/DROP would be a loaded gun in the one file nobody reads."""
        _, blobs, _ = artifacts
        text = blobs["ontology.cypher"].decode("utf-8").upper()
        for token in ("DROP ", "DELETE ", "DETACH ", "REMOVE "):
            assert token not in text, f"generated load script contains {token.strip()}"


class TestAlignmentIsNotOverclaimed:
    def test_an_unverified_assertion_is_never_exported_as_fact(self, onto, artifacts):
        """The one test in this file that protects the project's credibility: a local concept
        must not be declared equivalent to an external one on memory alone. The FIBO option/futures
        IRIs were exactly that mistake, caught by this mechanism."""
        _, blobs, _ = artifacts
        for name in ("ontology.ttl", "catalog.ttl", "ontology.jsonld"):
            text = blobs[name].decode("utf-8")
            for a in alignment.assertions():
                if not a.emitted:
                    # The FULL CURIE is the published identity; a bare local name
                    # (`Option`) would collide with our own `OptionChainRow` label.
                    assert a.object not in text, (
                        f"{a.subject} -> {a.object} is unverified but was exported as fact")


    def test_cadence_is_declared_on_every_dataset(self, onto, artifacts):
        """DCAT's whole point is periodicity; a catalog without it is just a table list."""
        _, blobs, _ = artifacts
        text = blobs["catalog.ttl"].decode("utf-8")
        blocks = text.split("bsis:")[1:]
        for card in onto.cards:
            block = next((b for b in blocks if b.startswith(card.table)), "")
            assert "accrualPeriodicity" in block, (
                f"{card.table} has cadence {card.cadence!r} but the catalog states no periodicity")

    def test_the_generated_cypher_load_script_cannot_destroy_a_graph(self, onto, artifacts):
        """A generated `neo4j-admin import` script that could DROP or DELETE a graph is a
        foot-gun in a checked-in artifact. The exporter must only ever emit CREATE/MERGE."""
        _, blobs, _ = artifacts
        text = blobs["ontology.cypher"].decode("utf-8").upper()
        for token in ("DROP ", "DELETE ", "DETACH "):
            assert token not in text, f"generated load script contains {token.strip()}"
