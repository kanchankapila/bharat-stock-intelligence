"""An in-code `CREATE TABLE IF NOT EXISTS` must declare the SAME primary key as the live schema.

AF-20260918-05. The class this guards bit twice on 2026-09-17/18:

  * `high_flyer_retrospective.py` declared `date TEXT`, silently undoing a TEXT->DATE migration
    the moment the table was recreated (AF-20260917-19);
  * `delivery_trend_fetcher.ensure_schema()` still declared the PK
    `(symbol, deal_date, client_name, deal_type)` after migration `20260912120000` moved it to
    `(source, symbol, ...)`. `CREATE TABLE IF NOT EXISTS` no-ops on the existing production table,
    so nothing noticed -- but on any fresh database the fetcher built a table its OWN upsert
    could not write to (`column "source" ... does not exist`). It surfaced only because a live
    store test finally ran instead of skipping.

**Why the PRIMARY KEY and not the column list.** Measured before writing this: a scan requiring
every in-code DDL to carry every live column flags **42** blocks, and most are not defects --
`high_flyer_retrospective` adds three columns with `safe_alter` right after its CREATE, which is
correct. A guard firing 42 times is the always-fires monitor `ml-model-bugs.md` warns about. The
primary key is the part that breaks WRITES: every `ON CONFLICT (...)` target must match it. The
PK scan flags exactly the one real defect against the pre-fix fetcher and zero across the repo
after the fix -- one true positive, no noise.

Derived from the source tree and from `db/schema.postgres.sql`, so a new fetcher is covered
without anyone listing it. Negative control: restore the pre-fix `delivery_trend_fetcher.py`
(`git show HEAD~1:...`) and this fails naming `bulk_block_deals`.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
SERVER = ROOT / "src" / "server"


def _live_pks() -> dict[str, list[str]]:
    schema = (ROOT / "db" / "schema.postgres.sql").read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r'CREATE TABLE IF NOT EXISTS "(\w+)" \((.*?)\n\);', schema, re.S):
        pk = re.search(r"PRIMARY KEY \(([^)]*)\)", m.group(2))
        if pk:
            out[m.group(1)] = [c.strip().strip('"').lower() for c in pk.group(1).split(",")]
    return out


def _balanced_body(src: str, open_idx: int) -> str | None:
    depth = 0
    for j in range(open_idx, len(src)):
        if src[j] == "(":
            depth += 1
        elif src[j] == ")":
            depth -= 1
            if depth == 0:
                return src[open_idx + 1:j]
    return None


def _code_pk(body: str) -> list[str] | None:
    table_pk = re.search(r"PRIMARY KEY\s*\(([^)]*)\)", body, re.I)
    if table_pk:
        return [c.strip().strip('"').lower() for c in table_pk.group(1).split(",")]
    inline = re.search(r'^\s*"?(\w+)"?\s+[A-Za-z ]+PRIMARY KEY', body, re.M | re.I)
    return [inline.group(1).lower()] if inline else None


def _scan() -> tuple[list[str], int]:
    live = _live_pks()
    offenders, compared = [], 0
    for path in sorted(SERVER.glob("*.py")):
        src = path.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r'CREATE TABLE IF NOT EXISTS\s+"?(\w+)"?\s*\(', src):
            table = m.group(1)
            if table not in live:
                continue
            body = _balanced_body(src, m.end() - 1)
            if body is None:
                continue
            code_pk = _code_pk(body)
            if code_pk is None:
                continue
            compared += 1
            if code_pk != live[table]:
                offenders.append(f"{path.name}: {table} declares PK {code_pk}, live is {live[table]}")
    return offenders, compared


def test_inline_ddl_primary_keys_match_the_live_schema():
    offenders, _ = _scan()
    assert not offenders, (
        "an in-code CREATE TABLE IF NOT EXISTS declares a different PRIMARY KEY from "
        "db/schema.postgres.sql. It no-ops against production, then builds a table on any fresh "
        "database that the fetcher's own ON CONFLICT upsert cannot write to (AF-20260918-05):\n  "
        + "\n  ".join(offenders))


def test_the_scan_is_not_vacuous():
    _, compared = _scan()
    assert compared >= 20, f"only {compared} in-code DDL blocks compared -- the parser has regressed"
