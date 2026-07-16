"""
SQLite -> PostgreSQL SQL translation for the Python engines (Phase 3 / P3f).

Python port of the TypeScript `sqlTranslate.ts` used by the `dbAsync` facade. It
mechanises the high-frequency, unambiguous conversions so the engine migration is
mostly a swap of the connection API, not the SQL.

Differences from the TS version (both intentional):
  - Placeholders become SQLAlchemy named binds `:p0, :p1, ...` (not `$1`), because the
    Python data layer executes through SQLAlchemy `text()`. This also avoids psycopg2's
    `%`-literal escaping landmine in LIKE patterns.
  - Function/syntax mapping only runs on the Postgres path; on SQLite the SQL is left
    byte-for-byte unchanged (so converted engines behave identically until cutover).

NOT a full transpiler — same carve-outs as the TS version:
  - INSERT OR REPLACE  -> left as-is (Postgres errors, forcing an explicit ON CONFLICT).
  - strftime(...)      -> left as-is; convert per-call where it appears.
  - PRAGMA table_info  -> left as-is; the few sites are hand-converted per file.

Covered by test_sql_translate.py.
"""
import os
import re


def use_postgres() -> bool:
    """Cutover switch — strictly USE_POSTGRES == 'true' (mirrors pgConfig.ts)."""
    return os.environ.get("USE_POSTGRES") == "true"


def convert_placeholders(sql: str) -> str:
    """Replace `?` placeholders with `:p0, :p1, ...`, skipping any inside literals."""
    out = []
    n = 0
    in_single = False
    in_double = False
    for ch in sql:
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        if ch == "?" and not in_single and not in_double:
            out.append(f":p{n}")
            n += 1
        else:
            out.append(ch)
    return "".join(out)


def _cast_round_numeric(sql: str) -> str:
    """ROUND(double precision, int) -> ROUND((value)::numeric, n). Paren-aware so nested
    commas (e.g. COALESCE(x, 0)) are not mistaken for the precision argument."""
    lower = sql.lower()
    out = []
    i = 0
    while i < len(sql):
        idx = lower.find("round(", i)
        if idx == -1:
            out.append(sql[i:])
            break
        prev = sql[idx - 1] if idx > 0 else " "
        if re.match(r"[A-Za-z0-9_]", prev):  # part of a longer identifier
            out.append(sql[i:idx + 6])
            i = idx + 6
            continue

        out.append(sql[i:idx])
        open_ = idx + 5  # index of '('
        depth = 0
        j = open_
        top_commas = []
        while j < len(sql):
            c = sql[j]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    break
            elif c == "," and depth == 1:
                top_commas.append(j)
            j += 1

        if top_commas and j < len(sql):
            last_comma = top_commas[-1]
            precision = sql[last_comma + 1:j].strip()
            if re.fullmatch(r"\d+", precision):
                value_expr = sql[open_ + 1:last_comma]
                out.append(f"round(({value_expr})::numeric, {precision})")
                i = j + 1
                continue
        out.append(sql[idx:j + 1])  # not a 2-arg integer round — leave as-is
        i = j + 1
    return "".join(out)


def _json_extract_repl(m: "re.Match") -> str:
    col = m.group(1)
    parts = m.group(2).split(".")
    if len(parts) == 1:
        return f"({col}::jsonb ->> '{parts[0]}')"
    return f"({col}::jsonb #>> '{{{','.join(parts)}}}')"


def map_sqlite_functions(sql: str) -> str:
    """Map SQLite-only functions/syntax to their Postgres equivalents."""
    s = _cast_round_numeric(sql)

    # datetime('now' [, '<modifier>']) -> now() / (now() + interval '<modifier>')
    s = re.sub(r"datetime\(\s*'now'\s*\)", "now()", s, flags=re.I)
    s = re.sub(r"datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)",
               r"(now() + interval '\1')", s, flags=re.I)

    # date('now' [, '<modifier>']) -> current_date / ((current_date + interval '<mod>')::date)
    s = re.sub(r"date\(\s*'now'\s*\)", "current_date", s, flags=re.I)
    s = re.sub(r"date\(\s*'now'\s*,\s*'([^']+)'\s*\)",
               r"((current_date + interval '\1')::date)", s, flags=re.I)
    # date(<column/expr>) -> (<expr>)::date  (after the 'now' forms; skips quoted args)
    s = re.sub(r"\bdate\(\s*([^'\")][^)]*?)\s*\)", r"(\1)::date", s, flags=re.I)

    # julianday('now') - julianday(col) -> current_date - (col)::date  (integer day diff)
    s = re.sub(r"\bjulianday\(\s*'now'\s*\)", "current_date", s, flags=re.I)
    s = re.sub(r"\bjulianday\(\s*([^'\")][^)]*?)\s*\)", r"(\1)::date", s, flags=re.I)

    # IFNULL -> COALESCE
    s = re.sub(r"\bIFNULL\s*\(", "COALESCE(", s, flags=re.I)

    # INSTR(a, b) -> position(b in a)   (argument order swaps)
    s = re.sub(r"\bINSTR\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)",
               r"position(\2 in \1)", s, flags=re.I)

    # group_concat(x [, sep]) -> string_agg(x::text, sep|',')
    s = re.sub(r"\bGROUP_CONCAT\s*\(\s*([^,()]+?)\s*,\s*('[^']*')\s*\)",
               r"string_agg(\1::text, \2)", s, flags=re.I)
    s = re.sub(r"\bGROUP_CONCAT\s*\(\s*([^,()]+?)\s*\)",
               r"string_agg(\1::text, ',')", s, flags=re.I)

    # json_extract(col, '$.a.b') -> (col::jsonb #>> '{a,b}') ; single key -> ->>
    s = re.sub(r"\bjson_extract\s*\(\s*([^,]+?)\s*,\s*'\$\.([^']+)'\s*\)",
               _json_extract_repl, s, flags=re.I)

    # CAST(x AS REAL|INTEGER) -> Postgres types
    s = re.sub(r"CAST\s*\(([^)]+?)\s+AS\s+REAL\s*\)",
               r"CAST(\1 AS double precision)", s, flags=re.I)
    s = re.sub(r"CAST\s*\(([^)]+?)\s+AS\s+INTEGER\s*\)",
               r"CAST(\1 AS bigint)", s, flags=re.I)

    # INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING (if not already present)
    if re.search(r"\bINSERT\s+OR\s+IGNORE\b", s, flags=re.I):
        s = re.sub(r"\bINSERT\s+OR\s+IGNORE\b", "INSERT", s, flags=re.I)
        if not re.search(r"ON\s+CONFLICT", s, flags=re.I):
            s = re.sub(r";?\s*$", " ON CONFLICT DO NOTHING", s)

    return s


def translate(sql: str, use_pg: "bool | None" = None) -> str:
    """Full translation: function/syntax mapping (PG only), then placeholder conversion.

    `use_pg=None` reads the USE_POSTGRES env var; pass explicitly in tests.
    """
    if use_pg is None:
        use_pg = use_postgres()
    if use_pg:
        sql = map_sqlite_functions(sql)
    return convert_placeholders(sql)


try:
    import numpy as np
except ImportError:
    np = None


def _clean_value(v):
    if np is not None and isinstance(v, np.generic):
        return v.item()
    if isinstance(v, (list, tuple)):
        return type(v)(_clean_value(x) for x in v)
    return v


def build_params(params) -> dict:
    """Normalise positional params (tuple/list) into the `:pN` dict the binds expect.
    A dict is passed through unchanged (already-named binds)."""
    if params is None:
        return {}
    if isinstance(params, dict):
        return {k: _clean_value(v) for k, v in params.items()}
    return {f"p{i}": _clean_value(v) for i, v in enumerate(params)}

