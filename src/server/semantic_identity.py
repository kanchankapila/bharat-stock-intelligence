"""Canonical issuer, instrument, listing and provider-identifier layer.

PostgreSQL remains authoritative. This module materializes a conservative
identity graph from ``nse_stocks``: full ISIN identifies an instrument, the
verified seven-character Indian ISIN prefix identifies its issuer, and exchange
symbols identify listings. Missing ISIN never triggers a name-based merge.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from db_compat import connect
from semantic_evidence import record_dataset_watermark

_IDENTITY_TABLES = (
    "market_issuer",
    "market_instrument",
    "market_listing",
    "market_identifier",
    "market_identifier_gap",
)
_ISIN_RE = re.compile(r"^IN[A-Z0-9]{10}$")
_SYMBOL_RE = re.compile(r"^[A-Z0-9&$\-]{1,20}$")


def _json(value: Any) -> str:
    return json.dumps(value, default=str, sort_keys=True)


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _valid_isin(value: Any) -> Optional[str]:
    candidate = str(value or "").strip().upper()
    if not _ISIN_RE.fullmatch(candidate):
        return None
    expanded = "".join(str(ord(char) - 55) if char.isalpha() else char for char in candidate)
    total = 0
    for index, char in enumerate(reversed(expanded)):
        digits = str(int(char) * (2 if index % 2 else 1))
        total += sum(int(digit) for digit in digits)
    return candidate if total % 10 == 0 else None


def identity_schema_available(conn) -> bool:
    return all(
        bool((row := conn.execute("SELECT to_regclass(?) AS relation", [table]).fetchone()) and row["relation"])
        for table in _IDENTITY_TABLES
    )


def _load_master_rows(conn) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """SELECT symbol, name, sector, industry, isin, listing_date, exchange, status,
                  mcsymbol, tlid, stockid, companyid, tickertape_sid, fincode, scripcode,
                  last_updated
           FROM nse_stocks
           WHERE symbol IS NOT NULL AND btrim(symbol) <> ''
           ORDER BY symbol"""
    ).fetchall()
    return [dict(row) for row in rows]


def _identity_keys(row: Dict[str, Any]) -> Tuple[str, str, str, str, float]:
    symbol = str(row.get("symbol") or "").strip().upper()
    exchange = str(row.get("exchange") or "NSE").strip().upper()
    isin = _valid_isin(row.get("isin"))
    if isin:
        return (
            f"IN:ISSUER:{isin[:7]}",
            f"IN:ISIN:{isin}",
            "isin",
            "isin_issuer_prefix",
            1.0,
        )
    return (
        f"IN:PROVISIONAL:{exchange}:{symbol}",
        f"IN:PROVISIONAL:{exchange}:{symbol}",
        "provisional_symbol",
        "provisional_symbol",
        0.35,
    )


def _provider_identifiers(row: Dict[str, Any]) -> List[Tuple[str, str, str, float]]:
    symbol = str(row.get("symbol") or "").strip().upper()
    values = (
        ("nse", "ticker", symbol, 1.0),
        ("bse", "scrip_code", row.get("scripcode"), 0.95),
        ("moneycontrol", "security_id", row.get("mcsymbol"), 0.8),
        ("trendlyne", "company_id", row.get("tlid"), 0.9),
        ("marketsmojo", "stock_id", row.get("stockid"), 0.8),
        ("trading80", "stock_id", row.get("stockid"), 0.8),
        ("indiatimes", "company_id", row.get("companyid"), 0.9),
        ("tickertape", "security_id", row.get("tickertape_sid"), 0.9),
        ("finology", "company_id", row.get("fincode"), 0.8),
    )
    output = []
    for provider, scheme, value, confidence in values:
        text = str(value or "").strip()
        if text:
            output.append((provider, scheme, text, confidence))
    return output



def _upsert_issuer(conn, row: Dict[str, Any], issuer_key: str, basis: str, confidence: float) -> int:
    result = conn.execute(
        """INSERT INTO market_issuer
           (issuer_key, legal_name, identity_basis, confidence, attributes,
            valid_from, available_at, source, source_ref)
           VALUES (?, ?, ?, ?, CAST(? AS jsonb), CAST(? AS timestamptz),
                   COALESCE(CAST(? AS timestamptz), now()), ?, ?)
           ON CONFLICT (issuer_key) DO UPDATE SET
             legal_name=excluded.legal_name, identity_basis=excluded.identity_basis,
             confidence=excluded.confidence, attributes=excluded.attributes,
             source=excluded.source,
             source_ref=excluded.source_ref
           RETURNING issuer_id""",
        [issuer_key, row.get("name") or row.get("symbol") or issuer_key, basis, confidence,
         _json({"sector": row.get("sector"), "industry": row.get("industry")}),
         _iso(row.get("listing_date")), None,  # available_at: see sync_identity (AF-20260927-10)
         "nse_stocks", f"nse_stocks:{row.get('symbol')}"],
    ).fetchone()
    return int(result["issuer_id"])


def _upsert_instrument(
    conn, row: Dict[str, Any], instrument_key: str, issuer_id: int, basis: str, confidence: float
) -> int:
    isin = _valid_isin(row.get("isin"))
    result = conn.execute(
        """INSERT INTO market_instrument
           (instrument_key, issuer_id, name, instrument_type, isin, identity_basis,
            confidence, attributes, valid_from, available_at, source, source_ref)
           VALUES (?, ?, ?, 'equity', ?, ?, ?, CAST(? AS jsonb), CAST(? AS timestamptz),
                   COALESCE(CAST(? AS timestamptz), now()), ?, ?)
           ON CONFLICT (instrument_key) DO UPDATE SET
             issuer_id=excluded.issuer_id, name=excluded.name, isin=excluded.isin,
             identity_basis=excluded.identity_basis, confidence=excluded.confidence,
             attributes=excluded.attributes,
             source=excluded.source, source_ref=excluded.source_ref
           RETURNING instrument_id""",
        [instrument_key, issuer_id, row.get("name") or row.get("symbol"), isin, basis,
         confidence, _json({"sector": row.get("sector"), "industry": row.get("industry")}),
         _iso(row.get("listing_date")), None,  # available_at: see sync_identity (AF-20260927-10)
         "nse_stocks", f"nse_stocks:{row.get('symbol')}"],
    ).fetchone()
    return int(result["instrument_id"])



def _upsert_listing(conn, row: Dict[str, Any], instrument_id: int, available_at: Optional[str]) -> int:
    symbol = str(row.get("symbol") or "").strip().upper()
    exchange = str(row.get("exchange") or "NSE").strip().upper()
    listing_key = f"{exchange}:EQUITY:{symbol}"
    result = conn.execute(
        """INSERT INTO market_listing
           (listing_key, instrument_id, exchange, market_segment, symbol, status,
            listed_from, attributes, available_at, source, source_ref)
           VALUES (?, ?, ?, 'equity', ?, ?, CAST(? AS date), CAST(? AS jsonb),
                   COALESCE(CAST(? AS timestamptz), now()), ?, ?)
           ON CONFLICT (listing_key) DO UPDATE SET
             instrument_id=excluded.instrument_id, status=excluded.status,
             listed_from=excluded.listed_from, attributes=excluded.attributes,
             source=excluded.source,
             source_ref=excluded.source_ref
           RETURNING listing_id""",
        [listing_key, instrument_id, exchange, symbol,
         str(row.get("status") or "active").lower(), _iso(row.get("listing_date")),
         _json({"sector": row.get("sector"), "industry": row.get("industry")}), available_at,
         "nse_stocks", f"nse_stocks:{symbol}"],
    ).fetchone()
    return int(result["listing_id"])


def _upsert_identifier(
    conn, instrument_id: int, provider: str, scheme: str, value: str, confidence: float,
    available_at: Optional[str], status: str = "verified",
) -> int:
    mapping_key = f"{provider}:{scheme}:{value}:{instrument_id}"
    result = conn.execute(
        """INSERT INTO market_identifier
           (mapping_key, instrument_id, provider, scheme, identifier_value,
            mapping_status, confidence, available_at, source, source_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS timestamptz), now()),
                   'nse_stocks', ?)
           ON CONFLICT (mapping_key) DO UPDATE SET
             mapping_status=excluded.mapping_status, confidence=excluded.confidence,
             source=excluded.source,
             source_ref=excluded.source_ref
           RETURNING identifier_id""",
        [mapping_key, instrument_id, provider, scheme, value, status, confidence,
         available_at, f"nse_stocks:{value}"],
    ).fetchone()
    return int(result["identifier_id"])



def _project_graph_identity(
    conn, issuer_id: int, instrument_id: int, listing_id: int,
    issuer_key: str, instrument_key: str, row: Dict[str, Any],
) -> None:
    issuer_node = conn.execute(
        """INSERT INTO market_graph_node
           (node_key, node_type, label, attributes, source, source_ref)
           VALUES (?, 'issuer', ?, CAST(? AS jsonb), 'nse_stocks', ?)
           ON CONFLICT (node_type, node_key) DO UPDATE SET
             label=excluded.label, attributes=excluded.attributes,
             source=excluded.source, source_ref=excluded.source_ref
           RETURNING node_id""",
        [f"issuer:{issuer_key}", row.get("name") or issuer_key, _json({"issuer_id": issuer_id}),
         f"nse_stocks:{row.get('symbol')}"],
    ).fetchone()["node_id"]
    instrument_node = conn.execute(
        """INSERT INTO market_graph_node
           (node_key, node_type, label, canonical_symbol, attributes, source, source_ref)
           VALUES (?, 'instrument', ?, ?, CAST(? AS jsonb), 'nse_stocks', ?)
           ON CONFLICT (node_type, node_key) DO UPDATE SET
             label=excluded.label, canonical_symbol=excluded.canonical_symbol,
             attributes=excluded.attributes, source=excluded.source, source_ref=excluded.source_ref
           RETURNING node_id""",
        [f"instrument:{instrument_key}", row.get("name") or row.get("symbol"), row.get("symbol"),
         _json({"instrument_id": instrument_id, "isin": _valid_isin(row.get("isin"))}),
         f"nse_stocks:{row.get('symbol')}"],
    ).fetchone()["node_id"]
    exchange = str(row.get("exchange") or "NSE").upper()
    symbol = str(row.get("symbol") or "").upper()
    listing_node = conn.execute(
        """INSERT INTO market_graph_node
           (node_key, node_type, label, canonical_symbol, attributes, source, source_ref)
           VALUES (?, 'listing', ?, ?, CAST(? AS jsonb), 'nse_stocks', ?)
           ON CONFLICT (node_type, node_key) DO UPDATE SET
             label=excluded.label, canonical_symbol=excluded.canonical_symbol,
             attributes=excluded.attributes, source=excluded.source, source_ref=excluded.source_ref
           RETURNING node_id""",
        [f"listing:{exchange}:EQUITY:{symbol}", f"{exchange}:{symbol}", symbol,
         _json({"listing_id": listing_id, "exchange": exchange, "segment": "EQUITY"}),
         f"nse_stocks:{symbol}"],
    ).fetchone()["node_id"]
    for from_id, to_id, predicate, key in (
        (issuer_node, instrument_node, "ISSUES", f"identity:{issuer_key}:{instrument_key}"),
        (instrument_node, listing_node, "LISTED_AS", f"identity:{instrument_key}:{exchange}:{symbol}"),
    ):
        conn.execute(
            """INSERT INTO market_graph_edge
               (from_node_id, to_node_id, predicate, source, source_ref, assertion_key)
               VALUES (?, ?, ?, 'nse_stocks', ?, ?)
               ON CONFLICT (assertion_key) DO UPDATE SET
                 from_node_id=excluded.from_node_id, to_node_id=excluded.to_node_id,
                 predicate=excluded.predicate, source=excluded.source,
                 source_ref=excluded.source_ref""",
            [from_id, to_id, predicate, f"nse_stocks:{symbol}", key],
        )



def _mark_identifier_collisions(conn, rows: Sequence[Dict[str, Any]]) -> int:
    by_value: Dict[Tuple[str, str, str], set] = defaultdict(set)
    for row in rows:
        for provider, scheme, value, _confidence in _provider_identifiers(row):
            by_value[(provider, scheme, value)].add(str(row.get("symbol") or "").upper())
    gaps = 0
    for (provider, scheme, value), symbols in by_value.items():
        if len(symbols) <= 1:
            continue
        candidate_rows = conn.execute(
            """SELECT i.instrument_id FROM market_identifier i
               JOIN market_instrument i2 ON i2.instrument_id = i.instrument_id
               WHERE i.provider = ? AND i.scheme = ? AND i.identifier_value = ?""",
            [provider, scheme, value],
        ).fetchall()
        candidate_ids = sorted({int(row["instrument_id"]) for row in candidate_rows})
        conn.execute(
            """INSERT INTO market_identifier_gap
               (provider, scheme, identifier_value, reason, candidate_instrument_ids,
                last_seen, attempts)
               VALUES (?, ?, ?, ?, ?, now(), 1)
               ON CONFLICT (provider, scheme, identifier_value) DO UPDATE SET
                 reason=excluded.reason, candidate_instrument_ids=excluded.candidate_instrument_ids,
                 last_seen=now(), attempts=market_identifier_gap.attempts + 1""",
            [provider, scheme, value, f"provider id maps to multiple symbols: {sorted(symbols)}",
             candidate_ids],
        )
        gaps += 1
    return gaps


def sync_identity(conn=None) -> Dict[str, Any]:
    """Synchronize canonical identity and return a completeness report."""
    owns = conn is None
    if owns:
        conn = connect()
    try:
        if not identity_schema_available(conn):
            return {"status": "unavailable", "reason": "identity migration is not installed"}
        rows = _load_master_rows(conn)
        valid_isins: set = set()
        provisional = 0
        identifiers = 0
        for row in rows:
            symbol = str(row.get("symbol") or "").strip().upper()
            if not _SYMBOL_RE.fullmatch(symbol):
                continue
            issuer_key, instrument_key, instrument_basis, issuer_basis, confidence = _identity_keys(row)
            if instrument_basis == "isin":
                valid_isins.add(_valid_isin(row.get("isin")))
            else:
                provisional += 1
            issuer_id = _upsert_issuer(conn, row, issuer_key, issuer_basis, confidence)
            instrument_id = _upsert_instrument(
                conn, row, instrument_key, issuer_id, instrument_basis, confidence
            )
            # AF-20260927-10: available_at is OUR knowledge time, never the vendor's edit time.
            # This used to pass nse_stocks.last_updated, which is (a) mutable -- it moves forward
            # on every vendor refresh -- and (b) frequently EARLIER than the sync that wrote the
            # row, which is the dangerous direction: it claims we knew a fact before we did, so a
            # point-in-time read at that earlier instant returns a row that did not yet exist
            # (look-ahead). None lets the writers' COALESCE(..., now()) stamp the sync's own time.
            available_at = None
            listing_id = _upsert_listing(conn, row, instrument_id, available_at)
            if instrument_basis == "isin":
                _upsert_identifier(conn, instrument_id, "iso", "isin", instrument_key.split(":", 2)[2], 1.0, available_at)
                identifiers += 1
            for provider, scheme, value, id_confidence in _provider_identifiers(row):
                _upsert_identifier(
                    conn, instrument_id, provider, scheme, value, id_confidence, available_at
                )
                identifiers += 1
            _project_graph_identity(
                conn, issuer_id, instrument_id, listing_id, issuer_key, instrument_key, row
            )
        gaps = _mark_identifier_collisions(conn, rows)
        record_dataset_watermark(
            conn,
            dataset="canonical_market_identity",
            completeness_status="partial" if provisional else "complete",
            input_watermark="nse_stocks",
            output_watermark="market_instrument",
            expected_rows=len(rows),
            accepted_rows=len(rows) - provisional,
            rejected_rows=provisional,
            source_version="nse_stocks.current-snapshot",
            run_ref=datetime.now(timezone.utc).isoformat(),
        )
        if owns:
            conn.commit()
        return {
            "status": "ok",
            "master_rows": len(rows),
            "instruments_with_isin": len(valid_isins),
            "provisional_instruments": provisional,
            "identifier_mappings": identifiers,
            "identifier_gaps": gaps,
        }
    except Exception:
        if owns:
            conn.rollback()
        raise
    finally:
        if owns:
            conn.close()



def resolve_identifier(value: str, provider: Optional[str] = None) -> Dict[str, Any]:
    """Resolve a provider-qualified identifier without guessing on collisions."""
    identifier = str(value or "").strip()
    if not identifier:
        return {"status": "invalid", "error": "identifier is required"}
    conn = connect()
    try:
        if not identity_schema_available(conn):
            return {"status": "unavailable", "reason": "identity migration is not installed"}
        normalized = identifier.upper()
        symbol = normalized if _SYMBOL_RE.fullmatch(normalized) else None
        isin = _valid_isin(normalized)
        clauses = []
        params: List[Any] = []
        if provider:
            # A provider-qualified lookup must not be widened by a coincidentally
            # ticker-shaped value; collisions are resolved conservatively below.
            clauses = ["mi.provider = ? AND mi.identifier_value = ?"]
            params = [provider.lower(), identifier]
        else:
            if symbol:
                clauses.append("(l.symbol = ? OR i.isin = ?)")
                params.extend([symbol, symbol])
            if isin:
                clauses.append("i.isin = ?")
                params.append(isin)
        if not clauses:
            clauses.append("mi.identifier_value = ?")
            params.append(identifier)
        rows = conn.execute(
            f"""SELECT DISTINCT i.instrument_id, i.instrument_key, i.name, i.isin,
                       i.identity_basis, i.confidence,
                       l.listing_id, l.exchange, l.market_segment, l.symbol, l.status
                FROM market_instrument i
                LEFT JOIN market_listing l ON l.instrument_id = i.instrument_id
                LEFT JOIN market_identifier mi ON mi.instrument_id = i.instrument_id
                WHERE {' OR '.join(clauses)}""",
            params,
        ).fetchall()
        candidates = [dict(row) for row in rows]
        if len(candidates) == 1:
            return {"status": "resolved", "match": candidates[0]}
        if not candidates:
            return {"status": "not_found", "identifier": identifier, "provider": provider}
        return {
            "status": "ambiguous",
            "identifier": identifier,
            "provider": provider,
            "candidates": candidates,
            "error": "multiple instruments match; refusing to guess",
        }
    finally:
        conn.close()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Synchronize canonical market identity")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("sync")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("value")
    resolve.add_argument("--provider")
    args = parser.parse_args(argv)
    result = sync_identity() if args.command == "sync" else resolve_identifier(args.value, args.provider)
    print(json.dumps(result, indent=2, default=str))
    return 0 if result.get("status") not in {"invalid", "error"} else 1


if __name__ == "__main__":
    raise SystemExit(main())

