"""Consolidate every scattered URL inventory into the url_endpoints catalog.

Sources (repo root): urls.normalized.txt, updated_urls.json, updated_urls_verified.json,
detailed_uls.json, ai_endpoint_memory.json, et_screeners.json,
et-marketstats-post-requests.json. Enrichment joins ai_endpoint_registry rows by
structural key (host + path-segment count + sorted query keys), so a registry template
with {placeholder} values matches the concrete corpus URLs it was derived from.
Dry-run by default: pass --apply to write.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from .explore import load_universe
from .normalizer import (
    EndpointTemplate,
    ParamSpec,
    _path_segments,
    _structural_key,
    classify_value,
    normalize,
)
from . import store

REPO_ROOT = Path(__file__).resolve().parents[3]

# First source that names a provider/category/description wins the slot; later sources
# only fill gaps. ai_endpoint_memory is the richest (provider + category + harmonized
# targets), urls.normalized.txt carries no metadata at all.
_SOURCE_PRECEDENCE = (
    "ai_endpoint_memory.json",
    "detailed_uls.json",
    "updated_urls_verified.json",
    "updated_urls.json",
    "urls.normalized.txt",
)


@dataclass
class SourceRecord:
    url: str
    source: str
    ref: str | None = None
    provider: str | None = None
    category: str | None = None
    description: str | None = None
    feature_targets: tuple[str, ...] = ()


@dataclass
class PostRequestGroup:
    url: str
    source: str
    requests: list[dict]


@dataclass
class CatalogEntry:
    endpoint: EndpointTemplate
    meta: dict = field(default_factory=lambda: {
        "provider": None, "category": None, "description": None,
        "feature_targets": set(), "sources": set(), "refs": set(), "verified": None,
    })


def load_json_records() -> list[SourceRecord]:
    records: list[SourceRecord] = []

    memory = json.loads((REPO_ROOT / "ai_endpoint_memory.json").read_text(encoding="utf-8"))
    for row in memory:
        url = str(row.get("url") or "").strip()
        if not url:
            continue
        records.append(SourceRecord(
            url=url, source="ai_endpoint_memory.json",
            ref=str(row.get("id")) if row.get("id") else None,
            provider=row.get("provider"), category=row.get("category"),
            description=row.get("description"),
            feature_targets=tuple(str(t) for t in row.get("harmonizedFields") or ())))

    for row in json.loads((REPO_ROOT / "detailed_uls.json").read_text(encoding="utf-8")):
        url = str(row.get("url") or "").strip()
        if not url:
            continue
        records.append(SourceRecord(
            url=url, source="detailed_uls.json", provider=row.get("provider"),
            category=row.get("category"), description=row.get("description")))

    for name in ("updated_urls_verified.json", "updated_urls.json"):
        for row in json.loads((REPO_ROOT / name).read_text(encoding="utf-8")):
            url = str(row.get("url") or "").strip()
            if not url:
                continue
            records.append(SourceRecord(url=url, source=name,
                                        description=row.get("description")))

    for line in (REPO_ROOT / "urls.normalized.txt").read_text(encoding="utf-8").splitlines():
        url = line.strip()
        if url:
            records.append(SourceRecord(url=url, source="urls.normalized.txt"))

    order = {s: i for i, s in enumerate(_SOURCE_PRECEDENCE)}
    records.sort(key=lambda r: order.get(r.source, len(order)))
    return records


def _payload_of(item: dict) -> dict:
    body = item.get("request") or {}
    payload = body.get("payload")
    if payload is None and body.get("postData"):
        try:
            payload = json.loads(body["postData"])
        except ValueError:
            payload = None
    return payload if isinstance(payload, dict) else {}


def load_post_groups() -> list[PostRequestGroup]:
    groups: list[PostRequestGroup] = []
    for name in ("et_screeners.json", "et-marketstats-post-requests.json"):
        doc = json.loads((REPO_ROOT / name).read_text(encoding="utf-8"))
        by_url: dict[str, list[dict]] = {}
        for item in doc.get("requests", []):
            url = str((item.get("request") or {}).get("url") or "").strip()
            if not url:
                continue
            by_url.setdefault(url, []).append(
                {"payload": _payload_of(item), "label": item.get("label")})
        for url, reqs in by_url.items():
            groups.append(PostRequestGroup(url=url, source=name, requests=reqs))
    return groups


def _repair_url(tok: str) -> tuple[str, bool]:
    tok2 = re.sub(r"^(https?):/+", lambda m: m.group(1) + "://", tok)
    sp = urlsplit(tok2)
    repaired = tok2 != tok or "//" in sp.path
    if "//" in sp.path:
        tok2 = urlunsplit((sp.scheme, sp.netloc,
                           re.sub(r"/{2,}", "/", sp.path), sp.query, sp.fragment))
    return tok2, repaired


def split_url_line(line: str) -> tuple[list[str], int]:
    urls: list[str] = []
    repaired = 0
    for tok in line.split():
        if not tok.lower().startswith("http"):
            continue
        fixed, was = _repair_url(tok)
        repaired += 1 if was else 0
        urls.append(fixed)
    return urls, repaired


def load_unique_urls(path: Path | None = None) -> tuple[list[SourceRecord], int]:
    src = path or (REPO_ROOT / "unique_urls.txt")
    if not src.exists():
        return [], 0
    records: list[SourceRecord] = []
    repaired = 0
    for line in src.read_text(encoding="utf-8", errors="replace").splitlines():
        urls, n = split_url_line(line)
        repaired += n
        records.extend(SourceRecord(url=u, source="unique_urls.txt") for u in urls)
    return records, repaired


def load_verification_evidence(catalog_path: Path) -> tuple[dict, int]:
    """Per-URL HTTP status from the datasource_catalog.md evidence file."""
    text = catalog_path.read_text(encoding="utf-8", errors="replace")
    verified: dict[str, int | None] = {}
    n_err = 0
    for block in text.split("\n### ")[1:]:
        m_url = re.search(r"\*\*URL:\*\* (.+)", block)
        if not m_url:
            continue
        m_st = re.search(r"\*\*HTTP status:\*\* `(\d+)`", block)
        urls, _ = split_url_line(m_url.group(1))
        if not m_st:
            n_err += len(urls)
        for u in urls:
            verified[u] = int(m_st.group(1)) if m_st else None
    return verified, n_err


def _record_key(url: str) -> str:
    sp = urlsplit(url)
    qkeys = [k for k, _ in parse_qsl(sp.query, keep_blank_values=True)]
    return _structural_key(sp.netloc, _path_segments(sp.path), qkeys)


def _template_endpoint(tpl: str, method: str) -> EndpointTemplate:
    sp = urlsplit(tpl)
    q = parse_qsl(sp.query, keep_blank_values=True)
    params = [ParamSpec(k, "query",
                        "string" if v.startswith("{") and v.endswith("}") else "const",
                        v.startswith("{") and v.endswith("}"), 0, [v])
              for k, v in q]
    return EndpointTemplate(
        template=tpl, host=sp.netloc, path_skeleton=sp.path or "/",
        query_keys=sorted({k for k, _ in q}), method=(method or "GET").upper(),
        params=params, urls=[tpl])


def _post_endpoint(group: PostRequestGroup, universe: set[str]) -> EndpointTemplate:
    sp = urlsplit(group.url)
    segs = _path_segments(sp.path)
    skeleton = "/" + "/".join(segs) + ("/" if segs else "")
    vals: dict[str, list[str]] = {}
    for req in group.requests:
        for k, v in (req.get("payload") or {}).items():
            vals.setdefault(str(k), []).append("" if v is None else str(v))
    params = []
    for k in sorted(vals):
        distinct = sorted(set(vals[k]))
        variable = len(distinct) > 1
        params.append(ParamSpec(
            k, "body", classify_value(distinct[0], universe) if variable else "const",
            variable, len(distinct), distinct[:5]))
    return EndpointTemplate(
        template=group.url, host=sp.netloc, path_skeleton=skeleton,
        query_keys=[], method="POST", params=params,
        # urls is only read for its length here (n_urls = captured requests collapsed
        # into this endpoint); ingest never fetches, so duplicates are harmless.
        urls=[group.url] * len(group.requests))


def build_catalog(records: list[SourceRecord], post_groups: list[PostRequestGroup],
                  universe: set[str], registry_entries: list[dict] = (),
                  verified: dict | None = None) -> dict[str, CatalogEntry]:
    corpus = [r.url for r in records if r.url]
    ep_by_key: dict[str, EndpointTemplate] = {}
    for ep in normalize(corpus, universe):
        if ep.urls:
            ep_by_key[_record_key(ep.urls[0])] = ep

    catalog: dict[str, CatalogEntry] = {}

    def _entry(ep: EndpointTemplate) -> CatalogEntry:
        return catalog.setdefault(ep.template, CatalogEntry(endpoint=ep))

    for rec in records:
        ep = ep_by_key.get(_record_key(rec.url))
        if ep is None:
            continue
        m = _entry(ep).meta
        for slot, value in (("provider", rec.provider), ("category", rec.category)):
            if value and not m[slot]:
                m[slot] = value
        if rec.description and (not m["description"] or len(rec.description) > len(m["description"])):
            m["description"] = rec.description
        m["feature_targets"].update(rec.feature_targets)
        m["sources"].add(rec.source)
        if rec.ref:
            m["refs"].add(rec.ref)

    for reg in registry_entries:
        tpl = str(reg.get("url_template") or "").strip()
        if not tpl:
            continue
        ep = ep_by_key.get(_record_key(tpl))
        if ep is None:
            ep = _template_endpoint(tpl, str(reg.get("http_method") or "GET"))
        m = _entry(ep).meta
        for slot in ("provider", "category"):
            value = reg.get(slot)
            if value and not m[slot]:
                m[slot] = value
        targets = reg.get("feature_targets_json") or []
        if isinstance(targets, str):
            try:
                targets = json.loads(targets)
            except ValueError:
                targets = []
        m["feature_targets"].update(str(t) for t in targets)
        m["sources"].add("ai_endpoint_registry")
        if reg.get("endpoint_name"):
            m["refs"].add(reg["endpoint_name"])

    for group in post_groups:
        ep = _post_endpoint(group, universe)
        m = _entry(ep).meta
        m["sources"].add(group.source)
        if not m["description"]:
            labels = [r.get("label") for r in group.requests if r.get("label")]
            m["description"] = (f"{len(group.requests)} captured POST requests"
                                + (f"; e.g. {labels[0]}" if labels else ""))

    if verified:
        for url, status in verified.items():
            ep = ep_by_key.get(_record_key(url))
            if ep is None:
                continue
            entry = _entry(ep)
            v = entry.meta["verified"] or {"n": 0, "ok": 0, "non200": {}, "errors": 0}
            v["n"] += 1
            if status == 200:
                v["ok"] += 1
            elif status is None:
                v["errors"] += 1
            else:
                v["non200"][str(status)] = v["non200"].get(str(status), 0) + 1
            entry.meta["verified"] = v
    return catalog


def apply_catalog(catalog: dict[str, CatalogEntry]) -> int:
    store.ensure_schema()
    written = 0
    for entry in catalog.values():
        eid = store.upsert_endpoint(entry.endpoint)
        store.upsert_params(eid, entry.endpoint.params)
        m = entry.meta
        store.update_endpoint_meta(
            eid, provider=m["provider"], category=m["category"],
            description=m["description"], feature_targets=sorted(m["feature_targets"]),
            sources=sorted(m["sources"]), refs=sorted(m["refs"]),
            verified=m["verified"])
        written += 1
    return written


def _existing_templates() -> set[str]:
    from db_compat import query_all
    try:
        return {r["template"] for r in query_all("SELECT template FROM url_endpoints")}
    except Exception:
        return set()


def load_registry_entries() -> list[dict]:
    from db_compat import query_all
    try:
        rows = query_all(
            "SELECT endpoint_name, provider, category, http_method, url_template,"
            " feature_targets_json FROM ai_endpoint_registry"
            " WHERE url_template IS NOT NULL AND url_template <> ''")
    except Exception:
        return []
    return [dict(r) for r in rows]


def consolidate(records, post_groups, universe, registry_entries, apply: bool = False,
                verified: dict | None = None):
    catalog = build_catalog(records, post_groups, universe, registry_entries, verified)
    existing = _existing_templates()
    source_counts: dict[str, int] = {}
    for r in records:
        source_counts[r.source] = source_counts.get(r.source, 0) + 1
    for g in post_groups:
        source_counts[g.source] = source_counts.get(g.source, 0) + len(g.requests)
    sources = {s: {"records": n,
                   "templates": sum(1 for e in catalog.values() if s in e.meta["sources"])}
               for s, n in sorted(source_counts.items())}
    written = apply_catalog(catalog) if apply else 0
    stats = {"entries": len(catalog), "new": sum(1 for t in catalog if t not in existing),
             "written": written, "sources": sources}
    report = render_consolidation_report(catalog, stats, existing, applied=apply)
    return report, stats


def render_consolidation_report(catalog, stats, existing, applied: bool) -> str:
    entries = sorted(catalog.values(), key=lambda e: e.endpoint.template)

    target_providers: dict[str, set[str]] = {}
    for e in entries:
        holder = e.meta["provider"] or e.endpoint.host
        for t in e.meta["feature_targets"]:
            target_providers.setdefault(t, set()).add(holder)
    spofs = sorted(t for t, p in target_providers.items() if len(p) == 1)
    redundant = sorted((t, p) for t, p in target_providers.items() if len(p) > 1)

    enriched = sum(1 for e in entries if e.meta["provider"])
    targeted = sum(1 for e in entries if e.meta["feature_targets"])
    head = ("# URL catalog consolidation report\n\n"
            f"Generated {datetime.now(timezone.utc).isoformat()} — "
            f"{'APPLIED to the database' if applied else 'DRY RUN (nothing written)'}\n\n"
            f"- catalog entries: **{stats['entries']}** "
            f"({stats['new']} not previously in `url_endpoints`)\n"
            f"- rows written this run: {stats['written']}\n\n"
            "## Per-source contribution\n\n"
            "| source | records | templates represented |\n|---|---:|---:|\n")
    lines = [head]
    for s, c in stats["sources"].items():
        lines.append(f"| `{s}` | {c['records']} | {c['templates']} |")
    lines += [
        "",
        "## Enrichment coverage",
        "",
        f"- endpoints with a named provider: {enriched}/{len(entries)}",
        f"- endpoints with feature targets (the alternate-lookup key): {targeted}/{len(entries)}",
        "",
    ]
    vrows = [e for e in entries if e.meta["verified"]]
    if vrows:
        v_n = sum(e.meta["verified"]["n"] for e in vrows)
        v_ok = sum(e.meta["verified"]["ok"] for e in vrows)
        v_non = sum(sum(e.meta["verified"]["non200"].values()) for e in vrows)
        v_err = sum(e.meta["verified"]["errors"] for e in vrows)
        dead = [e for e in vrows if e.meta["verified"]["ok"] == 0]
        lines += [
            "## External verification evidence",
            "",
            f"- URLs with recorded status: {v_n} (HTTP 200: {v_ok}, non-200: {v_non},"
            f" request errors: {v_err})",
            f"- templates with ZERO HTTP-200 evidence ({len(dead)}) — treat as"
            " access-controlled or retired, not empty:",
            "",
        ]
        lines += [f"- `{e.endpoint.template}` — {e.meta['verified']['non200'] or 'request errors'}"
                  for e in dead[:30]]
        if len(dead) > 30:
            lines.append(f"- … +{len(dead) - 30} more")
        lines += [""]
    new_entries = [e for e in entries if e.endpoint.template not in existing]
    preview = new_entries[:50]
    lines += [f"## New catalog entries ({len(new_entries)})", ""]
    lines += [f"- `{e.endpoint.template}` — {e.meta['provider'] or 'unknown provider'},"
              f" n_urls={len(e.endpoint.urls)}, sources={sorted(e.meta['sources'])}"
              for e in preview]
    if len(new_entries) > len(preview):
        lines.append(f"- … +{len(new_entries) - len(preview)} more")
    lines += [
        "",
        "## Single-provider feature targets — NO alternate exists",
        "",
    ]
    lines += [f"- `{t}` — only {sorted(target_providers[t])[0]}" for t in spofs]
    if not spofs:
        lines.append("- none")
    lines += ["", "## Multi-provider feature targets — alternates available", ""]
    lines += [f"- `{t}` — {', '.join(sorted(p))}" for t, p in redundant]
    if not redundant:
        lines.append("- none")
    return "\n".join(lines) + "\n"


def find_alternates(targets, exclude: str | None = None, limit: int = 15) -> list[dict]:
    from db_compat import query_all
    wanted = {t.strip() for t in targets if t.strip()}
    rows = query_all(
        "SELECT template, method, provider, category, description, n_urls,"
        " last_run_at, last_status, feature_targets_json, refs_json"
        " FROM url_endpoints WHERE feature_targets_json IS NOT NULL")
    ranked = []
    for r in rows:
        if exclude and exclude in r["template"]:
            continue
        try:
            held = set(json.loads(r["feature_targets_json"]))
        except (TypeError, ValueError):
            continue
        overlap = wanted & held
        if not overlap:
            continue
        refs = json.loads(r["refs_json"]) if r["refs_json"] else []
        ranked.append({
            "overlap": sorted(overlap), "provider": r["provider"], "method": r["method"],
            "template": r["template"], "category": r["category"],
            "description": r["description"], "n_urls": r["n_urls"],
            "last_run_at": r["last_run_at"], "last_status": r["last_status"],
            "registry_refs": refs,
        })
    ranked.sort(key=lambda x: (-len(x["overlap"]), -len(x["registry_refs"]),
                               -x["n_urls"], x["template"]))
    return ranked[:limit]


def load_ue_successes() -> list[SourceRecord]:
    """urls-explorer's proven-success URLs (successful_urls.csv 528 + report_success.csv
    407, union after dedupe): every one returned HTTP 200 there with real query values.
    Ingested so the catalog samples THESE concrete URLs (they are the mechanism-proof
    requests), not phantom shape-variants."""
    import csv
    import io

    records: list[SourceRecord] = []
    seen: set[str] = set()
    for name in ("successful_urls.csv", "report_success.csv"):
        path = REPO_ROOT / name
        if not path.exists():
            continue
        with io.open(path, encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                url = (row.get("url") or "").strip()
                if not url or url in seen:
                    continue
                seen.add(url)
                records.append(SourceRecord(
                    url=url, source=f"urls-explorer/{name}",
                    provider=row.get("portal"), category=row.get("category"),
                    description=row.get("description")))
    return records


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Consolidate URL inventories into url_endpoints.")
    ap.add_argument("--apply", action="store_true", help="write to the database (default: dry run)")
    ap.add_argument("--out", default=None, help="report path (default docs/url_explorer/)")
    ap.add_argument("--find-alternates", default=None,
                    help="comma-separated feature targets; prints ranked alternates and exits")
    ap.add_argument("--exclude", default=None, help="skip templates containing this substring")
    ap.add_argument("--catalog", default=None,
                    help="datasource_catalog.md path; aggregates per-URL HTTP evidence")
    ap.add_argument("--limit", type=int, default=15)
    args = ap.parse_args(argv)

    if args.find_alternates:
        rows = find_alternates([t.strip() for t in args.find_alternates.split(",") if t.strip()],
                               exclude=args.exclude, limit=args.limit)
        print(json.dumps(rows, indent=2))
        return 0

    records = load_json_records()
    uniq, repaired = load_unique_urls()
    records.extend(uniq)
    ue_successes = load_ue_successes()
    records.extend(ue_successes)
    verified = {r.url: 200 for r in ue_successes}  # proven 200 in urls-explorer's runs
    if args.catalog:
        cat_verified, _ = load_verification_evidence(Path(args.catalog))
        for u, st in cat_verified.items():
            verified.setdefault(u, st)
    report, stats = consolidate(records, load_post_groups(), load_universe(),
                                load_registry_entries(), apply=args.apply,
                                verified=verified)
    print(f"[URL-CATALOG] unique_urls.txt: {len(uniq)} records ({repaired} repaired);"
          f" urls-explorer proven-success URLs: {len(ue_successes)};"
          f" evidence URLs: {len(verified)}")
    default_out = (REPO_ROOT / "docs" / "url_explorer"
                   / f"consolidation_report_{datetime.now(timezone.utc).date().isoformat()}.md")
    out_path = Path(args.out) if args.out else default_out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report, encoding="utf-8")
    print(f"[URL-CATALOG] {'applied' if args.apply else 'dry-run'}: "
          f"{stats['entries']} entries ({stats['new']} new). Report -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

