"""
Command line: `python -m ontology <command>`.

Run from `src/server` (or with `PYTHONPATH=src/server`):

    python -m ontology verify                    integrity of the layer itself
    python -m ontology build                     verify + export + store + contracts + identity
    python -m ontology export --out ../docs/ontology
    python -m ontology coverage --fresh          drift and freshness vs the live database
    python -m ontology store                     materialize kg_* tables and views
    python -m ontology reset                     drop every kg_* object (our own, always)
    python -m ontology ask "delivery"            lexical concept search
    python -m ontology context "..."             a bounded, caveat-carrying prompt pack
    python -m ontology card stock_ohlcv          what a table is and is not
    python -m ontology identity                  sync canonical issuer/instrument/listing graph

Exit codes: 0 success, 1 verification failure or drift, 2 usage error (argparse). A coverage
report that finds missing tables/columns exits 1, so a cron job or a verify gate can read it.
"""
import argparse
import json
import os
import sys
from typing import List, Optional

from . import ai, alignment, export, introspect, search, standards, store, vocab
from .definitions import build_ontology
from .model import Ontology
from semantic_contracts import sync_ontology_contracts
from semantic_identity import sync_identity

DEFAULT_OUT = os.path.join("..", "docs", "ontology")


def _print(text: str) -> None:
    sys.stdout.write(text.rstrip() + "\n")


def cmd_verify(onto: Ontology, args: argparse.Namespace) -> int:
    issues = onto.validate()
    s = onto.summary()
    _print(f"ontology {onto.version}: {s['classes']} classes, {s['properties']} properties, "
           f"{s['cards']} cards, {s['bindings']} bindings, {s['relations']} relations, "
           f"{s['metrics']} metrics, {s['vocabularies']} vocabularies "
           f"({s['vocabulary_terms']} terms)")
    if issues:
        _print(f"FAIL: {len(issues)} integrity issue(s)")
        for issue in issues:
            _print(f"  - {issue}")
        return 1
    _print("OK: no integrity issues")
    return 0


def cmd_export(onto: Ontology, args: argparse.Namespace) -> int:
    coverage_report = None
    # `--fresh` implies coverage: `build --fresh` used to accept the flag and never run the
    # probe, so the manifest shipped without the very report the flag asks for.
    if getattr(args, "coverage", False) or getattr(args, "fresh", False):
        try:
            coverage_report = introspect.coverage(onto, fresh=getattr(args, "fresh", False))
        except Exception as exc:                  # noqa: BLE001 - export still proceeds
            _print(f"coverage unavailable ({type(exc).__name__}: {exc}); exporting without it")
    manifest = export.export_all(onto, args.out, coverage=coverage_report)
    _print(f"wrote {len(manifest['files'])} artifacts to {args.out}")
    for row in manifest["files"]:
        _print(f"  {row['file']:<22} {row['bytes']:>9,} bytes  {row['sha256'][:12]}")
    return 0


def cmd_build(onto: Ontology, args: argparse.Namespace) -> int:
    rc = cmd_verify(onto, args)
    if rc != 0:
        return rc
    rc = cmd_export(onto, args)
    if rc != 0 or args.no_store:
        return rc
    rc = cmd_store(onto, args)
    if rc != 0:
        return rc
    rc = cmd_contracts(onto, args)
    return rc if rc != 0 else cmd_identity(onto, args)


def cmd_contracts(onto: Ontology, args: argparse.Namespace) -> int:
    result = sync_ontology_contracts(onto=onto)
    _print(
        f"contracts {result['status']}: {result['datasets']} data cards, "
        f"{result['features']} semantic properties"
    )
    return 0 if result["status"] in {"ok", "unavailable"} else 1


def cmd_identity(onto: Ontology, args: argparse.Namespace) -> int:
    result = sync_identity()
    _print(json.dumps(result, indent=2, default=str, sort_keys=True))
    return 0 if result.get("status") in {"ok", "unavailable"} else 1


def cmd_store(onto: Ontology, args: argparse.Namespace) -> int:
    if getattr(args, "dry_run", False):
        # Validate and report what WOULD be written without touching the database. The read-only
        # half (validate + row counting) is the part that catches a broken definition, and it
        # is safe to run against production; the DDL is not.
        issues = onto.validate()
        if issues:
            _print(f"FAIL: {len(issues)} integrity issue(s)")
            for issue in issues:
                _print(f"  - {issue}")
            return 1
        planned = store.plan(onto)
        _print(f"dry run: would sync {planned['total_rows']:,} rows across "
               f"{len(planned['counts'])} tables; {len(store._VIEWS)} views")
        for table, n in sorted(planned["counts"].items()):
            _print(f"  {table:<16} {n:>5}")
        _print("no DDL executed")
        return 0
    try:
        result = store.sync(onto)
    except Exception as exc:                      # noqa: BLE001 - reported with a reason
        _print(f"store failed: {type(exc).__name__}: {exc}")
        return 1
    _print(f"synced {result['rows']:,} rows across {len(result['counts'])} tables; "
           f"{len(result['views'])} views")
    for table, n in sorted(result["counts"].items()):
        _print(f"  {table:<16} {n:>5}")
    return 0


def cmd_reset(onto: Optional[Ontology], args: argparse.Namespace) -> int:
    dropped = store.reset()
    _print(f"dropped {len(dropped)} kg_* tables and their views: {', '.join(dropped)}")
    return 0


def cmd_coverage(onto: Ontology, args: argparse.Namespace) -> int:
    report = introspect.coverage(onto, fresh=args.fresh)
    if args.out:
        introspect.write_coverage(args.out, report)
        _print(f"wrote {args.out}")
    if args.json:
        _print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        c = report["counts"]
        _print(f"schema {report['schema']} @ {report['generated_at']}")
        _print(f"  live tables            {c['live_tables']:,}")
        _print(f"  documented tables      {c['documented_tables']:,} "
               f"(present: {c['documented_tables_present']:,})")
        _print(f"  undocumented tables    {c['undocumented_live_tables']:,}")
        _print(f"  bound columns          {c['bound_columns']:,} "
               f"(missing: {c['missing_columns']})")
        for key, values in report["drift"].items():
            if values:
                _print(f"  DRIFT {key}: {', '.join(map(str, values[:20]))}")
        for f in report["freshness"]:
            _print(f"  freshness {f['table']:<32} {f.get('verdict', '?'):<10} "
                   f"{f.get('value')} (age {f.get('age_hours')}h)")
        _print("OK: no drift" if report["ok"] else "FAIL: documented layer does not match data")
    return 0 if report["ok"] else 1


def cmd_ask(onto: Ontology, args: argparse.Namespace) -> int:
    kinds_arg = getattr(args, "kinds", None)
    limit = getattr(args, "limit", 10)
    kinds = tuple(kinds_arg.split(",")) if kinds_arg else None
    hits = search.search(onto, args.query, kinds=kinds, limit=limit)
    if not hits:
        _print(f"no concept matched {args.query!r}")
        return 1
    for h in hits:
        _print(h.line())
        _print(f"    {h.snippet}")
    return 0


def cmd_context(onto: Ontology, args: argparse.Namespace) -> int:
    question = getattr(args, "question", getattr(args, "query", ""))
    max_chars = getattr(args, "max_chars", 2500)
    report = ai.context_report(onto, question, max_chars=max_chars)
    if getattr(args, "json", False):
        _print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0
    _print(report["pack"])
    _print("")
    _print(f"[{report['chars']} chars; guardrails present: {report['guardrails_present']}]")
    return 0


def cmd_card(onto: Ontology, args: argparse.Namespace) -> int:
    max_chars = getattr(args, "max_chars", 2500)
    _print(ai.data_card_text(onto, args.table, max_chars=max_chars))
    return 0 if onto.card_by_table(args.table) else 1


def cmd_show(onto: Ontology, args: argparse.Namespace) -> int:
    max_chars = getattr(args, "max_chars", 2500)
    names = getattr(args, "names", None) or [getattr(args, "name")]
    for name in names:
        _print(ai.describe(onto, name, max_chars=max_chars))
        _print("")
    return 0


def cmd_standards(onto: Ontology, args: argparse.Namespace) -> int:
    _print(export.standards_txt())
    return 0


def cmd_stats(onto: Ontology, args: argparse.Namespace) -> int:
    s = onto.summary()
    report = {
        "version": onto.version,
        "base_uri": vocab.BASE_URI,
        "layers": list(vocab.LAYERS),
        **s,
        "guardrails": len(ai.GUARDRAILS),
        "standards": list(standards.adopted_ids()),
        "alignment": {
            "assertions": len(alignment.assertions()),
            "emitted": len(alignment.emitted_assertions()),
            "unverified": len([a for a in alignment.assertions() if not a.emitted]),
            "no_counterpart": len(alignment.no_counterpart()),
        },
    }
    _print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0




def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ontology",
        description="Semantic layer over the bharat_intel market database.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command")

    sub.add_parser("verify", help="check the layer's integrity (no database needed)")
    sub.add_parser("stats", help="counts, standards and alignment as JSON")
    sub.add_parser("standards", help="the adopted standards stack and their licenses")
    sub.add_parser("contracts", help="materialize ontology data/feature contracts when the migration is installed")
    sub.add_parser("identity", help="synchronize issuer/instrument/listing/provider identities")

    e = sub.add_parser("export", help="write every artifact")
    e.add_argument("--out", default=DEFAULT_OUT)
    e.add_argument("--coverage", action="store_true",
                   help="include a live coverage report in manifest.json")
    e.add_argument("--fresh", action="store_true", help="probe freshness during coverage")

    b = sub.add_parser("build", help="verify, export, and materialize into Postgres")
    b.add_argument("--out", default=DEFAULT_OUT)
    b.add_argument("--no-store", action="store_true", help="skip the database write")
    b.add_argument("--fresh", action="store_true", help="probe freshness during coverage")
    b.set_defaults(coverage=True)

    st = sub.add_parser("store", help="create/refresh the kg_* tables and views")
    st.add_argument("--dry-run", action="store_true",
                    help="validate and report the row counts without executing any DDL")
    sub.add_parser("reset", help="drop every kg_* object created by `store`")

    c = sub.add_parser("coverage", help="diff the layer against the live database")
    c.add_argument("--fresh", action="store_true", help="run SELECT max(freshness_column)")
    c.add_argument("--json", action="store_true")
    c.add_argument("--out", help="also write coverage.json here")

    a = sub.add_parser("ask", help="lexical search over every concept")
    a.add_argument("query")
    a.add_argument("--kinds", help="comma-separated: " + ",".join(search.KINDS))
    a.add_argument("--limit", type=int, default=10)

    x = sub.add_parser("context", help="a bounded, caveat-carrying prompt pack")
    x.add_argument("question")
    x.add_argument("--max-chars", type=int, default=2500)
    x.add_argument("--json", action="store_true")

    d = sub.add_parser("card", help="the data card for one table")
    d.add_argument("table")
    d.add_argument("--max-chars", type=int, default=2500)

    s = sub.add_parser("show", help="describe concepts by name")
    s.add_argument("names", nargs="+")
    s.add_argument("--max-chars", type=int, default=2500)
    return p


_COMMANDS = {
    "verify": cmd_verify,
    "stats": cmd_stats,
    "standards": cmd_standards,
    "contracts": cmd_contracts,
    "identity": cmd_identity,
    "export": cmd_export,
    "build": cmd_build,
    "store": cmd_store,
    "reset": cmd_reset,
    "coverage": cmd_coverage,
    "ask": cmd_ask,
    "context": cmd_context,
    "card": cmd_card,
    "show": cmd_show,
}


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    if args.command == "reset":
        return cmd_reset(None, args)
    onto = build_ontology()
    return _COMMANDS[args.command](onto, args)


if __name__ == "__main__":                        # pragma: no cover - module entry point
    raise SystemExit(main())
