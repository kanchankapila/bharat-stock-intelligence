"""No tracked .json file may start with a UTF-8 byte-order mark.

AF-20260918-03. `scripts/stocklist.json` -- the provider-mapping master every fetcher resolves
MoneyControl/Trendlyne/ET/Tickertape ids from -- gained a BOM (`EF BB BF`) in commit `d6d39566`
on 2026-09-12, the edit that renamed TATAMOTORS -> TMPV. Windows PowerShell 5.1 writes a BOM for
`Set-Content`/`Out-File -Encoding utf8`, which is the likely source.

It went unnoticed for six days because the production fetchers all happen to read the file with
`encoding="utf-8-sig"`, which tolerates a BOM. Everything that reads it with plain `utf-8` broke
silently: 28 live_datasource tests across three files errored at SETUP on
`JSONDecodeError: Unexpected UTF-8 BOM` (surfaced 2026-09-18, the first full live run since), and
so would the maintenance scripts that regenerate the mappings (`merge_finology.py`,
`merge_et_companyid.py`, `fetch_*_mappings.py`, `enrich_stocklist_tickertape.py`). Node's
`JSON.parse` rejects a BOM too, and RFC 8259 forbids one in JSON.

**Why a scan of the file, not a fix to each reader:** switching every reader to `utf-8-sig` would
paper over it per call site and leave the next reader to rediscover it -- the "guard re-typed per
call site" class. The file is what is wrong, so the file is what is checked. Derived from
`git ls-files`, so a NEW json file inherits the guard without anyone listing it.

Negative control: re-prepend `\\xef\\xbb\\xbf` to scripts/stocklist.json and this fails naming it.
"""
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
BOM = b"\xef\xbb\xbf"


def _tracked_json() -> list[pathlib.Path]:
    out = subprocess.run(
        ["git", "ls-files", "*.json"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
    return [ROOT / p for p in out if (ROOT / p).is_file()]


def test_no_tracked_json_file_starts_with_a_bom():
    offenders = []
    for path in _tracked_json():
        with open(path, "rb") as f:
            if f.read(3) == BOM:
                offenders.append(str(path.relative_to(ROOT)))
    assert not offenders, (
        "tracked JSON file(s) start with a UTF-8 BOM. Plain `open(..., encoding='utf-8')` + "
        "`json.load` and Node's `JSON.parse` both reject it (AF-20260918-03). Strip the first 3 "
        "bytes; if you edited it from Windows PowerShell 5.1, write with "
        "`[IO.File]::WriteAllText(path, text, [Text.UTF8Encoding]::new($false))`:\n  "
        + "\n  ".join(offenders))


def test_the_scan_is_not_vacuous():
    files = [p.name for p in _tracked_json()]
    assert "stocklist.json" in files, "scan no longer reaches scripts/stocklist.json"
    assert len(files) > 10, f"only {len(files)} tracked json files found -- git ls-files misfired?"
