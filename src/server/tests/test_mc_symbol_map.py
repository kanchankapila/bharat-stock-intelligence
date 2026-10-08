"""An mcsymbol reverse map must never resolve an ambiguous code by row order.

AF-20260918-02. Measured live 2026-09-18 against `nse_stocks`: 2,340 rows carry an mcsymbol but
only 2,274 codes are distinct -- **62 codes map to more than one NSE symbol**, and they are not
obscure names: `KMF -> {KOTAK, KOTAKBANK, MAHINDRA}`, `TEL -> {TATAMOTORS, TMPV, TOUCHWOOD}`,
`AI -> {AARTIIND, ARCHIDPLY}`.

Two live call sites built the map as `{row["mcsymbol"]: row["symbol"] for row in rows}`, which
keeps whichever row the query returned LAST -- so MoneyControl data for Kotak Mahindra Bank could
be written against Mahindra with no error anywhere. Silent misattribution is worse than a miss.

Negative control: replace `build_mc_to_symbol(...)` with the dict comprehension and
`test_ambiguous_code_is_dropped_not_guessed` fails -- the code resolves to the last symbol seen.
"""
import os
import pathlib
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from mc_symbol_map import build_mc_to_symbol, ambiguous_mc_codes  # noqa: E402


# Shaped like the real SELECT: (symbol, mcsymbol), which is the order both call sites use.
ROWS = [
    ("KOTAK", "KMF"),
    ("KOTAKBANK", "KMF"),
    ("MAHINDRA", "KMF"),
    ("RELIANCE", "RI"),
    ("TCS", "TCS"),
    ("AARTIIND", "AI"),
    ("ARCHIDPLY", "AI"),
]


def test_unambiguous_codes_resolve():
    m = build_mc_to_symbol(ROWS)
    assert m["RI"] == "RELIANCE"
    assert m["TCS"] == "TCS"


def test_ambiguous_code_is_dropped_not_guessed():
    """The load-bearing case: KMF must resolve to NOTHING, not to whichever row came last."""
    m = build_mc_to_symbol(ROWS)
    assert "KMF" not in m, (
        f"KMF resolved to {m.get('KMF')!r} -- an ambiguous MoneyControl code was guessed by row "
        f"order, which books one company's data against another (AF-20260918-02)"
    )
    assert "AI" not in m


def test_dropping_is_reported_when_a_logger_is_passed():
    """A fetcher that silently loses names is the thing this module exists to prevent."""
    seen = []
    build_mc_to_symbol(ROWS, log=seen.append)
    assert seen, "ambiguous codes were dropped with no report"
    assert "DROPPED 2 ambiguous" in seen[0]


def test_ambiguous_codes_are_enumerable():
    amb = ambiguous_mc_codes(ROWS)
    assert amb["KMF"] == ["KOTAK", "KOTAKBANK", "MAHINDRA"]
    assert "RI" not in amb


def test_accepts_mapping_rows_too():
    """Call sites pass DBAPI rows that index by name, not position."""
    rows = [{"symbol": "KOTAK", "mcsymbol": "KMF"}, {"symbol": "KOTAKBANK", "mcsymbol": "KMF"},
            {"symbol": "RELIANCE", "mcsymbol": "RI"}]
    m = build_mc_to_symbol(rows)
    assert m == {"RI": "RELIANCE"}


def test_no_call_site_rebuilds_the_map_by_dict_comprehension():
    """Derived from source, so a THIRD call site cannot reintroduce the class.

    The two known sites are eps_surprise_fetcher.py and mc_techscanner_fetcher.py; scanning
    instead of listing them means a new fetcher fails here rather than silently misattributing.
    """
    root = pathlib.Path(__file__).resolve().parents[1]
    offenders = []
    for path in sorted(root.glob("*.py")):
        if path.name == "mc_symbol_map.py":
            continue
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            # The clobbering shape: a dict comprehension KEYED on an mcsymbol field.
            if '["mcsymbol"]:' in stripped or "['mcsymbol']:" in stripped:
                offenders.append(f"{path.name}:{n}: {stripped}")
    assert not offenders, (
        "an mcsymbol reverse map is built by dict comprehension, so 62 ambiguous codes resolve "
        "to whichever row came last (AF-20260918-02). Use mc_symbol_map.build_mc_to_symbol:\n  "
        + "\n  ".join(offenders))


# The SQL shape of the same class: `JOIN nse_stocks ns ON ns.mcsymbol = x.scid` FANS OUT one
# provider row to every symbol sharing the code (A-03, 2026-10-08: Bajaj Finance's result date
# was written to BAJAJST, Adani Power's to EMPOWER). The dict scan above cannot see it.
# Ceiling: catches a JOIN on nse_stocks whose ON clause reads that alias's mcsymbol on the same
# line; a comma-join with the predicate in WHERE would slip past.
import re  # noqa: E402

_SQL_FANOUT = re.compile(
    r"JOIN\s+nse_stocks\s+(?:AS\s+)?(\w+)\s+ON\s+[^\n]*\b\1\.mcsymbol\b", re.IGNORECASE)


def test_sql_fanout_scan_matches_the_shape_it_guards():
    assert _SQL_FANOUT.search("JOIN nse_stocks ns ON ns.mcsymbol = sed.scid")
    assert _SQL_FANOUT.search("LEFT JOIN nse_stocks n ON e.scid = n.mcsymbol")
    assert not _SQL_FANOUT.search("JOIN nse_stocks ns ON ns.symbol = ts.symbol")


def test_no_sql_joins_nse_stocks_on_mcsymbol():
    root = pathlib.Path(__file__).resolve().parents[1]
    offenders = []
    for path in sorted(root.glob("*.py")):
        if path.name == "mc_symbol_map.py":
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in _SQL_FANOUT.finditer(text):
            offenders.append(f"{path.name}:{text.count(chr(10), 0, m.start()) + 1}: {m.group(0)}")
    assert not offenders, (
        "SQL joins nse_stocks on the ambiguous mcsymbol, fanning one MoneyControl row out to "
        "every symbol sharing the code. Join mc_symbol_map.MC_TO_SYMBOL_SQL instead:\n  "
        + "\n  ".join(offenders))


def test_sql_map_drops_exactly_what_build_mc_to_symbol_drops():
    """The SQL twin must be the same rule as the Python builder, not a second mapping."""
    from pg_test_support import pg_memory_conn
    from mc_symbol_map import MC_TO_SYMBOL_SQL

    conn = pg_memory_conn()
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT, mcsymbol TEXT)")
    for sym, code in ROWS + [("BLANK", ""), ("NOCODE", None)]:
        conn.execute("INSERT INTO nse_stocks VALUES (?, ?)", (sym, code))
    got = dict((r[0], r[1]) for r in conn.execute(
        f"SELECT mcsymbol, symbol FROM {MC_TO_SYMBOL_SQL} m").fetchall())
    assert got == build_mc_to_symbol(ROWS) == {"RI": "RELIANCE", "TCS": "TCS"}


def test_the_scan_above_is_not_vacuous():
    """The scan must be reaching the two files it was written for."""
    root = pathlib.Path(__file__).resolve().parents[1]
    for name in ("eps_surprise_fetcher.py", "mc_techscanner_fetcher.py"):
        body = (root / name).read_text(encoding="utf-8", errors="replace")
        assert "build_mc_to_symbol" in body, f"{name} no longer uses the safe builder"
