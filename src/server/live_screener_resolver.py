#!/usr/bin/env python3
"""
Live Screener Outcome Resolver.
Resolves EOD outcomes (1d, 3d, 5d returns) plus a same-day (intraday) return for
live_screener_appearances.
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

import sys
import datetime
from db_compat import connect, read_df, use_postgres, try_advisory_lock, release_advisory_lock

NIFTY_SYMBOL = "NIFTY50"

# Max plausible same-day deviation between the intraday_ohlcv last bar and the daily close
# before treating the intraday price as a bad symbol/provider mapping rather than real price
# action -- same guard intraday_ranker.py applies (PLAUSIBLE_INTRADAY_DEVIATION) after a live
# mcsymbol mismatch produced a 54x price jump for one symbol.
INTRADAY_DEVIATION_CAP = 0.30

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


def _load_intraday_close_series(symbols, start_date: str, end_date_exclusive: str) -> dict:
    """Last intraday_ohlcv bar's close per (symbol, appearance-date) -- the same-day exit
    price behind return_intraday. Callers fall back to the daily close (from
    _load_price_series) when a symbol/date has no intraday bars, e.g. intraday_fetcher.py
    hadn't run yet for that day."""
    if not symbols:
        return {}
    symbols = sorted(set(symbols))
    if use_postgres():
        df = read_df(
            "SELECT symbol, datetime::date AS d, close FROM intraday_ohlcv "
            "WHERE symbol = ANY(?) AND datetime >= ? AND datetime < ? "
            "ORDER BY symbol, datetime",
            (symbols, start_date, end_date_exclusive),
        )
    else:
        placeholders = ",".join(["?"] * len(symbols))
        df = read_df(
            f"SELECT symbol, substr(datetime,1,10) AS d, close FROM intraday_ohlcv "
            f"WHERE symbol IN ({placeholders}) AND datetime >= ? AND datetime < ? "
            f"ORDER BY symbol, datetime",
            (*symbols, start_date, end_date_exclusive),
        )
    if df.empty:
        return {}
    df["d"] = df["d"].astype(str).str.slice(0, 10)
    last = df.groupby(["symbol", "d"], sort=False).tail(1)
    return {(r["symbol"], r["d"]): r["close"] for _, r in last.iterrows()}


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
            WHERE  o.appearance_id IS NULL OR o.return_5d IS NULL OR o.return_intraday IS NULL
            ORDER  BY r.created_at ASC
            LIMIT  {MAX_PER_RUN}
        """).fetchall()

        if not pending:
            print("[LiveScreenerResolver] No pending appearances to resolve.")
            return

        print(f"[LiveScreenerResolver] Resolving {len(pending)} pending appearances...")

        symbols = {row[1] for row in pending}
        min_run_ts = min(str(row[4])[:10] for row in pending)
        max_run_ts = max(str(row[4])[:10] for row in pending)
        intraday_end_bound = (datetime.date.fromisoformat(max_run_ts) + datetime.timedelta(days=1)).isoformat()
        prices = _load_price_series(symbols, min_run_ts)
        intraday_closes = _load_intraday_close_series(symbols, min_run_ts, intraday_end_bound)

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

            # Same-day exit: last intraday bar on the appearance date, falling back to the
            # daily close when intraday_fetcher.py had no bars that day. entry_price (not
            # entry_close) is the base here -- it's the live price captured the moment the
            # NiftyTrader filter matched, which is what an intraday trade would actually enter at.
            same_day_close = intraday_closes.get((symbol, run_ts))
            if same_day_close is not None and entry_close:
                if abs(same_day_close - entry_close) / entry_close > INTRADAY_DEVIATION_CAP:
                    same_day_close = None
            if same_day_close is None:
                same_day_close = entry_close
            r_intraday = _ret(entry_price, same_day_close)

            if r1 is None and r3 is None and r5 is None and r_intraday is None:
                continue

            alpha_3d = None
            if r3 is not None and nifty is not None:
                n_e = nifty.on_or_after(run_ts)
                n3 = nifty.n_days_after(run_ts, 3)
                if n_e and n3:
                    nifty_r3 = _ret(n_e, n3)
                    alpha_3d = round(r3 - nifty_r3, 4) if nifty_r3 is not None else None

            if dry_run:
                print(f"  [DRY] {app_id} {symbol}: intraday={r_intraday}% 1d={r1}% 3d={r3}% 5d={r5}% alpha3d={alpha_3d}%")
            else:
                to_write.append((app_id, symbol, filter_key, run_ts, entry_price, r1, r3, r5, r_intraday))
            resolved += 1

        if not dry_run and to_write:
            CHUNK = 1000
            for i in range(0, len(to_write), CHUNK):
                conn.executemany("""
                    INSERT INTO live_screener_outcomes
                        (appearance_id, symbol, filter_key, appeared_at,
                         entry_price, return_1d, return_3d, return_5d, return_intraday)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(appearance_id) DO UPDATE SET
                        return_1d = excluded.return_1d,
                        return_3d = excluded.return_3d,
                        return_5d = excluded.return_5d,
                        return_intraday = excluded.return_intraday
                """, to_write[i:i + CHUNK])
            conn.commit()
            print(f"[LiveScreenerResolver] Resolved {resolved} outcomes.")
        else:
            print(f"[LiveScreenerResolver] Dry-run: {resolved} would be resolved.")

        if not dry_run:
            prune_old_appearances(conn)

    except Exception as e:
        print(f"[LiveScreenerResolver] Error: {e}", file=sys.stderr)
        conn.rollback()
        raise
    finally:
        conn.close()
        release_advisory_lock("live_screener_resolver")


# Raw live-screener history is the largest thing this pipeline writes: ~235k appearance rows a
# day, and as of the 2026-07-31 audit live_screener_appearances was 499 MB with
# live_screener_outcomes a further 381 MB -- 880 MB backing a feature family whose best
# individual filter is worth ~0.17% gross per trade. Unbounded, that reaches tens of millions
# of rows within a year.
#
# This is a GROWTH GUARD, not a space reclaim: the data is currently only ~5 weeks old, so at
# the default window nothing is deleted today. The window is deliberately far longer than any
# consumer's lookback -- live_screener_ml_ranker needs >= 10 distinct dates and reads the whole
# outcome history, and neither live_screener_optimizer nor backtest_live_screener bounds its
# own read -- so retention can never silently starve training.
#
# The larger win the audit identified (aggregate to a daily per-(symbol, filter) fact and keep
# raw rows only briefly) is deliberately NOT done here: it changes the shape every consumer
# reads and deserves its own pass with a full consumer inventory.
RETENTION_DAYS = 365


def prune_old_appearances(conn, retention_days: int = RETENTION_DAYS) -> int:
    """Delete appearances (and their outcomes) older than the retention window."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=retention_days)).isoformat()
    try:
        cur = conn.execute(
            "DELETE FROM live_screener_outcomes WHERE appearance_id IN ("
            "  SELECT a.id FROM live_screener_appearances a"
            "  JOIN live_screener_runs r ON r.id = a.run_id WHERE r.timestamp < ?)", (cutoff,))
        n_out = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        cur = conn.execute(
            "DELETE FROM live_screener_appearances WHERE run_id IN ("
            "  SELECT id FROM live_screener_runs WHERE timestamp < ?)", (cutoff,))
        n_app = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        conn.commit()
        if n_app or n_out:
            print(f"[LiveScreenerResolver] Retention: pruned {n_app} appearances / "
                  f"{n_out} outcomes older than {cutoff} ({retention_days}d).")
        return n_app
    except Exception as e:
        # Retention must never fail the resolve run -- the outcomes it just wrote matter more.
        conn.rollback()
        print(f"[LiveScreenerResolver] Retention skipped: {str(e)[:120]}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    resolve_outcomes("--dry-run" in sys.argv)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
