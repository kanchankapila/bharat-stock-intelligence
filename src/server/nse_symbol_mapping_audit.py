"""Audit canonical NSE symbols against NSE's current master and symbol-change archive."""

from __future__ import annotations

import csv
import datetime as dt
import argparse
import io
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import requests

from db_compat import connect
from fetch_utils import retry_get
from nse_equity_master_fetcher import EQUITY_MASTER_URL, HEADERS, parse_equity_master
from semantic_evidence import record_dataset_watermark

SYMBOL_CHANGE_URL = "https://nsearchives.nseindia.com/content/equities/symbolchange.csv"
MIN_SYMBOL_CHANGES = 500
ROOT = Path(__file__).resolve().parents[2]
PROVIDER_FIELDS = (
    "mcsymbol", "tlid", "stockid", "companyid", "tickertape_sid", "fincode", "scripcode",
)


def _date(value: str) -> dt.date:
    value = value.strip()
    for pattern in ("%d-%b-%Y", "%d-%b-%y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(value.upper(), pattern).date()
        except ValueError:
            pass
    raise ValueError(f"invalid NSE symbol-change date: {value!r}")


def parse_symbol_changes(text: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(text))
    expected = {"NAME OF THE COMPANY", "OLD SYMBOL", "NEW SYMBOL", "EFFECTIVE DATE"}
    headers = {str(name or "").strip().upper() for name in (reader.fieldnames or [])}
    if not expected.issubset(headers):
        raise ValueError(f"NSE symbol-change columns missing: {sorted(expected - headers)}")

    rows = []
    for raw in reader:
        row = {str(k or "").strip().upper(): str(v or "").strip() for k, v in raw.items()}
        old_symbol = row.get("OLD SYMBOL", "").upper()
        new_symbol = row.get("NEW SYMBOL", "").upper()
        if not old_symbol or not new_symbol:
            continue
        rows.append({
            "name": row.get("NAME OF THE COMPANY", ""),
            "old_symbol": old_symbol,
            "new_symbol": new_symbol,
            "effective_date": _date(row.get("EFFECTIVE DATE", "")),
        })
    if len(rows) < MIN_SYMBOL_CHANGES:
        raise ValueError(f"NSE symbol-change archive incomplete: {len(rows)} rows")
    return rows


def resolve_current_symbol(symbol: str, changes: list[dict[str, Any]], current: set[str]) -> str | None:
    """Follow the latest known alias chain, returning a symbol only if NSE lists it now."""
    latest: dict[str, tuple[dt.date, str]] = {}
    for row in changes:
        old, new = row["old_symbol"], row["new_symbol"]
        if old not in latest or row["effective_date"] > latest[old][0]:
            latest[old] = (row["effective_date"], new)
    seen: set[str] = set()
    candidate = symbol.strip().upper()
    while candidate in latest:
        if candidate in seen:
            return None
        seen.add(candidate)
        candidate = latest[candidate][1]
    return candidate if candidate in current else None


def _load_json_array(path: Path) -> list[dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_ts_array(path: Path, marker: str) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    start = text.index("[", text.index("=", text.index(marker)))
    end = text.index("];", start)
    return json.loads(text[start:end + 1])


def _static_sources() -> dict[str, list[dict[str, Any]]]:
    return {
        "stocklist.ts": _load_ts_array(ROOT / "src/data/stocklist.ts", "const stockData"),
        "stocklist.json": _load_json_array(ROOT / "scripts/stocklist.json"),
        "stocklist.js": _load_ts_array(ROOT / "scripts/stocklist.js", "var stockData"),
        "nseStocks.ts": _load_ts_array(ROOT / "src/data/nseStocks.ts", "const nseStocksSeedData"),
        "et_mappings.json": _load_json_array(ROOT / "scripts/et_mappings.json"),
        "finology_mappings.json": _load_json_array(ROOT / "scripts/finology_mappings.json"),
        "tlid_mapping.csv": list(csv.DictReader((ROOT / "tlid_mapping.csv").open(encoding="utf-8", newline=""))),
    }


def _value(value: Any) -> str:
    return str(value or "").strip().upper()


def build_audit(
    equity_rows: list[dict[str, Any]], changes: list[dict[str, Any]], master_rows: list[dict[str, Any]],
    static_sources: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    current = {row["symbol"].strip().upper() for row in equity_rows}
    official_by_symbol = {row["symbol"].strip().upper(): row for row in equity_rows}
    by_symbol = {str(row["symbol"]).strip().upper(): row for row in master_rows}
    active = {symbol for symbol, row in by_symbol.items() if _value(row.get("status")) == "ACTIVE"}
    findings: list[dict[str, str]] = []
    stocklist_by_symbol: dict[str, dict[str, Any]] = {}
    source_identifier_fields = {
        "stocklist.ts": PROVIDER_FIELDS,
        "stocklist.json": PROVIDER_FIELDS,
        "stocklist.js": PROVIDER_FIELDS,
        "et_mappings.json": ("companyid",),
        "finology_mappings.json": ("fincode", "scripcode"),
        "tlid_mapping.csv": ("tlid",),
    }

    for source, rows in static_sources.items():
        for row in rows:
            symbol = _value(row.get("symbol"))
            if not symbol:
                continue
            if source == "stocklist.ts":
                stocklist_by_symbol[symbol] = row
            target = resolve_current_symbol(symbol, changes, current)
            if target and target != symbol:
                findings.append({"kind": "stale_ticker", "source": source, "symbol": symbol,
                                 "expected_symbol": target})
            if symbol in current:
                for field in source_identifier_fields.get(source, ()):
                    left = _value(row.get(field))
                    right = _value(by_symbol.get(symbol, {}).get(field))
                    if left and right and left != right:
                        findings.append({"kind": "provider_id_mismatch", "source": source,
                                         "symbol": symbol, "field": field, "static": left,
                                         "nse_stocks": right, "verification": "provider not queried"})
                static_isin = _value(row.get("isin"))
                official = official_by_symbol.get(symbol)
                if static_isin and official and static_isin != _value(official.get("isin")):
                    findings.append({"kind": "isin_mismatch", "source": source, "symbol": symbol,
                                     "static": static_isin, "official": _value(official.get("isin"))})

    for symbol in sorted((active & current) - set(stocklist_by_symbol)):
        findings.append({"kind": "missing_static_mapping", "source": "stocklist.ts", "symbol": symbol})

    for symbol in sorted(current - active):
        row = by_symbol.get(symbol)
        reason = _value((row or {}).get("admission_reason")) or "no nse_stocks row"
        findings.append({"kind": "nse_master_not_active", "source": "nse_stocks", "symbol": symbol,
                         "detail": reason})
    for symbol in sorted(active - current):
        findings.append({"kind": "active_absent_from_nse_master", "source": "nse_stocks", "symbol": symbol})

    for symbol in sorted(active & current):
        db_row = by_symbol[symbol]
        official = official_by_symbol.get(symbol)
        if official:
            if _value(db_row.get("isin")) and _value(db_row.get("isin")) != _value(official.get("isin")):
                findings.append({"kind": "isin_mismatch", "source": "nse_stocks", "symbol": symbol,
                                 "stored": _value(db_row.get("isin")), "official": _value(official.get("isin"))})
            if _value(db_row.get("name")) and _value(db_row.get("name")) != _value(official.get("name")):
                findings.append({"kind": "name_mismatch", "source": "nse_stocks", "symbol": symbol,
                                 "stored": _value(db_row.get("name")), "official": _value(official.get("name"))})

        static = stocklist_by_symbol.get(symbol)
        if static:
            for field in PROVIDER_FIELDS:
                left, right = _value(static.get(field)), _value(db_row.get(field))
                if left and right and left != right:
                    findings.append({"kind": "provider_id_mismatch", "source": "stocklist.ts",
                                     "symbol": symbol, "field": field, "static": left, "nse_stocks": right,
                                     "verification": "provider not queried"})

    for field in ("mcsymbol", "tlid"):
        owners: dict[str, list[str]] = defaultdict(list)
        for symbol in active:
            value = _value(by_symbol[symbol].get(field))
            if value:
                owners[value].append(symbol)
        for value, symbols in owners.items():
            if len(symbols) > 1:
                findings.append({"kind": "duplicate_provider_id", "source": "nse_stocks",
                                 "field": field, "identifier": value, "symbols": ",".join(sorted(symbols))})

    counts = Counter(item["kind"] for item in findings)
    latest_change = max((row["effective_date"] for row in changes), default=None)
    return {
        "status": "partial" if findings else "complete",
        "equity_master_symbols": len(current),
        "symbol_change_rows": len(changes),
        "symbol_change_latest_effective_date": latest_change.isoformat() if latest_change else None,
        "active_master_symbols": len(active),
        "static_source_rows": {source: len(rows) for source, rows in sorted(static_sources.items())},
        "finding_counts": dict(sorted(counts.items())),
        "findings": findings,
        "provider_ids_live_verified": False,
    }


def run_audit(persist: bool = True) -> dict[str, Any]:
    equity_response = retry_get(requests, EQUITY_MASTER_URL, headers=HEADERS, timeout=30)
    equity_rows = parse_equity_master(equity_response.text)
    change_response = retry_get(requests, SYMBOL_CHANGE_URL, headers=HEADERS, timeout=30)
    changes = parse_symbol_changes(change_response.text)

    with connect() as conn:
        master_rows = [dict(row) for row in conn.execute(
            "SELECT symbol, name, isin, status, admission_reason, mcsymbol, tlid, stockid, companyid, "
            "tickertape_sid, fincode, scripcode FROM nse_stocks WHERE symbol IS NOT NULL"
        ).fetchall()]
        report = build_audit(equity_rows, changes, master_rows, _static_sources())
        if persist:
            record_dataset_watermark(
                conn, dataset="nse_ticker_mapping_audit", completeness_status=report["status"],
                input_watermark=report["symbol_change_latest_effective_date"],
                output_watermark="nse_stocks+static-provider-maps", expected_rows=report["equity_master_symbols"],
                accepted_rows=report["active_master_symbols"], rejected_rows=len(report["findings"]),
                source_version="nse_equity_master+symbolchange.csv", run_ref=dt.datetime.now(dt.timezone.utc).isoformat(),
            )
    findings_total = len(report["findings"])
    report["findings"] = report["findings"][:200]
    report["findings_truncated"] = findings_total > len(report["findings"])
    print(json.dumps(report, default=str, sort_keys=True))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="read sources and report without persisting the audit watermark")
    run_audit(persist=not parser.parse_args().dry_run)
