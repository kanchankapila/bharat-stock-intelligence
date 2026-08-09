#!/usr/bin/env python3
"""Normalize and lint a URL list file.

Usage:
  python scripts/normalize_urls.py --input urls.txt --output urls.normalized.txt \
      --changes-file docs/url_explorer/urls_normalization_changes_2026_08_05.tsv
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


def _normalize_scheme_slashes(url: str) -> str:
    # Fix malformed prefixes like https:////example.com/path -> https://example.com/path
    return re.sub(r"^(https?):/{3,}", r"\1://", url.strip(), flags=re.IGNORECASE)


def _normalize_url(url: str) -> str:
    u = _normalize_scheme_slashes(url)
    parts = urlsplit(u)

    scheme = parts.scheme.lower()

    host = (parts.hostname or "").lower()
    port = parts.port

    # Drop default ports
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None

    netloc = host
    if port:
        netloc = f"{host}:{port}"

    # Collapse repeated slashes in path only
    path = re.sub(r"/{2,}", "/", parts.path or "")
    if not path:
        path = "/"

    query = parts.query or ""
    fragment = parts.fragment or ""

    return urlunsplit((scheme, netloc, path, query, fragment))


def _is_http_url(url: str) -> bool:
    return url.startswith("http://") or url.startswith("https://")


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize and lint URL list files")
    parser.add_argument("--input", required=True, help="Input file path")
    parser.add_argument("--output", required=True, help="Output normalized file path")
    parser.add_argument(
        "--changes-file",
        help="Optional TSV file to write changed rows: line\toriginal\tnormalized",
    )
    args = parser.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)
    changes_path = Path(args.changes_file) if args.changes_file else None

    raw_lines = in_path.read_text(encoding="utf-8").splitlines()

    normalized_lines: list[str] = []
    changed_rows: list[tuple[int, str, str]] = []
    empty_lines = 0
    non_http_lines = 0

    for idx, raw in enumerate(raw_lines, start=1):
        stripped = raw.strip()
        if not stripped:
            empty_lines += 1
            continue

        fixed_prefix = _normalize_scheme_slashes(stripped)
        if not _is_http_url(fixed_prefix.lower()):
            non_http_lines += 1
            continue

        normalized = _normalize_url(fixed_prefix)
        normalized_lines.append(normalized)

        if normalized != stripped:
            changed_rows.append((idx, stripped, normalized))

    out_path.write_text("\n".join(normalized_lines) + "\n", encoding="utf-8")

    if changes_path:
        changes_path.parent.mkdir(parents=True, exist_ok=True)
        with changes_path.open("w", encoding="utf-8") as f:
            f.write("line\toriginal\tnormalized\n")
            for line_no, original, normalized in changed_rows:
                f.write(f"{line_no}\t{original}\t{normalized}\n")

    malformed_before = sum(1 for x in raw_lines if x.strip().startswith("https:////"))
    malformed_after = sum(1 for x in normalized_lines if x.startswith("https:////"))
    unique_before = len({x.strip() for x in raw_lines if x.strip()})
    unique_after = len(set(normalized_lines))

    print(f"input_lines={len(raw_lines)}")
    print(f"output_lines={len(normalized_lines)}")
    print(f"empty_lines_removed={empty_lines}")
    print(f"non_http_lines_removed={non_http_lines}")
    print(f"changed_lines={len(changed_rows)}")
    print(f"malformed_https_slashes_before={malformed_before}")
    print(f"malformed_https_slashes_after={malformed_after}")
    print(f"unique_urls_before={unique_before}")
    print(f"unique_urls_after={unique_after}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
