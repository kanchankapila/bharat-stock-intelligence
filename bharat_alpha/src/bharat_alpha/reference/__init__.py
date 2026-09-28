"""Instrument identity.

An instrument is the thing that trades; a symbol is its label over a date range. Legacy keyed
everything on the *current* NSE symbol, so a rename split one company's history in two and a
delisted name vanished from every backtest (2,436 of 2,450 symbols in 5.5 years of history
were still trading — a universe pre-selected on survival).
"""
from __future__ import annotations

import datetime as dt

import psycopg

# Tables holding instrument_id foreign keys; merged when two ids turn out to be one company.
_FK_TABLES = ("daily_bar", "adjustment", "fo_daily", "corporate_event", "deal", "fundamental")


class SymbolResolver:
    """symbol@date -> instrument_id, creating instruments for never-seen symbols."""

    def __init__(self, conn: psycopg.Connection):
        self.conn = conn
        self._cache: dict[str, list[tuple[dt.date, dt.date | None, int]]] = {}
        self._load()

    def _load(self) -> None:
        self._cache.clear()
        with self.conn.cursor() as cur:
            cur.execute("SELECT symbol, valid_from, valid_to, instrument_id FROM alpha.symbol_history")
            for sym, vf, vt, iid in cur.fetchall():
                self._cache.setdefault(sym, []).append((vf, vt, iid))

    def lookup(self, symbol: str, on: dt.date) -> int | None:
        for vf, vt, iid in self._cache.get(symbol, ()):
            if vf <= on and (vt is None or on <= vt):
                return iid
        return None

    def resolve(self, symbol: str, on: dt.date, isin: str | None = None) -> int:
        symbol = symbol.strip().upper()
        iid = self.lookup(symbol, on)
        if iid is None:
            iid = self._extend_or_create(symbol, on, isin)
        self._touch(iid, on)
        return iid

    def _extend_or_create(self, symbol: str, on: dt.date, isin: str | None) -> int:
        with self.conn.cursor() as cur:
            # Same symbol seen later (backfill running backwards): extend its range back.
            for vf, vt, iid in sorted(self._cache.get(symbol, ())):
                if vt is None and on < vf:
                    cur.execute(
                        "UPDATE alpha.symbol_history SET valid_from = %s WHERE symbol = %s AND valid_from = %s",
                        (on, symbol, vf),
                    )
                    self._load()
                    return iid
            if isin:
                cur.execute("SELECT instrument_id FROM alpha.instrument WHERE isin = %s", (isin,))
                r = cur.fetchone()
                if r:
                    iid = r[0]
                    cur.execute(
                        "INSERT INTO alpha.symbol_history(instrument_id, symbol, valid_from) VALUES (%s,%s,%s)",
                        (iid, symbol, on),
                    )
                    self._load()
                    return iid
            cur.execute(
                "INSERT INTO alpha.instrument(isin, first_seen, last_seen) VALUES (%s,%s,%s) RETURNING instrument_id",
                (isin, on, on),
            )
            iid = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO alpha.symbol_history(instrument_id, symbol, valid_from) VALUES (%s,%s,%s)",
                (iid, symbol, on),
            )
        self._cache.setdefault(symbol, []).append((on, None, iid))
        return iid

    def _touch(self, iid: int, on: dt.date) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE alpha.instrument SET first_seen = LEAST(first_seen, %s), last_seen = GREATEST(last_seen, %s) "
                "WHERE instrument_id = %s AND (first_seen > %s OR last_seen < %s)",
                (on, on, iid, on, on),
            )


def apply_symbol_change(conn: psycopg.Connection, old: str, new: str, effective: dt.date) -> int:
    """Record an NSE rename. If the new symbol already has its own instrument (because bars were
    ingested before the rename was known), merge it into the old one. Returns the surviving id."""
    old, new = old.strip().upper(), new.strip().upper()
    with conn.cursor() as cur:
        cur.execute(
            "SELECT instrument_id, valid_from FROM alpha.symbol_history WHERE symbol=%s AND valid_from < %s "
            "ORDER BY valid_from DESC LIMIT 1",
            (old, effective),
        )
        r = cur.fetchone()
        if r is None:
            raise ValueError(f"no history for {old} before {effective}")
        keep, old_from = r
        cur.execute(
            "UPDATE alpha.symbol_history SET valid_to = %s WHERE symbol = %s AND valid_from = %s",
            (effective - dt.timedelta(days=1), old, old_from),
        )
        cur.execute(
            "SELECT instrument_id, valid_from FROM alpha.symbol_history WHERE symbol=%s AND valid_from >= %s",
            (new, effective),
        )
        dup = cur.fetchall()
        for other, vf in dup:
            if other != keep:
                for t in _FK_TABLES:
                    cur.execute(f"UPDATE alpha.{t} SET instrument_id=%s WHERE instrument_id=%s", (keep, other))
                cur.execute("UPDATE alpha.symbol_history SET instrument_id=%s WHERE instrument_id=%s", (keep, other))
                cur.execute("UPDATE alpha.provider_id SET instrument_id=%s WHERE instrument_id=%s", (keep, other))
                cur.execute(
                    "UPDATE alpha.instrument i SET first_seen = LEAST(i.first_seen, o.first_seen), "
                    "last_seen = GREATEST(i.last_seen, o.last_seen) FROM alpha.instrument o "
                    "WHERE i.instrument_id=%s AND o.instrument_id=%s",
                    (keep, other),
                )
                cur.execute("DELETE FROM alpha.instrument WHERE instrument_id=%s", (other,))
        if not dup:
            cur.execute(
                "INSERT INTO alpha.symbol_history(instrument_id, symbol, valid_from) VALUES (%s,%s,%s)",
                (keep, new, effective),
            )
    return keep


def current_symbols(conn: psycopg.Connection) -> dict[int, str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT ON (instrument_id) instrument_id, symbol FROM alpha.symbol_history "
            "ORDER BY instrument_id, valid_from DESC"
        )
        return dict(cur.fetchall())
