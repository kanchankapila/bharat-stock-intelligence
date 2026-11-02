#!/usr/bin/env python3
"""Atomically apply a fresh URL Explorer checkpoint to the endpoint registry.

The discovery registry owns semantic metadata that the external validator does not.
This updater therefore refreshes health evidence in place instead of dropping and
recreating the registry. Registry rows absent from the checkpoint are probed directly
so one fresh row cannot make an otherwise stale catalog look current.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import requests
from psycopg2.extras import execute_batch


def _load_checkpoint(path: Path) -> dict[str, dict]:
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return {row["uid"]: dict(row) for row in conn.execute("SELECT * FROM validation_results")}


def _probe_missing(row: tuple) -> dict:
    uid, method, url, headers, payload = row
    started = time.monotonic()
    now = datetime.now(timezone.utc).isoformat()
    try:
        response = requests.request(method, url, headers=headers or {}, json=payload, timeout=20)
        elapsed = round((time.monotonic() - started) * 1000, 1)
        size = len(response.content)
        working = response.status_code == 200 and size > 30
        return {
            "uid": uid,
            "method": method,
            "url": url,
            "provider": "legacy registry",
            "category": "legacy registry",
            "name": uid,
            "payload": json.dumps(payload) if payload else "",
            "headers": json.dumps(headers or {}),
            "status_code": response.status_code,
            "is_working": int(working),
            "response_bytes": size,
            "latency_ms": elapsed,
            "data_format": "JSON" if "json" in response.headers.get("content-type", "").lower() else "HTTP",
            "sample_info": f"{response.status_code}; {size} bytes",
            "error_msg": "" if working else f"HTTP {response.status_code}",
            "validated_at": now,
        }
    except Exception as exc:  # noqa: BLE001 - probe failures are evidence, not process failures
        return {
            "uid": uid,
            "method": method,
            "url": url,
            "provider": "legacy registry",
            "category": "legacy registry",
            "name": uid,
            "payload": json.dumps(payload) if payload else "",
            "headers": json.dumps(headers or {}),
            "status_code": 0,
            "is_working": 0,
            "response_bytes": 0,
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
            "data_format": "ERROR",
            "sample_info": "",
            "error_msg": str(exc)[:250],
            "validated_at": now,
        }


def sync(checkpoint: Path) -> tuple:
    results = _load_checkpoint(checkpoint)
    dsn = os.environ.get("POSTGRES_URL", "postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel")
    with psycopg2.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT uid, http_method, target_url, request_headers, request_payload "
                "FROM market_endpoint_registry"
            )
            registry = cur.fetchall()
            for row in registry:
                if row[0] not in results:
                    results[row[0]] = _probe_missing(row)

            updates = []
            for uid, *_ in registry:
                row = results[uid]
                size = int(row.get("response_bytes") or 0)
                updates.append(
                    (
                        int(row.get("status_code") or 0),
                        bool(row.get("is_working")),
                        size,
                        round(size / 1024.0, 2),
                        float(row.get("latency_ms") or 0),
                        (row.get("sample_info") or "")[:300],
                        row.get("validated_at"),
                        uid,
                    )
                )
            execute_batch(
                cur,
                """UPDATE market_endpoint_registry
                      SET http_status_code=%s, is_working=%s, response_bytes=%s, response_kb=%s,
                          latency_ms=%s, sample_info=%s, validated_at=%s
                    WHERE uid=%s""",
                updates,
                page_size=500,
            )

            audit_rows = [
                (
                    row["uid"], row["method"], row["url"], row.get("provider") or "",
                    row.get("category") or "", row.get("name") or "", row.get("payload") or "",
                    row.get("headers") or "", int(row.get("status_code") or 0),
                    bool(row.get("is_working")), int(row.get("response_bytes") or 0),
                    float(row.get("latency_ms") or 0), row.get("data_format") or "",
                    row.get("sample_info") or "", (row.get("error_msg") or "")[:250],
                    row.get("validated_at"),
                )
                for row in results.values()
            ]
            execute_batch(
                cur,
                """INSERT INTO url_candidates_validation_audit
                       (uid,method,url,provider,category,name,payload,headers,status_code,is_working,
                        response_bytes,latency_ms,data_format,sample_info,error_msg,validated_at)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                     ON CONFLICT (uid) DO UPDATE SET
                       method=excluded.method,url=excluded.url,provider=excluded.provider,
                       category=excluded.category,name=excluded.name,payload=excluded.payload,
                       headers=excluded.headers,status_code=excluded.status_code,
                       is_working=excluded.is_working,response_bytes=excluded.response_bytes,
                       latency_ms=excluded.latency_ms,data_format=excluded.data_format,
                       sample_info=excluded.sample_info,error_msg=excluded.error_msg,
                       validated_at=excluded.validated_at""",
                audit_rows,
                page_size=500,
            )
            cur.execute(
                """SELECT count(*)::int,
                          count(*) FILTER (WHERE validated_at >= now() - interval '30 days')::int,
                          count(*) FILTER (WHERE is_working)::int,
                          min(validated_at), max(validated_at)
                     FROM market_endpoint_registry"""
            )
            return cur.fetchone()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True, type=Path)
    args = parser.parse_args()
    if not args.checkpoint.is_file():
        raise SystemExit(f"checkpoint not found: {args.checkpoint}")
    print("registry total/recent/working/min/max:", sync(args.checkpoint))


if __name__ == "__main__":
    main()
