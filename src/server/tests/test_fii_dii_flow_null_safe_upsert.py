"""AF-20260917-16: four sources upsert `fii_dii_flow` on a PK of `(date)` alone.

`data-sources.md`'s composite-key rule asks "can more than one fetcher independently write a
row for this exact key?" -- here the answer is four (investsights 1,911 rows, tradebrains 660,
NSE 39, NSE_PROVISIONAL 15). Widening the PK to `(source, date)` would change the table's read
contract from one-row-per-date to many and force every consumer to pick a source or aggregate,
so the cheaper fix was chosen instead: make the merge NULL-safe, so whoever writes last can
add columns but can never erase one it has no value for.

Measured damage before the fix: 5 dates in the 2023-11-01..2026-06-30 overlap window where an
`investsights` row carrying nets only had overwritten a `tradebrains` row that held the gross
buy/sell breakdown.

Negative control: revert any `COALESCE(excluded.x, fii_dii_flow.x)` back to `excluded.x` and
`test_null_from_second_source_does_not_erase_gross` fails -- the gross columns come back NULL.
"""
import os
import pathlib
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402


DDL = """
CREATE TABLE fii_dii_flow (
    date      text PRIMARY KEY,
    fii_buy   double precision,
    fii_sell  double precision,
    fii_net   double precision,
    dii_buy   double precision,
    dii_sell  double precision,
    dii_net   double precision,
    source    text,
    fetched_at text
)
"""

UPSERT = """
INSERT INTO fii_dii_flow (date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT(date) DO UPDATE SET
  fii_buy  = COALESCE(excluded.fii_buy,  fii_dii_flow.fii_buy),
  fii_sell = COALESCE(excluded.fii_sell, fii_dii_flow.fii_sell),
  fii_net  = COALESCE(excluded.fii_net,  fii_dii_flow.fii_net),
  dii_buy  = COALESCE(excluded.dii_buy,  fii_dii_flow.dii_buy),
  dii_sell = COALESCE(excluded.dii_sell, fii_dii_flow.dii_sell),
  dii_net  = COALESCE(excluded.dii_net,  fii_dii_flow.dii_net),
  source   = excluded.source
"""


def test_null_from_second_source_does_not_erase_gross():
    """tradebrains writes gross+net; investsights then writes nets only. Gross must survive."""
    with pg_memory_conn() as con:
        con.execute(DDL)
        con.execute(UPSERT, ("2026-05-04", 17431.96, 13808.45, 3623.51,
                             17979.63, 19843.66, -1864.03, "tradebrains"))
        # investsights supplies nets only before ~2024 and on some later dates.
        con.execute(UPSERT, ("2026-05-04", None, None, 3623.51,
                             None, None, -1864.03, "investsights"))
        row = con.execute(
            "SELECT fii_buy, fii_sell, dii_buy, dii_sell, source FROM fii_dii_flow "
            "WHERE date = ?", ("2026-05-04",)).fetchone()
    assert row[0] == 17431.96, "fii_buy was erased by a source that had no gross data"
    assert row[1] == 13808.45, "fii_sell was erased by a source that had no gross data"
    assert row[2] == 17979.63
    assert row[3] == 19843.66
    # The merge is NULL-safe, not write-once: the newest writer still stamps `source`.
    assert row[4] == "investsights"


def test_a_real_value_still_supersedes_an_earlier_one():
    """Non-vacuity: COALESCE must not freeze the row. NSE final must beat NSE_PROVISIONAL."""
    with pg_memory_conn() as con:
        con.execute(DDL)
        con.execute(UPSERT, ("2026-09-17", 100.0, 90.0, 10.0, 80.0, 70.0, 10.0,
                             "NSE_PROVISIONAL"))
        con.execute(UPSERT, ("2026-09-17", 111.0, 99.0, 12.0, 88.0, 77.0, 11.0, "NSE"))
        row = con.execute(
            "SELECT fii_buy, fii_net, dii_sell, source FROM fii_dii_flow WHERE date = ?",
            ("2026-09-17",)).fetchone()
    assert row[0] == 111.0, "a real provisional value blocked the real final value"
    assert row[1] == 12.0
    assert row[2] == 77.0
    assert row[3] == "NSE"


def test_every_fii_dii_flow_upsert_in_the_repo_is_null_safe():
    """Derived from source, so a FIFTH writer cannot reintroduce the class.

    The two tests above pin the SQL this test file declares, which proves the pattern is
    correct but not that production uses it. `fii_dii_history_fetcher.py` is exempt: it does
    the same merge in Python (skips None, fills only NULLs unless --overwrite) rather than in
    an ON CONFLICT clause.
    """
    root = pathlib.Path(__file__).resolve().parents[1]
    gross_cols = ("fii_buy", "fii_sell", "fii_net", "dii_buy", "dii_sell", "dii_net")
    offenders = []
    for path in sorted(root.glob("*.py")):
        src = path.read_text(encoding="utf-8", errors="replace")
        if "fii_dii_flow" not in src or "ON CONFLICT" not in src:
            continue
        for n, line in enumerate(src.splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("--") or stripped.startswith("#"):
                continue
            for col in gross_cols:
                # The clobbering shape is `<col> = excluded.<col>` with no COALESCE guard.
                if f"excluded.{col}" in stripped and "COALESCE" not in stripped:
                    offenders.append(f"{path.name}:{n}: {stripped}")
                    break
    assert not offenders, (
        "an fii_dii_flow upsert assigns a value column straight from `excluded`, so a source "
        "with no value for it erases the source that had one (AF-20260917-16):\n  "
        + "\n  ".join(offenders))


def test_the_scan_above_is_not_vacuous():
    """The scan must actually be reaching the production writers it is meant to guard."""
    root = pathlib.Path(__file__).resolve().parents[1]
    seen = [p.name for p in root.glob("*.py")
            if "fii_dii_flow" in p.read_text(encoding="utf-8", errors="replace")
            and "ON CONFLICT" in p.read_text(encoding="utf-8", errors="replace")]
    assert "fii_dii_fetcher.py" in seen, "scan no longer reaches fii_dii_fetcher.py"
    assert "fii_dii_backfill.py" in seen, "scan no longer reaches fii_dii_backfill.py"
