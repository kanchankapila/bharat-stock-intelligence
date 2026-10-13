"""Instrument identity.

An instrument is the thing that trades; a symbol is its label over a date range. Legacy keyed
everything on the *current* NSE symbol, so a rename split one company's history in two and a
delisted name vanished from every backtest (2,436 of 2,450 symbols in 5.5 years of history
were still trading — a universe pre-selected on survival).
"""
from __future__ import annotations

import datetime as dt

import psycopg
from psycopg import sql


def _referencing_tables(cur: psycopg.Cursor) -> list[str]:
    """Every table with a foreign key to alpha.instrument, read from the catalog: a hand-kept list
    went stale as tables were added, and the merge's DELETE then failed on the forgotten ones."""
    cur.execute("""SELECT DISTINCT conrelid::regclass::text FROM pg_constraint
                   WHERE contype = 'f' AND confrelid = 'alpha.instrument'::regclass""")
    return sorted(r[0] for r in cur.fetchall())


def _instrument_identity_keys(cur: psycopg.Cursor, table: str) -> list[list[str]]:
    """Primary/unique keys whose identity includes instrument_id.

    A rename merge can find both the historical and current symbol represented on the same
    logical row (for example one imported external_fact per source/field/timestamp). Updating
    the duplicate id directly then violates that table's primary key. Catalog discovery keeps
    this aligned with new instrument-owned tables instead of growing another hand-kept list.
    """
    schema, name = table.split(".", 1)
    cur.execute(
        """SELECT tc.constraint_name, kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               USING (constraint_catalog, constraint_schema, constraint_name,
                      table_catalog, table_schema, table_name)
            WHERE tc.table_schema=%s AND tc.table_name=%s
              AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
              AND tc.constraint_name IN (
                  SELECT tc2.constraint_name
                    FROM information_schema.table_constraints tc2
                    JOIN information_schema.key_column_usage kcu2
                      USING (constraint_catalog, constraint_schema, constraint_name,
                             table_catalog, table_schema, table_name)
                   WHERE tc2.table_schema=%s AND tc2.table_name=%s
                     AND tc2.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
                   GROUP BY tc2.constraint_name
                  HAVING bool_or(kcu2.column_name='instrument_id'))
            ORDER BY tc.constraint_name, kcu.ordinal_position""",
        (schema, name, schema, name),
    )
    grouped: dict[str, list[str]] = {}
    for constraint, column in cur.fetchall():
        grouped.setdefault(constraint, []).append(column)
    return list(grouped.values())


def _drop_identity_collisions(cur: psycopg.Cursor, table: str, keep: int, other: int) -> None:
    """Drop only duplicate-id rows that would collide when `other` is repointed to `keep`.

    The surviving instrument's row wins. All relevant columns are PRIMARY KEY members and
    therefore non-NULL in the current schema. Composite-parent tables are deliberately left
    to their ON UPDATE CASCADE relationships (0011/0012); their children must move atomically.
    """
    if table in {"alpha.prediction", "alpha.session_pick"}:
        return
    schema, name = table.split(".", 1)
    ident = sql.Identifier(schema, name)
    for key in _instrument_identity_keys(cur, table):
        peers = [c for c in key if c != "instrument_id"]
        same_key = sql.SQL(" AND ").join(
            sql.SQL("k.{0} = o.{0}").format(sql.Identifier(c)) for c in peers
        ) if peers else sql.SQL("TRUE")
        cur.execute(
            sql.SQL("DELETE FROM {t} o USING {t} k "
                    "WHERE o.instrument_id=%s AND k.instrument_id=%s AND {same}").format(
                        t=ident, same=same_key),
            (other, keep),
        )


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
                # one provider key per instrument: the surviving id's mapping wins
                cur.execute("""DELETE FROM alpha.provider_id p WHERE instrument_id = %s AND EXISTS (
                                   SELECT 1 FROM alpha.provider_id q WHERE q.instrument_id = %s AND q.provider = p.provider)""",
                            (other, keep))
                for t in _referencing_tables(cur):
                    _drop_identity_collisions(cur, t, keep, other)
                    schema, name = t.split(".", 1)
                    cur.execute(
                        sql.SQL("UPDATE {} SET instrument_id=%s WHERE instrument_id=%s")
                           .format(sql.Identifier(schema, name)),
                        (keep, other),
                    )
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
