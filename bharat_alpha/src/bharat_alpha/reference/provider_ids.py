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


# NSE's index-file industry names -> the broader GICS-style taxonomy the legacy master uses.
# Two sources populate alpha.instrument.sector and they classify differently; left unmapped the
# column carries BOTH, and the portfolio's sector cap then treats "Financials" and "Financial
# Services" as different sectors -- two 25% caps over one real sector, which is weaker risk
# control than the sparse-but-consistent column it replaced. Mapping to one taxonomy is what
# makes the cap mean anything (AF-20260929-10).
SECTOR_ALIASES = {
    "financial services": "Financials",
    "capital goods": "Industrials",
    "construction": "Industrials",
    "services": "Industrials",
    "automobile and auto components": "Consumer Discretionary",
    "consumer durables": "Consumer Discretionary",
    "consumer services": "Consumer Discretionary",
    "textiles": "Consumer Discretionary",
    "fast moving consumer goods": "Consumer Staples",
    "chemicals": "Materials",
    "metals & mining": "Materials",
    "construction materials": "Materials",
    "oil gas & consumable fuels": "Energy",
    "power": "Utilities",
    "realty": "Real Estate",
    # GICS has Communication Services as the SECTOR, with telecom inside it; the legacy
    # master emits both names, so they must collapse one way and this is the correct one.
    "telecommunication": "Communication Services",
    "telecommunications": "Communication Services",
    "media & entertainment": "Communication Services",
    "media entertainment & publication": "Communication Services",
    "healthcare": "Healthcare",
    "information technology": "Information Technology",
    "diversified": "Industrials",
}
# A literal "Unknown" label is NOT a sector -- it reads as populated while carrying no
# information, which is worse than NULL because nothing flags it as missing.
NOT_A_SECTOR = {"unknown", "", "-", "n/a", "na", "none", "other", "others"}


def normalise_sector(raw: str | None) -> str | None:
    """One taxonomy, or None. Never invent a bucket."""
    if raw is None:
        return None
    key = " ".join(str(raw).split()).strip().lower()
    if key in NOT_A_SECTOR:
        return None
    return SECTOR_ALIASES.get(key, " ".join(str(raw).split()).strip())


def import_legacy_sectors(conn: psycopg.Connection, legacy: psycopg.Connection) -> dict:
    """Sector labels from the legacy `nse_stocks` master, which is 100% populated (2,366 rows,
    14 sectors) and maintained by `src/server/backfill_sectors.py`.

    Why this exists: `nse_constituents` only ever covers the NIFTY 500 -- its own Health declares
    `fill_rates={"sector": 0.2}` -- so `alpha.instrument.sector` sat at 11.7%, and the portfolio's
    sector cap ended up binding on the `__unknown__` bucket holding 88% of the universe, quietly
    capping gross exposure instead of diversifying it (AF-20260929-10).

    Existing labels WIN. `nse_constituents` reads NSE's own industry classification for index
    members and is the more authoritative of the two; this only fills the gap it leaves.
    """
    rows = legacy.execute("SELECT symbol, sector FROM nse_stocks WHERE sector IS NOT NULL AND symbol IS NOT NULL").fetchall()
    cur_syms = read_df(conn, """SELECT DISTINCT ON (instrument_id) instrument_id, symbol FROM alpha.symbol_history
                                ORDER BY instrument_id, valid_from DESC""")
    sym_to_iid = dict(zip(cur_syms.symbol, cur_syms.instrument_id))

    # A symbol carrying two different sector labels is ambiguous and is dropped, not last-wins.
    by_sym: dict[str, set[str]] = defaultdict(set)
    for sym, sector in rows:
        norm = normalise_sector(sector)
        if norm:
            by_sym[str(sym).strip().upper()].add(norm)
    ambiguous = {s: v for s, v in by_sym.items() if len(v) > 1}

    filled, unmatched = 0, 0
    with conn.cursor() as cur:
        for sym, sectors in by_sym.items():
            if len(sectors) > 1:
                continue
            iid = sym_to_iid.get(sym)
            if iid is None:
                unmatched += 1
                continue
            cur.execute("UPDATE alpha.instrument SET sector = %s WHERE instrument_id = %s AND sector IS NULL",
                        (next(iter(sectors)), int(iid)))
            filled += cur.rowcount
    conn.commit()
    return {"legacy_rows": len(rows), "distinct_symbols": len(by_sym), "filled": filled,
            "unmatched_symbol": unmatched, "ambiguous": sorted(ambiguous)[:10]}
