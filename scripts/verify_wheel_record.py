"""Recompute a wheel's RECORD hashes against the files actually installed in a site-packages.

Answers one question that `pip check` cannot: is the code on disk really the release its
metadata claims? A package whose dist-info was destroyed (a pip uninstall interrupted by a
Windows file lock renames the tree to `~<name>` and can die mid-way) leaves pip reporting the
distribution as missing while the library imports fine, and the only way to know whether the
metadata can honestly be restored is to hash every wheel file against the live one.

Verdict logic: restoring a wheel's dist-info is only honest when every file in RECORD matches,
because RECORD hashes the installed tree. Any mismatch means the tree is not that release, and
stamping the wheel's metadata onto it would produce a RECORD that lies.

Usage:
    venv/Scripts/python.exe scripts/verify_wheel_record.py <wheel-root> [site-packages]

where <wheel-root> is an unpacked wheel (rename .whl to .zip and Expand-Archive it). Exit code
0 means safe to restore metadata, 1 means do not -- so this can gate a repair in a script.
"""
import base64
import hashlib
import sys
from pathlib import Path


def record_lines(dist_info: Path) -> list:
    text = (dist_info / "RECORD").read_text(encoding="utf-8", errors="replace")
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.rsplit(",", 2)
        if len(parts) == 3 and parts[1].startswith("sha256="):
            rows.append((parts[0].replace("\\", "/"), parts[1]))
    return rows


def main(argv: list) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    root = Path(argv[1])
    sp = Path(argv[2]) if len(argv) > 2 else root

    dists = sorted(p for p in root.iterdir() if p.is_dir() and p.name.endswith(".dist-info"))
    if not dists:
        print("no .dist-info in %s -- unpack the wheel first" % root)
        return 2
    dist = dists[0]
    rows = record_lines(dist)
    print("verifying %s: %d hashed entries against %s" % (dist.name, len(rows), sp))

    ok = linewin = mismatch = missing = 0
    for rel, want in rows:
        if rel.endswith("/"):
            continue
        # The wheel's own dist-info entries are the metadata being restored; they are absent from
        # a broken tree by definition and must not be counted as missing code.
        if ".dist-info/" in rel:
            continue
        live = sp / rel
        if not live.exists():
            print("MISSING  %s" % rel)
            missing += 1
            continue
        raw = live.read_bytes()
        got = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
        if got == want:
            ok += 1
            continue
        # A file that matches once CRLF is collapsed to LF differs only in line endings, which
        # is not a code difference. RECORD hashes the wheel's own bytes, which are LF.
        lf = "sha256=" + base64.urlsafe_b64encode(
            hashlib.sha256(raw.replace(b"\r\n", b"\n")).digest()).decode().rstrip("=")
        if lf == want:
            print("LINEENDS %s (identical apart from CRLF)" % rel)
            linewin += 1
        else:
            print("MISMATCH %s\n         wheel=%s live=%s" % (rel, want[:24], got[:24]))
            mismatch += 1

    print("\nchecked=%d ok=%d line-endings-only=%d mismatch=%d missing=%d"
          % (ok + linewin + mismatch + missing, ok, linewin, mismatch, missing))
    verdict = 0 if (mismatch == 0 and missing == 0) else 1
    print("VERDICT: %s" % ("safe to restore this dist-info" if verdict == 0
                           else "DO NOT RESTORE METADATA -- the tree is not this release"))
    return verdict


if __name__ == "__main__":
    sys.exit(main(sys.argv))
