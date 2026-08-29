"""
Shared point-in-time ("as-of") data-access helper.

Every consumer that needs "the most recent snapshot of a slow-moving fact (fundamentals,
analyst estimates, ...) known as of a given date" was hand-rolling the same correlated-subquery
SQL fragment independently in ml_ensemble.py (6x), exit_policy.py, online_learner.py,
cs_ranker.py (3x), confluence_ml_engine.py -- or a bespoke pandas merge_asof in
feature_engineering.py. This is the ONE place that pattern lives now. A test
(tests/test_as_of_no_hand_rolled_joins.py) fails CI if a new hand-rolled "as of date" join is
added anywhere else under src/server, so this doesn't quietly re-drift.
"""
import polars as pl
from typing import Sequence

import pandas as pd

from db_compat import read_df


def as_of_join_sql(hist_table: str, alias: str, base_alias: str, base_symbol_col: str,
                    base_date_col: str, base_date_is_text: bool = True) -> str:
    """A LEFT JOIN fragment pulling the most recent `hist_table` row for
    `base_alias.base_symbol_col` as of `base_alias.base_date_col` (inclusive).

    Semantically identical to every hand-rolled version this replaces (verified against
    exit_policy.py/cs_ranker.py's pre-migration SQL in tests/test_as_of.py):

        LEFT JOIN <hist_table> <alias>
               ON <alias>.symbol = <base_alias>.<base_symbol_col>
              AND <alias>.as_of_date = (
                  SELECT MAX(<alias>2.as_of_date) FROM <hist_table> <alias>2
                  WHERE <alias>2.symbol = <base_alias>.<base_symbol_col>
                    AND <alias>2.as_of_date <= <base_alias>.<base_date_col>
              )

    `hist_table` is a fixed set of internal table names (never user input) -- safe to
    interpolate directly, matching every call site's existing convention.

    `base_date_is_text=False` for a native-DATE base column (technical_signals.date since
    the 2026-08-25 migration): every history table here (fundamentals_history,
    analyst_estimates_history) carries a TEXT `as_of_date`. Repo convention (recurring-bugs.md,
    fourth recurrence) is to cast the DATE side to `::text`, NOT the TEXT side to `::date` --
    identical ordering for ISO dates on live Postgres, and it keeps SQLite-heritage fixtures
    (which declare every such column TEXT) green under pytest. Default True keeps every
    signal_date-based caller (TEXT) unchanged.
    """
    alias2 = f"{alias}2"
    # Cast ONLY the inner point-in-time predicate's right-hand side. MAX() must stay on the raw
    # TEXT column so the outer equality ({alias}.as_of_date = (SELECT MAX(...))) remains
    # TEXT = TEXT -- casting inside MAX() flips the outer comparison to text = date, which has
    # no operator (caught live 2026-08-26 executing the fragment against production).
    base_ref = f"{base_alias}.{base_date_col}"
    rhs = base_ref if base_date_is_text else f"{base_ref}::text"
    return (
        f"LEFT JOIN {hist_table} {alias}\n"
        f"       ON {alias}.symbol = {base_alias}.{base_symbol_col}\n"
        f"      AND {alias}.as_of_date = (\n"
        f"          SELECT MAX({alias2}.as_of_date) FROM {hist_table} {alias2}\n"
        f"          WHERE {alias2}.symbol = {base_alias}.{base_symbol_col} "
        f"AND {alias2}.as_of_date <= {rhs}\n"
        f"      )"
    )


def read_as_of_history(table: str, symbol: str, columns: Sequence[str]) -> pd.DataFrame:
    """Load a symbol's full as-of history from `table` (as_of_date + the given columns),
    normalized to a sorted, NaT-free, datetime64[ns] `as_of_date` column ready for
    pandas.merge_asof. Extracted from feature_engineering.py's _merge_fundamentals, which
    hand-rolled this same "load, normalize dtype, dropna, sort" boilerplate -- including the
    dtype-resolution fix documented there (PG timestamptz vs SQLite text-parsed as_of_date can
    come back as different datetime64 resolutions; merge_asof requires an exact dtype match).
    """
    cols_sql = ", ".join(["as_of_date"] + list(columns))
    hist = read_df(f"SELECT {cols_sql} FROM {table} WHERE symbol = ? ORDER BY as_of_date", (symbol,))
    if hist.empty:
        return hist
    hist["as_of_date"] = pd.to_datetime(hist["as_of_date"]).astype("datetime64[ns]")
    return hist.dropna(subset=["as_of_date"]).sort_values("as_of_date")


def logical_trading_date(cutoff_hour: int = 4, now=None) -> str:
    """The calendar date this 'trading day' should be considered, tolerant of a post-close
    job chain that spans midnight.

    ml-daily-ops starts ~19:30 IST and its step chain has grown long enough to regularly
    finish after midnight (confirmed via job_heartbeat: a run processing the 2026-07-31
    trading day completed at 2026-08-01 01:23 IST). Any post-close enrichment script that
    took a naive date.today()/datetime.now() as its `UPDATE ... WHERE date = ?` target
    silently wrote into a calendar day that has no grid row yet -- 0 rows matched, no error,
    every time the run crosses midnight (found in insider_features.py, bse_event_classifier.py
    -- insider_features.py's fix for a different bug on 2026-08-01 was itself invisible in
    production for exactly this reason: it was verified by calling compute_insider_features()
    directly, never by confirming the scheduled run's UPDATE actually matched a row).

    Before `cutoff_hour` local time, "today" is treated as yesterday (the trading day whose
    EOD processing is still finishing); at/after it, "today" is the real calendar date. This
    is deliberately NOT the same as anchoring to MAX(date) FROM technical_signals -- that
    would reintroduce the exact failure bse_event_classifier.py's `date = ?` guard (added
    2026-07-19) was written to prevent: silently overwriting an even-older stale row if this
    runs before today's grid exists for some other reason (e.g. a manual backfill at 11am).
    A fixed early-morning cutoff fixes the midnight-crossing case without reopening that one.
    """
    import datetime
    if now is None:
        now = datetime.datetime.now()
    d = now.date()
    if now.hour < cutoff_hour:
        d -= datetime.timedelta(days=1)
    return d.isoformat()


def logical_session_date(cutoff_hour: int = 4, now=None,
                         open_hour: int = 9, open_minute: int = 15) -> str:
    """logical_trading_date(), rolled forward off a weekend to the session it is FOR.

    A third bug class, distinct from both functions around it. The daily pipeline
    deliberately runs early on closed days (queues.ts's closed-day-early-batch dispatches
    outcome-resolver -> ml-daily-ops -> unified-ranker on holidays and weekends), so on a
    Saturday or Sunday the ranker is producing a snapshot for the NEXT session -- not for the
    closed day it happens to be executing on. Taking date.today() as the `computed_at` label
    put 9,096 unified_recommendations rows on days the market never opened (2026-07-05,
    07-12, 07-25 and 08-09, found by the 2026-08-11 reverse audit). Nothing errors: the rows
    are written and are simply unreachable to any consumer that joins on a real trading date,
    and they make the table look like it has snapshots it does not have.

    Weekends only, deliberately. `market_holidays` is built from observed trading gaps and
    currently stops at 2026-04-14, so it cannot answer whether a FUTURE weekday is a holiday
    -- and guessing would be worse than not rolling. The asymmetry is what makes this safe:
    a holiday-dated snapshot is superseded by that holiday's own early-batch run a few hours
    later, whereas a weekend-dated one is never superseded by anything.

    Deliberately NOT logical_write_floor(): that returns the last COMPLETED session
    (MAX(date) FROM stock_ohlcv), so a Monday 07:30 pre-market run would label its output
    with Friday's date and overwrite Friday's snapshot. This function answers "which session
    is this ranking for", which is the next one, not the last one.

    A session whose OPEN has already passed is also rolled forward (2026-08-12). Same question,
    second way of getting it wrong: a ranking produced after 09:15 IST cannot be a signal for
    that day, because nobody could have acted on it. The scheduled run is 02:00 UTC / 07:30 IST
    and is unaffected -- but addJobWithCatchup fires a MISSED run immediately at server boot,
    at whatever hour that happens, and those runs were labelling a closed session. Measured
    2026-08-12: of 37 computed_at dates in unified_recommendations only ONE was provably
    pre-market; the 08-10 batch ran 18:23 UTC (23:53 IST) and the 08-11 batch 20:02 UTC
    (01:32 IST the next day), both stamped with a session that had already closed.

    This does not merely relabel those runs, it makes them useful: a ranking generated at
    01:32 IST is genuinely pre-market for THAT day's 09:15 open, so rolling it forward turns a
    discarded post-close artefact into a gradeable pre-market signal.

    The cost, accepted deliberately: if the pre-market slot is missed entirely and only a late
    catch-up runs, that session gets no ranking at all rather than a mislabelled one. There is
    no honest pre-market signal to give it, and consumers already cold-start-fall-back to
    stock_scores (see scoring-authority.md).
    """
    import datetime
    if now is None:
        now = datetime.datetime.now()
    d = datetime.date.fromisoformat(logical_trading_date(cutoff_hour, now))
    # 5 = Saturday, 6 = Sunday. The open-passed test terminates on its own: once d moves to a
    # future date its open is by definition still ahead of `now`.
    while (d.weekday() >= 5
           or now >= datetime.datetime.combine(d, datetime.time(open_hour, open_minute))):
        d += datetime.timedelta(days=1)
    return d.isoformat()


def logical_write_floor(conn=None, *, fallback: str = None) -> str:
    """The reference date for a "CASE WHEN date >= floor THEN val ELSE NULL END" point-in-time
    write guard -- the ISO date of the most recent session actually present in stock_ohlcv.

    This is a DIFFERENT bug class from logical_trading_date() above: that one fixes an exact-
    match write TARGET (`WHERE date = ?`) around a midnight-crossing job chain. This one fixes
    a write FLOOR used to decide whether an incoming value belongs on today's row or should be
    rejected as stale -- and needs the real last-completed-session date, not a cutoff-hour
    guess, because the caller is asking "does this value's date qualify," not "what date do I
    write into."

    Hand-rolled independently (as `SELECT MAX(date) FROM stock_ohlcv` + str(...)[:10], each with
    its own ad-hoc fallback) in asm_gsm_fetcher.py, mc_pricefeed_fetcher.py, mf_sector_flow_fetcher.py,
    index_membership_fetcher.py, fundamentals_snapshot.py, working_capital_fetcher.py, and others
    across five-plus separate review sessions after the SAME underlying mistake (anchoring to
    date.today() instead of the last real session, which silently NULLs a stock's entire history
    on any day the two don't match -- weekends, holidays, midnight-crossing runs) kept recurring.
    This is the one place that anchor is computed now; a new fetcher has nothing left to
    hand-roll wrong.

    `fallback` is used only if stock_ohlcv is completely empty (fresh DB). Each call site's
    prior ad-hoc behavior is preserved exactly: some pass date.today().isoformat() (or an
    already-computed "today" variable) as their fallback; two (backfill_technical_features.py,
    mc_techscanner_fetcher.py) deliberately pass nothing and check `if not floor:` themselves --
    so the default here is None, NOT today's date, to match that contract precisely rather than
    silently substituting a guess where the original code refused to.
    """
    if conn is not None:
        row = conn.execute("SELECT MAX(date) AS d FROM stock_ohlcv").fetchone()
        d = row["d"] if row is not None else None
    else:
        from db_compat import query_scalar
        d = query_scalar("SELECT MAX(date) AS d FROM stock_ohlcv")

    return str(d)[:10] if d else fallback


def trading_days_back(n: int, conn=None) -> list:
    """The last `n` REAL trading sessions, newest first, as datetime.date objects.

    Fetchers that walk backwards over recent sessions were each hand-rolling
    "step back a day, keep it if weekday() < 5" (delivery_volume_fetcher.py,
    fno_rollover_fetcher.py). That is holiday-blind, so `--days 30` silently covered fewer
    than 30 real sessions whenever a holiday fell in range -- and India has ~15 a year, so
    a month-long window routinely lost one or two days of data with nothing reporting it.

    The exchange's own record is authoritative and always current, so the session list comes
    from stock_ohlcv (falling back to nse_universe_history). Deliberately NOT market_holidays:
    that table is built from observed gaps and currently stops at 2026-04-14, so it cannot
    answer questions about recent dates -- exactly the range these callers ask about.

    Falls back to the old weekday heuristic if neither table can be read, so a fetcher still
    runs (slightly over-broad, hitting a holiday and getting a 404) rather than failing.
    """
    import datetime

    def _weekday_fallback():
        days, d = [], datetime.date.today() - datetime.timedelta(days=1)
        while len(days) < n:
            if d.weekday() < 5:
                days.append(d)
            d -= datetime.timedelta(days=1)
        return days

    if n <= 0:
        return []

    own_conn = False
    if conn is None:
        try:
            from db_compat import connect
            conn = connect()
            own_conn = True
        except Exception:
            return _weekday_fallback()

    try:
        rows = None
        for table in ("stock_ohlcv", "nse_universe_history"):
            try:
                rows = conn.execute(
                    f"SELECT DISTINCT date FROM {table} ORDER BY date DESC LIMIT ?", (n + 5,)
                ).fetchall()
            except Exception:
                # A failed statement poisons the transaction in Postgres; without this
                # rollback every later query dies with InFailedSqlTransaction.
                try:
                    conn.rollback()
                except Exception:
                    pass
                rows = None
            if rows:
                break
        if not rows:
            return _weekday_fallback()

        out = []
        today = datetime.date.today()
        for r in rows:
            v = r[0]
            d = v if isinstance(v, datetime.date) else datetime.date.fromisoformat(str(v)[:10])
            # Exclude today: the session may still be open or its file not yet published,
            # which is the same reason the weekday version started at today-1.
            if d < today:
                out.append(d)
            if len(out) >= n:
                break
        return out or _weekday_fallback()
    finally:
        if own_conn:
            try:
                conn.close()
            except Exception:
                pass

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
