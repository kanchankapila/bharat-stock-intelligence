"""CLI: urls.txt -> normalize -> fetch -> store -> profile -> correlate -> report."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import store
from .correlator import correlate_endpoint
from .fetcher import fetch_all
from .normalizer import normalize
from .profiler import profile_endpoint
from .report import render_report
from .returns import load_return_targets


def load_universe() -> set[str]:
    try:
        from db_compat import query_all
        return {r["symbol"].upper() for r in query_all("SELECT symbol FROM nse_stocks")}
    except Exception:
        return set()


def run(urls, universe, fetch_fn=None, returns_by_target=None,
        max_per_endpoint=None, write=True, correlate=True):
    endpoints = normalize(urls, universe)
    if write:
        store.ensure_schema()
    results = fetch_all(endpoints, fetch_fn=fetch_fn, max_per_endpoint=max_per_endpoint)
    by_ep = {id(ep): [] for ep in endpoints}
    for r in results:
        by_ep[id(r.endpoint)].append(r)

    run_at = datetime.now(timezone.utc).isoformat()
    if correlate and returns_by_target is None:
        returns_by_target = load_return_targets() if write else {}

    items = []
    n_fetch = 0
    for ep in endpoints:
        eid = store.upsert_endpoint(ep) if write else 0
        if write:
            store.upsert_params(eid, ep.params)
        ep_results = by_ep[id(ep)]
        n_fetch += len(ep_results)
        if write:
            for r in ep_results:
                store.insert_fetch(eid, r.url, "{}", r.status, r.latency_ms,
                                   r.ok, len(r.body or ""), r.body, r.error)
        prev = store.last_run_field_paths(eid) if write else set()
        profiles = profile_endpoint(ep_results, universe, prev)
        if write:
            for p in profiles:
                store.insert_field(eid, run_at, p)
        cors = []
        if correlate and returns_by_target:
            cors = correlate_endpoint(ep_results, profiles, returns_by_target, universe)
            if write:
                for c in cors:
                    store.insert_correlation(eid, run_at, c)
        n_ok = sum(1 for r in ep_results if r.ok)
        items.append({"endpoint": ep, "n_ok": n_ok, "n_total": len(ep_results),
                      "profiles": profiles, "correlations": cors})

    return {"report": render_report(items), "endpoints": len(endpoints), "fetches": n_fetch}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Explore + catalog third-party data URLs.")
    ap.add_argument("--urls", default=str(Path(__file__).resolve().parents[3] / "urls.txt"))
    ap.add_argument("--normalize-only", action="store_true")
    ap.add_argument("--no-correlate", action="store_true")
    ap.add_argument("--max-per-endpoint", type=int, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    urls = [ln.strip() for ln in Path(args.urls).read_text().splitlines() if ln.strip()]
    universe = load_universe()

    if args.normalize_only:
        eps = normalize(urls, universe)
        print(json.dumps([{"template": e.template, "n_urls": len(e.urls),
                           "params": [(p.name, p.inferred_type, p.is_variable) for p in e.params]}
                          for e in eps], indent=2))
        return 0

    out = run(urls, universe, max_per_endpoint=args.max_per_endpoint,
              write=True, correlate=not args.no_correlate)
    out_path = Path(args.out) if args.out else (
        Path(__file__).resolve().parents[3] / "docs" / "url_explorer"
        / f"report-{datetime.now().date().isoformat()}.md")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(out["report"], encoding="utf-8")
    print(f"[URL-EXPLORER] {out['endpoints']} endpoints, {out['fetches']} fetches. "
          f"Report -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
