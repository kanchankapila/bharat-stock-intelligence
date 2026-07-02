#!/usr/bin/env python3
"""
Live Screener Outcome Resolver.
Resolves EOD outcomes (1d, 3d, 5d returns) for live_screener_appearances.
"""

import sys
from db_compat import connect, read_df, use_postgres, try_advisory_lock, release_advisory_lock

NIFTY_SYMBOL = "NIFTY50"

# Batched pending-row cap per run: the resolver used to do 3-5 per-row DB round
# trips against stock_ohlcv (see git history) and fell 360k+ rows behind because
# of it. It's now a single windowed pre-load + in-memory lookup, but we still cap
# a single run so one invocation can't hold the write transaction open for hours
# against a pathological backlog — remaining rows just get picked up next run.
MAX_PER_RUN = 50_000


def _ret(entry, exit_p):
    if entry is None or exit_p is None or entry == 0:
        return None
    return round((exit_p - entry) / entry * 100, 4)


class _PriceSeries:
    """Sorted (date, close) lookup for one symbol, replacing the old per-row
    `WHERE date > ? ORDER BY date LIMIT n` / `WHERE date >= ? ORDER BY date LIMIT 1`
    queries with in-memory index math."""

    def __init__(self, dates, closes):
        self.dates = dates      # sorted ascending, list[str] "YYYY-MM-DD"
        self.closes = closes

    def on_or_after(self, start_date: str):
        import bisect
        idx = bisect.bisect_left(self.dates, start_date)
        return self.closes[idx] if idx < len(self.dates) else None

    def n_days_after(self, start_date: str, n: int):
        import bisect
        idx = bisect.bisect_right(self.dates, start_date)
        target = idx + n - 1
        return self.closes[target] if target < len(self.dates) else None


def _load_price_series(symbols, start_date: str) -> dict:
    """One windowed query for every symbol touched by the pending batch,
    instead of a query per (symbol, lookup) pair."""
    symbols = sorted(set(symbols) | {NIFTY_SYMBOL})
    if use_postgres():
        df = read_df(
            "SELECT symbol, date, close FROM stock_ohlcv "
            "WHERE symbol = ANY(?) AND date >= ? ORDER BY symbol, date",
            (symbols, start_date),
        )
    else:
        placeholders = ",".join(["?"] * len(symbols))
        df = read_df(
            f"SELECT symbol, date, close FROM stock_ohlcv "
            f"WHERE symbol IN ({placeholders}) AND date >= ? ORDER BY symbol, date",
            (*symbols, start_date),
        )
    if df.empty:
        return {}
    df["date"] = df["date"].astype(str).str.slice(0, 10)
    out = {}
    for sym, g in df.groupby("symbol", sort=False):
        out[sym] = _PriceSeries(g["date"].tolist(), g["close"].tolist())
    return out


def resolve_outcomes(dry_run=False):
    if not try_advisory_lock("live_screener_resolver"):
        print("[LiveScreenerResolver] Another run is already in progress — skipping.")
        return

    conn = connect()
    try:
        # live_screener_runs uses created_at (not timestamp)
        pending = conn.execute(f"""
            SELECT a.id          AS app_id,
                   a.symbol,
                   a.filter_key,
                   a.price       AS entry_price,
                   r.created_at  AS run_ts
            FROM   live_screener_appearances a
            JOIN   live_screener_runs r ON a.run_id = r.id
            LEFT   JOIN live_screener_outcomes o ON a.id = o.appearance_id
            WHERE  o.appearance_id IS NULL OR o.return_5d IS NULL
            ORDER  BY r.created_at ASC
            LIMIT  {MAX_PER_RUN}
        """).fetchall()

        if not pending:
            print("[LiveScreenerResolver] No pending appearances to resolve.")
            return

        print(f"[LiveScreenerResolver] Resolving {len(pending)} pending appearances...")

        symbols = {row[1] for row in pending}
        min_run_ts = min(str(row[4])[:10] for row in pending)
        prices = _load_price_series(symbols, min_run_ts)

        resolved = 0
        to_write = []
        nifty = prices.get(NIFTY_SYMBOL)

        for row in pending:
            app_id, symbol, filter_key, entry_price, run_ts = (
                row[0], row[1], row[2], row[3], str(row[4])[:10]
            )
            series = prices.get(symbol)

            entry_close = series.on_or_after(run_ts) if series else None
            if entry_close is None:
                entry_close = entry_price      # use live price as fallback

            c1 = series.n_days_after(run_ts, 1) if series else None
            c3 = series.n_days_after(run_ts, 3) if series else None
            c5 = series.n_days_after(run_ts, 5) if series else None

            r1, r3, r5 = _ret(entry_close, c1), _ret(entry_close, c3), _ret(entry_close, c5)

            if r1 is None and r3 is None and r5 is None:
                continue

            alpha_3d = None
            if r3 is not None and nifty is not None:
                n_e = nifty.on_or_after(run_ts)
                n3 = nifty.n_days_after(run_ts, 3)
                if n_e and n3:
                    nifty_r3 = _ret(n_e, n3)
                    alpha_3d = round(r3 - nifty_r3, 4) if nifty_r3 is not None else None

            if dry_run:
                print(f"  [DRY] {app_id} {symbol}: 1d={r1}% 3d={r3}% 5d={r5}% alpha3d={alpha_3d}%")
            else:
                to_write.append((app_id, symbol, filter_key, run_ts, entry_price, r1, r3, r5))
            resolved += 1

        if not dry_run and to_write:
            CHUNK = 1000
            for i in range(0, len(to_write), CHUNK):
                conn.executemany("""
                    INSERT INTO live_screener_outcomes
                        (appearance_id, symbol, filter_key, appeared_at,
                         entry_price, return_1d, return_3d, return_5d)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(appearance_id) DO UPDATE SET
                        return_1d = excluded.return_1d,
                        return_3d = excluded.return_3d,
                        return_5d = excluded.return_5d
                """, to_write[i:i + CHUNK])
            conn.commit()
            print(f"[LiveScreenerResolver] Resolved {resolved} outcomes.")
        else:
            print(f"[LiveScreenerResolver] Dry-run: {resolved} would be resolved.")

    except Exception as e:
        print(f"[LiveScreenerResolver] Error: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()
        release_advisory_lock("live_screener_resolver")


if __name__ == "__main__":
    resolve_outcomes("--dry-run" in sys.argv)
