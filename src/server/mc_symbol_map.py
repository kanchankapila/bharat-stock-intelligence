"""Reverse map from MoneyControl's `mcsymbol` to the NSE symbol, built safely.

AF-20260918-02. `mcsymbol` looks like a unique MoneyControl code and is not. Measured live
2026-09-18 against `nse_stocks`: **2,340 rows carry an mcsymbol but only 2,274 codes are
distinct — 62 codes map to more than one NSE symbol.** The collisions are not obscure:

    KMF  -> {KOTAK, KOTAKBANK, MAHINDRA}      <- KOTAKBANK is a Nifty 50 constituent
    TEL  -> {TATAMOTORS, TMPV, TOUCHWOOD}
    TT08 -> {TIMETECHNO, TIMEX, TRIGYN}
    AI   -> {AARTIIND, ARCHIDPLY}
    AIS  -> {ACEINTEG, ASAHIINDIA}

The idiom this module exists to replace is a dict comprehension:

    mc_to_symbol = {row["mcsymbol"]: row["symbol"] for row in rows}   # WRONG

That keeps whichever row the query happened to return LAST, so a real MoneyControl payload for
Kotak Mahindra Bank can be booked against Mahindra with no error anywhere -- silent
misattribution, which is worse than a miss. `data-sources.md`'s rule is "never guess", and
"whichever one the query listed last" is a guess.

`recurring-bugs.md` records this class from the `stocklist.json` side (39 of 1,940 codes there);
these are the `nse_stocks` call sites of the same class, found 2026-09-18 while onboarding the
MoneyControl block-deal history route.

Dropping an ambiguous code costs the affected names their MoneyControl-derived rows. That is the
intended trade: `credit_rating_fetcher.py` makes the identical call for ISIN issuer prefixes
("skipping ambiguous prefixes costs 13 rows and gets the rest right").
"""
from __future__ import annotations

from typing import Iterable


def build_mc_to_symbol(rows: Iterable, *, log=None) -> dict[str, str]:
    """`mcsymbol -> symbol`, keeping only codes that map to exactly ONE symbol.

    `rows` is anything yielding mappings/sequences with `mcsymbol` and `symbol` -- a DBAPI
    cursor's rows, dicts, or (symbol, mcsymbol) tuples are all fine.

    Returns the unambiguous map. Ambiguous codes are omitted entirely, never resolved
    arbitrarily. Pass `log` (a callable) to report how many were dropped; a fetcher that
    silently loses names is the thing this module is trying to prevent, so callers should.
    """
    by_code: dict[str, set[str]] = {}
    for row in rows:
        try:
            code = row["mcsymbol"]
            symbol = row["symbol"]
        except (TypeError, KeyError, IndexError):
            # tuple/sequence form, assumed (symbol, mcsymbol) to match the SELECT order used
            # by the call sites.
            symbol, code = row[0], row[1]
        if not code or not symbol:
            continue
        by_code.setdefault(str(code).strip(), set()).add(str(symbol).strip())

    unambiguous = {code: next(iter(syms)) for code, syms in by_code.items() if len(syms) == 1}
    dropped = {code: sorted(syms) for code, syms in by_code.items() if len(syms) > 1}
    if log is not None and dropped:
        sample = ", ".join(f"{c} -> {'/'.join(s)}" for c, s in sorted(dropped.items())[:5])
        log(
            f"[mc_symbol_map] {len(unambiguous)} unambiguous codes; "
            f"DROPPED {len(dropped)} ambiguous (never guessed): {sample}"
            + (" ..." if len(dropped) > 5 else "")
        )
    return unambiguous


def ambiguous_mc_codes(rows: Iterable) -> dict[str, list[str]]:
    """The codes `build_mc_to_symbol` drops, for reporting/diagnostics."""
    by_code: dict[str, set[str]] = {}
    for row in rows:
        try:
            code, symbol = row["mcsymbol"], row["symbol"]
        except (TypeError, KeyError, IndexError):
            symbol, code = row[0], row[1]
        if not code or not symbol:
            continue
        by_code.setdefault(str(code).strip(), set()).add(str(symbol).strip())
    return {c: sorted(s) for c, s in by_code.items() if len(s) > 1}
