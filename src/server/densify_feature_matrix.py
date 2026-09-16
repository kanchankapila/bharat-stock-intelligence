#!/usr/bin/env python3
"""
Forward-fill the sparse enrichment columns of technical_signals.

WHY THIS EXISTS
---------------
technical_signals is both the daily grid AND the denormalised feature store. The grid-ensurer
creates a row per symbol per trading day carrying only the price/technical columns; each
enrichment fetcher then UPDATEs *only* the row matching its own as-of anchor. So a feature is
populated on exactly the day its fetcher ran and NULL everywhere else -- measured on
2026-07-29, 216 of 306 columns sat below 50% coverage and ~150 at exactly 0%.

ml_ensemble.py then reads them through a lateral join bounded to 3 days
(ORDER BY date DESC LIMIT 1), which always lands on the newest -- and therefore emptiest --
row. Net effect: ~150 features are NULL for the whole training set, while live inference
reads today's row which *does* carry that day's enrichment. That is train/serve skew, and it
is the most likely cause of the documented "CV 0.75 -> live ~0.50" gap.

WHY FORWARD-FILL IS CORRECT, NOT A LEAK
---------------------------------------
Carrying the last *reported* value forward is exactly what a point-in-time system does: once
a company reports ROCE, that stays the best available estimate until the next report. The
fill is strictly forward in time (never backward), per symbol, and capped by MAX_FILL_AGE_DAYS
so a value cannot be carried past the point of being meaningless. enrichment_ffill_age_days
records how stale the carried value is, so a model can learn to discount it.

Run:  python densify_feature_matrix.py [--dry-run] [--since 2026-05-16]
"""
import argparse
import datetime

import pandas as pd
import polars as pl
from db_compat import connect

# Below this coverage on a normal trading day, a column is treated as sporadically-written
# enrichment rather than a genuinely-daily series.
SPARSE_COVERAGE_THRESHOLD = 0.50
# A fundamental stays valid for a quarter-ish; beyond that a carried value is misleading.
MAX_FILL_AGE_DAYS = 120
# Never forward-fill these: they are daily by nature, and carrying a stale model output or
# price forward would fabricate a prediction that was never made.
NEVER_FILL = {
    'symbol', 'date', 'id', 'created_at', 'updated_at', 'signals_json', 'ai_insight',
    'win_probability', 'calibrated_win_probability', 'breakout_probability',
    # Every OTHER model-output column in technical_signals (2026-08-10). The set above
    # listed only 3 of the 7 predictions this table carries, so a model whose producer
    # failed for a day would have its last prediction carried forward for up to
    # MAX_FILL_DAYS and presented as if it had been made on each of those days -- the exact
    # fabrication this set exists to prevent, just for the models nobody had enumerated yet.
    # Found via flyer_probability, which is populated on exactly ONE date and was therefore
    # a live candidate to be smeared across the whole grid.
    # No behavioural change when added: movement_probability and cs_score are already at
    # 100% coverage from their own daily jobs and pead_score's ~76% is its real producer
    # coverage (PEAD only applies to names with a recent earnings print), so there is
    # nothing for the filler to have been doing here. This is a guard, not a correction.
    'flyer_probability', 'movement_probability', 'pead_score', 'cs_score',
    # Market-flow and relative-strength measures (2026-08-24). fii_10d_net /
    # dii_3d_net are point-in-time institutional flow readings and
    # sector_ret_5d/21d are daily recomputed cross-sectional returns — none can
    # be carried forward without fabricating either a stale flow reading or a
    # dead sector return. Their schema DEFAULTs were removed in migration
    # 20260823235900 for exactly this reason; forward-fill would resurrect the
    # same fabricated values through the back door.
    'fii_10d_net', 'dii_3d_net', 'sector_ret_5d', 'sector_ret_21d',
    # Option-chain walls (2026-08-23). These went from 100% "coverage" to ~7% when migration
    # 1787130000000 replaced their fabricated DEFAULT 0 with a real NULL, which dropped them
    # under SPARSE_COVERAGE_THRESHOLD and made them fill candidates for the first time.
    # They must NOT be filled: a wall distance is a point-in-time reading off that day's
    # so_option_chain, and only the ~154 F&O names have one at all. Forward-filling would
    # carry an F&O name's stale wall onto days it has no chain, and (via ffill's per-symbol
    # scope) present a reading as if it had been observed on each of those days -- the same
    # fabrication the model-output entries above exist to prevent, and a strictly worse
    # outcome than the zeros the migration just removed. Verified live: both columns appeared
    # in sparse_columns() immediately after the migration.
    'call_wall_dist_pct', 'put_wall_dist_pct', 'near_expiry_gamma',
    'close', 'cmp', 'open', 'high', 'low', 'volume', 'change_pct',
    'entry_zone', 'stop_loss', 'targets', 'setup_quality', 'time_horizon',
    'enrichment_ffill_age_days',   # this script's own bookkeeping column
}


def _log(m):
    print(f"[Densify] {m}", flush=True)


def trading_dates(conn, since: str) -> list:
    """Only real trading days -- weekend rows in the grid are partial junk (16-46 rows)."""
    rows = conn.execute(
        "SELECT DISTINCT date::text FROM stock_ohlcv WHERE date::text >= ? ORDER BY 1",
        (since,)).fetchall()
    return [r[0] for r in rows]


def sparse_columns(conn, probe_date: str) -> list:
    cols = conn.execute("""
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='technical_signals' AND table_schema = current_schema()
    """).fetchall()
    total = conn.execute(
        "SELECT count(*) FROM technical_signals WHERE date::text=?", (probe_date,)).fetchone()[0]
    if not total:
        return []
    out = []
    for name, dtype in cols:
        if name in NEVER_FILL:
            continue
        if dtype not in ('double precision', 'real', 'numeric', 'integer', 'bigint', 'smallint'):
            continue
        n = conn.execute(
            f'SELECT count("{name}") FROM technical_signals WHERE date::text=?',
            (probe_date,)).fetchone()[0]
        if n / total < SPARSE_COVERAGE_THRESHOLD:
            out.append(name)
    _log(f"probe {probe_date}: {len(out)} sparse enrichment columns of {len(cols)} total")
    return out


def ffill_and_ages(df, cols):
    """Per-symbol forward-fill capped at MAX_FILL_AGE_DAYS, plus the staleness age.

    Returns (filled_dataframe, ages_list) -- `filled` carries df's own index so it can be
    assigned straight back onto a row-aligned frame.

    Polars rather than pandas, and the reason is measured, not assumed: on the real
    production panel (91,041 rows x 160 sparse columns, 2,272 symbols, 276 trading days,
    2026-08-29) this is 2.14x faster end to end -- 1.542s -> 0.722s including the frame
    build. Almost all of the win is the age computation at 10.2x, because the pandas
    version ran a pure-Python loop over every single row; the ffill itself is only 1.57x.
    Equivalence with the previous pandas implementation is pinned by
    src/server/tests/test_densify_ffill_ages.py, which reimplements nothing -- it calls
    this function and compares against pandas groupby/ffill on the same input.

    LOAD-BEARING: NaN is NOT null in polars, and forward_fill() propagates over nulls
    ONLY. Without the fill_nan(None) below this fills nothing at all and still returns a
    perfectly plausible-looking frame -- the first version of this conversion did exactly
    that and was caught only because the benchmark asserted equality before reporting a
    speedup.
    """
    pldf = pl.DataFrame(
        {"symbol": df["symbol"].to_numpy().astype(str)}
        | {c: df[c].to_numpy(dtype="float64", na_value=float("nan")) for c in cols}
    ).with_columns([pl.col(c).fill_nan(None) for c in cols])

    filled_pl = pldf.with_columns(
        [pl.col(c).forward_fill(limit=MAX_FILL_AGE_DAYS).over("symbol") for c in cols])
    filled = pd.DataFrame({c: filled_pl[c].to_numpy() for c in cols}, index=df.index)

    ages = (
        pldf.with_columns(
                pl.any_horizontal([pl.col(c).is_not_null() for c in cols]).alias("_has"))
            .with_columns(pl.int_range(pl.len()).over("symbol").alias("_i"))
            .with_columns(pl.when(pl.col("_has")).then(pl.col("_i")).otherwise(None)
                            .forward_fill().over("symbol").alias("_last"))
            .with_columns((pl.col("_i") - pl.col("_last")).alias("_age"))["_age"].to_list()
    )
    return filled, ages


def run(since: str, dry: bool) -> None:
    conn = connect()
    try:
        conn.execute("ALTER TABLE technical_signals "
                     "ADD COLUMN IF NOT EXISTS enrichment_ffill_age_days INTEGER")
        conn.commit()

        tdates = trading_dates(conn, since)
        if not tdates:
            _log("no trading dates; nothing to do")
            return
        probe = tdates[-2] if len(tdates) > 1 else tdates[-1]
        cols = sparse_columns(conn, probe)
        if not cols:
            _log("no sparse columns; nothing to do")
            return

        quoted = ", ".join(f'"{c}"' for c in cols)
        # pandas talks to the driver directly, bypassing db_compat's ?->%s translation, so
        # inline the date list. Values come straight from stock_ohlcv.date (ISO, DB-typed),
        # and are re-validated here rather than trusted blindly.
        for d in tdates:
            datetime.date.fromisoformat(d)
        in_list = ",".join(f"'{d}'" for d in tdates)
        rows = conn.execute(
            f"SELECT symbol, date::text AS date, {quoted} FROM technical_signals "
            f"WHERE date::text IN ({in_list}) ORDER BY symbol, date").fetchall()
        df = pd.DataFrame(rows, columns=['symbol', 'date'] + cols)
        for c in cols:
            df[c] = pd.to_numeric(df[c], errors='coerce')
        _log(f"loaded {len(df):,} grid rows x {len(cols)} sparse columns "
             f"over {len(tdates)} trading days")

        before = df[cols].notna().sum().sum()
        df = df.sort_values(['symbol', 'date'])

        # strictly forward, per symbol, capped by age; plus how stale each carried
        # value is, measured on the densest column set as a whole. See ffill_and_ages().
        filled, ages = ffill_and_ages(df, cols)
        # One concat rather than 160 individual column inserts -- assigning df_out[cols]
        # column-by-column triggers pandas' "DataFrame is highly fragmented" warning and
        # the copying that goes with it. filled carries df's index, so this aligns.
        df_out = pd.concat([df[['symbol', 'date']], filled], axis=1)
        df_out['enrichment_ffill_age_days'] = ages

        after = df_out[cols].notna().sum().sum()
        newly = int(after - before)
        _log(f"non-null cells: {before:,} -> {after:,}  (+{newly:,}, "
             f"{100.0*after/(len(df)*len(cols)):.1f}% dense)")

        if dry:
            _log("dry run -- nothing written")
            return

        # write back only rows that gained something
        gained = df_out[cols].notna().sum(axis=1) > df[cols].notna().sum(axis=1).values
        todo = df_out[gained]
        _log(f"updating {len(todo):,} rows ...")
        set_clause = ", ".join(f'"{c}"=?' for c in cols) + ", enrichment_ffill_age_days=?"
        n = 0
        for i, row in enumerate(todo.itertuples(index=False), 1):
            vals = [getattr(row, c) if not pd.isna(getattr(row, c)) else None for c in cols]
            vals.append(int(row.enrichment_ffill_age_days)
                        if not pd.isna(row.enrichment_ffill_age_days) else None)
            conn.execute(
                f"UPDATE technical_signals SET {set_clause} WHERE symbol=? AND date::text=?",
                tuple(vals) + (row.symbol, row.date))
            n += 1
            if i % 2000 == 0:
                conn.commit()
                _log(f"  {i:,}/{len(todo):,}")
        conn.commit()
        _log(f"densified {n:,} rows")
    finally:
        conn.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='2026-05-16')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    run(a.since, a.dry_run)
