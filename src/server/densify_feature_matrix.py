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
        WHERE table_name='technical_signals'
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

        # strictly forward, per symbol, capped by age
        filled = df.groupby('symbol', group_keys=False)[cols].ffill(limit=MAX_FILL_AGE_DAYS)
        # how stale is the carried value? measured on the densest column set as a whole
        had_any = df[cols].notna().any(axis=1)
        ages = []
        for _, g in df.assign(_has=had_any).groupby('symbol', sort=False):
            age, cur = [], None
            for has_val in g['_has'].values:
                if has_val:
                    cur = 0
                elif cur is not None:
                    cur += 1
                age.append(cur)
            ages.extend(age)
        df_out = df[['symbol', 'date']].copy()
        df_out[cols] = filled
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
