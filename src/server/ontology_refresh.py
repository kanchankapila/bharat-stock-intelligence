"""Scheduled entry point for `python -m ontology build --no-export`.

runPython spawns scripts by file path, and `ontology/` uses relative imports, so the package
cannot be launched as `ontology/cli.py` directly. `--no-export` keeps the nightly run from
rewriting docs/ontology/ in the working tree; the export stays a manual `ontology build` step.
Refreshes kg_*, market_data_contract, semantic_feature_definition and the identity graph
(market_issuer/instrument/listing/identifier/identifier_gap/graph_node/graph_edge) -- none of
which had any scheduled writer before 2026-09-30, so their freshness checks could never pass.
"""
import sys

from ontology.cli import main

if __name__ == "__main__":
    sys.exit(main(["build", "--no-export"]))
