"""Provider-issued ids, imported explicitly and never constructed by convention.

A code that maps to more than one NSE symbol is AMBIGUOUS and is dropped and reported, never
resolved by "whichever row came last" (legacy: 62 MoneyControl codes mapped to several
symbols — KMF -> {KOTAK, KOTAKBANK, MAHINDRA} — and a dict comprehension silently booked one
company's data against another).
"""
from __future__ import annotations

from collections import defaultdict

import psycopg

from bharat_alpha.db import read_df, upsert


def singleton_map(pairs: list[tuple[str, str]]) -> tuple[dict[str, str], dict[str, set[str]]]:
    """(provider_key, symbol) pairs -> ({key: symbol} for unambiguous keys, {key: symbols} ambiguous)."""
    by_key: dict[str, set[str]] = defaultdict(set)
    for key, sym in pairs:
        if key and sym:
            by_key[key.strip()].add(sym.strip().upper())
    ok = {k: next(iter(v)) for k, v in by_key.items() if len(v) == 1}
    return ok, {k: v for k, v in by_key.items() if len(v) > 1}


def store_provider_ids(conn: psycopg.Connection, provider: str, pairs: list[tuple[str, str]],
                       resolution: str) -> dict:
    ok, ambiguous = singleton_map(pairs)
    cur_syms = read_df(conn, """SELECT DISTINCT ON (instrument_id) instrument_id, symbol FROM alpha.symbol_history
                                ORDER BY instrument_id, valid_from DESC""")
    sym_to_iid = dict(zip(cur_syms.symbol, cur_syms.instrument_id))
    # one key per instrument too: an instrument claimed by two keys is also ambiguous
    by_iid: dict[int, list[str]] = defaultdict(list)
    for k, s in ok.items():
        if s in sym_to_iid:
            by_iid[int(sym_to_iid[s])].append(k)
    rows = [{"provider": provider, "provider_key": ks[0], "instrument_id": iid, "resolution": resolution}
            for iid, ks in by_iid.items() if len(ks) == 1]
    written = upsert(conn, "alpha.provider_id", rows, key=("provider", "provider_key"),
                     update=("instrument_id", "resolution"))
    conn.commit()
    return {"written": written, "ambiguous_keys": len(ambiguous),
            "multi_key_instruments": sum(1 for ks in by_iid.values() if len(ks) > 1),
            "unknown_symbols": sum(1 for s in ok.values() if s not in sym_to_iid),
            "ambiguous_examples": {k: sorted(v) for k, v in list(ambiguous.items())[:5]}}


def provider_keys(conn: psycopg.Connection, provider: str) -> dict[int, str]:
    df = read_df(conn, "SELECT instrument_id, provider_key FROM alpha.provider_id WHERE provider=%s", (provider,))
    return dict(zip(df.instrument_id.astype(int), df.provider_key))


def import_legacy_mc_ids(conn: psycopg.Connection, legacy: psycopg.Connection) -> dict:
    with legacy.cursor() as cur:
        cur.execute("SELECT mcsymbol, symbol FROM public.nse_stocks WHERE mcsymbol IS NOT NULL AND mcsymbol <> ''")
        pairs = cur.fetchall()
    return store_provider_ids(conn, "moneycontrol", pairs, "legacy_master")
