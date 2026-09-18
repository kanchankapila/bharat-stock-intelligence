"""
Safe batch UPDATE against a compressed TimescaleDB hypertable (stock_ohlcv, intraday_ohlcv).

A predicate-wide UPDATE/DELETE against either of these tables forces Timescale to decompress
every chunk it might touch before it can apply the write -- on stock_ohlcv that has hit
"tuple decompression limit exceeded" at 2.2M tuples, and even short of that limit it
permanently destroys the chunk's compression ratio once decompressed. The fix (set the
decompression-limit override to unlimited for this transaction, then update by explicit
(symbol, date) key so only the chunks actually touched decompress) was, until now, a
tribal-knowledge comment repeated by hand at each of its two call sites (ohlcv_quality.py,
data_integrity_repair.py) rather than an enforced code path -- exactly the gap a new writer
against either table has no way to discover except by hitting the limit in production first.
"""
from typing import Sequence, Tuple, Optional


def safe_keyed_update(conn, sql: str, params_list: Sequence[Tuple], *,
                       batch_size: Optional[int] = None) -> int:
    """Apply `sql` (an UPDATE with ? placeholders, e.g.
    "UPDATE stock_ohlcv SET is_suspect=1 WHERE symbol=? AND date=?") once per tuple in
    `params_list`, against a compressed hypertable, without ever attempting a predicate-wide
    write. Returns the number of rows submitted (not necessarily the number matched).

    `batch_size=None` (the default) submits every row in a single executemany + one commit --
    matches ohlcv_quality.py's original unbatched call exactly. Pass an explicit batch_size to
    commit incrementally instead -- matches data_integrity_repair.py's original 50-row-batch
    loop, useful when the write set is large enough that holding one long transaction open is
    itself undesirable.
    """
    if not params_list:
        return 0

    conn.execute("SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0")

    if batch_size is None:
        conn.executemany(sql, list(params_list))
        conn.commit()
        return len(params_list)

    done = 0
    items = list(params_list)
    for i in range(0, len(items), batch_size):
        batch = items[i:i + batch_size]
        for params in batch:
            conn.execute(sql, params)
        conn.commit()
        done += len(batch)
    return done
