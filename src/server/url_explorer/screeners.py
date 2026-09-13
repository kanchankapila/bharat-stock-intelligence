"""Per-screener instance database from urls-explorer's screener_replicate_helper.md.

One row per (provider, scan_id): 1,624 instances — Trendlyne 986 (GET kayal),
ETnow 529 (POST screener.indiatimes.com 438 + etapi technical-data 91),
MoneyControl 109 (GET proscanner scanner-detail). The endpoint FAMILIES live in
url_endpoints; this table is the instance layer with each screener's captured
payload and taxonomy. ue_status/ue_stocks_count are urls-explorer's own measured
results (external evidence, like verified_json).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from collections import Counter
from pathlib import Path

from . import store

REPO_ROOT = Path(__file__).resolve().parents[3]
HELPER_MD = REPO_ROOT / "screener_replicate_helper.md"
UE_REPORT = REPO_ROOT / "screener_fetch_report_new.csv"


def parse_helper_md(path: Path = HELPER_MD) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    out: list[dict] = []
    for sec in re.split(r"^### Provider:\s*", text, flags=re.MULTILINE)[1:]:
        provider = sec.splitlines()[0].strip()
        for line in sec.splitlines():
            line = line.strip()
            if not line.startswith("| ") or line.startswith("| Screener"):
                continue
            if set(line) <= {"|", "-", " ", ":"}:
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 8:
                continue
            name, sid, cat, sent, tf, ep, qc, desc = cells[:8]
            ep_m = re.search(r"https?://[^\s`|]+", ep)
            out.append({
                "provider": provider, "name": name, "scan_id": sid,
                "category": cat, "sentiment": sent, "timeframe": tf,
                "endpoint": ep_m.group(0) if ep_m else ep.strip("`"),
                "query_condition": qc.strip("`"), "description": desc,
            })
    return out


def load_ue_report(path: Path = UE_REPORT) -> dict[tuple[str, str], dict]:
    out: dict[tuple[str, str], dict] = {}
    with io.open(path, encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            key = ((row.get("provider") or "").strip(),
                   (row.get("scan_id") or "").strip())
            if key == ("", ""):
                continue
            try:
                stocks = int(row.get("stocks_count") or 0)
            except ValueError:
                stocks = None
            out[key] = {"ue_status": (row.get("status") or "").strip(),
                        "ue_stocks_count": stocks}
    return out


def ingest_instances(path: Path = HELPER_MD, report_path: Path = UE_REPORT,
                     apply: bool = False) -> dict:
    instances = parse_helper_md(path)
    report = load_ue_report(report_path) if report_path.exists() else {}
    for inst in instances:
        ue = report.get((inst["provider"], inst["scan_id"]), {})
        inst["ue_status"] = ue.get("ue_status")
        inst["ue_stocks_count"] = ue.get("ue_stocks_count")
    stats = {"instances": len(instances),
             "providers": dict(Counter(i["provider"] for i in instances)),
             "with_ue_result": sum(1 for i in instances if i["ue_status"])}
    if apply:
        store.ensure_schema()
        for inst in instances:
            store.upsert_screener_instance(inst)
        stats["written"] = len(instances)
    return stats, instances


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Ingest the per-screener instance database into screener_instances.")
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    args = ap.parse_args(argv)
    stats, _ = ingest_instances(apply=args.apply)
    mode = "applied" if args.apply else "dry-run"
    print(f"[SCREENERS] {mode}: {stats['instances']} instances"
          f" ({stats.get('written', 0)} written), providers: {stats['providers']},"
          f" with urls-explorer measured result: {stats['with_ue_result']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
