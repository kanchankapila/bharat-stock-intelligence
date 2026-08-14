"""Log real trades and grade them the way measurement.md grades everything else.

The point is not bookkeeping. It is that the ONE setup on this platform with a measured
edge -- screener_combo_finder.py's tier-1 capitulation triple, +0.53%/day excess net of
15bps, t=3.61 -- has an edge roughly the size of one bad fill. A 0.5% slippage on entry
erases it completely. So this grades two different things and reports the gap between them:

  model_excess  what the backtest would have earned: stock_ohlcv open -> close on the trade
                date, minus the liquid-universe mean that same date, minus costs. This is
                the exact quantity screener_combo_finder._day_level_backtest measures.
  real_excess   what YOU earned: your actual fills, same benchmark subtraction.

real minus model is your execution drag. If it is bigger than the 0.53% the setup pays,
the setup is not tradeable by you at your size, however good the backtest looks.

Everything is per-date-then-averaged and winsorized per .claude/rules/measurement.md's
panel spec -- pooling trade rows has flipped a conclusion three separate times in this repo.

STORAGE
    Postgres `trade_journal` (migration 1787000000000) is the record. When the DB is
    unreachable -- logging a trade from a laptop with no tunnel to :5433 -- rows go to an
    offline JSONL file instead and `sync` reconciles them on the next connect. Rows are keyed
    on a writer-issued uuid, so a row landing twice upserts rather than duplicating, and
    `synced_at` makes the reconciliation idempotent. Offline file: $TRADE_JOURNAL_PATH,
    default <repo>/trade_journal.jsonl (gitignored).

USAGE
    python trade_journal.py log --symbol MOREPENLAB --signal-date 2026-08-12 \
        --trade-date 2026-08-13 --qty 100 --entry 61.40 --exit 62.85
    python trade_journal.py grade                  # fill model fills/benchmark from OHLCV
    python trade_journal.py sync                   # push offline-logged rows into Postgres
    python trade_journal.py report                 # per-date stats + verdict vs expectation
    python trade_journal.py report --since 2026-07-01
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from db_compat import execute, read_df
from screener_combo_finder import COST_PCT, MIN_ADTV, MIN_PRICE

# The tier-1 verdict this journal exists to check its own results against. Sourced from
# .claude/rules/measurement.md's screener_combo_finder row (reproduced live 2026-08-13:
# 425 days, spread +0.53%/day net of 15bps, t=+3.61, p=0.0003, 6/6 years positive).
EXPECTED_EXCESS_PCT = 0.53
EXPECTED_T = 3.61

# Below this many distinct trade dates, report prints the numbers but refuses a verdict.
# The backtest that produced EXPECTED_EXCESS_PCT had 425 dates; a handful of trades cannot
# confirm or refute it, and treating them as if they could is this repo's most repeated
# measurement error.
MIN_DATES_FOR_VERDICT = 40

WINSOR_PCT = 0.01
ADTV_LOOKBACK_DAYS = 30  # calendar days ~= 20 sessions, matching live_capitulation_screener


def journal_path() -> Path:
    env = os.environ.get("TRADE_JOURNAL_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "trade_journal.jsonl"


# ── pure core (no DB, no filesystem -- this is what the tests exercise) ────────────────

def winsorize(values: pd.Series, pct: float = WINSOR_PCT) -> pd.Series:
    """Clip both tails at `pct`. measurement.md's panel spec requires this on anything
    computed off stock_ohlcv -- a single +127,900% RELIANCE bar once produced an
    850%-annualised phantom edge in this repo."""
    clean = values[np.isfinite(values)]
    if clean.empty:
        return clean
    # method="higher"/"lower" rather than the default linear interpolation: with a single
    # extreme bar in n=100, the interpolated 99th percentile sits ~1% of the way toward the
    # outlier itself, so clipping to it leaves most of the outlier in place and the mean
    # still blows out. Clipping to an actually-observed value is what winsorizing means.
    lo = clean.quantile(pct, interpolation="higher")
    hi = clean.quantile(1 - pct, interpolation="lower")
    return clean.clip(lo, hi)


def universe_mean_return(bars: pd.DataFrame) -> float | None:
    """Winsorized mean open->close return of the liquid universe on one date.

    `bars` needs [open, close]. Returns None when nothing usable survives -- callers must
    skip the date rather than substitute 0.0, which would silently credit the whole day's
    market move to the trade as if it were edge."""
    if bars.empty:
        return None
    ret = (bars["close"] - bars["open"]) / bars["open"].replace(0, np.nan)
    ret = winsorize(ret.replace([np.inf, -np.inf], np.nan).dropna())
    if ret.empty:
        return None
    return float(ret.mean())


def excess_return_pct(entry: float, exit_: float, universe_ret: float,
                      cost_pct: float = COST_PCT) -> float | None:
    """One trade's benchmark-relative, cost-adjusted return, in percent.

    Identical construction to screener_combo_finder._day_level_backtest's `spread`:
    (basket return - cost) - universe return. Returns None on any non-finite input --
    never 0.0, because a coerced zero is indistinguishable from a genuinely flat trade
    and this repo has been burned by `float(x or 0)` on NaN more than once."""
    for v in (entry, exit_, universe_ret):
        if v is None or not math.isfinite(float(v)):
            return None
    entry = float(entry)
    if entry <= 0:
        return None
    raw = (float(exit_) - entry) / entry
    return float((raw - cost_pct / 100.0 - float(universe_ret)) * 100)


def per_date_stats(rows: pd.DataFrame, col: str) -> dict | None:
    """Per-date then average -- never pooled across trade rows.

    `rows` needs [trade_date, <col>]. Two trades on one date are one observation, exactly
    as _day_level_backtest aggregates to one row per day before computing anything."""
    usable = rows[["trade_date", col]].copy()
    usable[col] = pd.to_numeric(usable[col], errors="coerce")
    usable = usable[np.isfinite(usable[col])]
    if usable.empty:
        return None
    daily = usable.groupby("trade_date")[col].mean()
    daily = winsorize(daily)
    n = len(daily)
    if n < 2:
        return {"n_dates": n, "n_trades": len(usable), "mean_pct": float(daily.mean()),
                "t_stat": None, "p_value": None, "ci95": None, "win_rate": None}
    t = stats.ttest_1samp(daily.values, 0.0)
    se = float(daily.std(ddof=1) / math.sqrt(n))
    mean = float(daily.mean())
    return {
        "n_dates": n,
        "n_trades": int(len(usable)),
        "mean_pct": mean,
        "t_stat": float(t.statistic),
        "p_value": float(t.pvalue),
        "ci95": (mean - 1.96 * se, mean + 1.96 * se),
        "win_rate": float((daily > 0).mean()),
    }


def verdict(model: dict | None, real: dict | None) -> str:
    """What the numbers so far justify saying -- and, below MIN_DATES_FOR_VERDICT, that
    they justify saying nothing yet."""
    if model is None or real is None:
        return "NO DATA — nothing graded yet. Run `grade` after your trade dates have closed."
    if model["n_dates"] < MIN_DATES_FOR_VERDICT:
        return (f"TOO EARLY — {model['n_dates']} trade dates, need ~{MIN_DATES_FOR_VERDICT} "
                f"before any of this separates skill from noise. Keep logging; do not "
                f"resize on these numbers.")
    drag = model["mean_pct"] - real["mean_pct"]
    if real["ci95"] and real["ci95"][1] < 0:
        return (f"STOP — your realized excess is significantly negative "
                f"(95% CI upper bound {real['ci95'][1]:+.2f}%/date). The setup is not "
                f"working at your execution. Stand down and diagnose before trading it again.")
    if drag > EXPECTED_EXCESS_PCT:
        return (f"EXECUTION IS EATING THE EDGE — {drag:+.2f}%/date of slippage against a "
                f"setup that only pays {EXPECTED_EXCESS_PCT:.2f}%. Fix fills (or trade "
                f"smaller/more liquid names) before concluding anything about the signal.")
    if real["p_value"] is not None and real["p_value"] < 0.05 and real["mean_pct"] > 0:
        return (f"HOLDING UP — realized {real['mean_pct']:+.2f}%/date, t={real['t_stat']:.2f}, "
                f"against a {EXPECTED_EXCESS_PCT:.2f}% expectation. Still one setup on one "
                f"platform; size accordingly.")
    return (f"INCONCLUSIVE — realized {real['mean_pct']:+.2f}%/date, t={real['t_stat']:.2f}. "
            f"Not distinguishable from zero either way. Keep the size that survives being wrong.")


# ── journal I/O: Postgres first, offline JSONL fallback ───────────────────────────────
#
# The DB is the record. The file exists so a trade can still be logged from a laptop with no
# tunnel to :5433 -- those rows carry synced_at=NULL and are reconciled by `sync`. Rows are
# keyed on a writer-issued uuid, so the same row landing twice is an upsert, not a duplicate.

COLUMNS = [
    "id", "setup", "symbol", "signal_date", "trade_date", "side", "qty",
    "entry_price", "exit_price", "notes", "logged_at",
    "model_open", "model_close", "universe_ret",
    "model_excess_pct", "real_excess_pct", "slippage_pct", "synced_at",
]
GRADE_COLUMNS = ["model_open", "model_close", "universe_ret",
                 "model_excess_pct", "real_excess_pct", "slippage_pct"]

_db_ok: bool | None = None


def db_available() -> bool:
    """Cheap one-shot probe, cached for the process.

    Deliberately catches broadly: an unreachable DB is the normal offline case this fallback
    exists for, not an error worth a traceback. It is reported, never silent -- a journal that
    quietly stopped writing to Postgres is exactly the 'success on a step that wrote nothing'
    class in recurring-bugs.md."""
    global _db_ok
    if _db_ok is None:
        try:
            read_df("SELECT 1 AS ok FROM trade_journal WHERE 1 = 0")
            _db_ok = True
        except Exception as exc:  # noqa: BLE001 -- see docstring
            print(f"[TradeJournal] database unavailable ({type(exc).__name__}), using the "
                  f"offline journal at {journal_path()}. Run `sync` once reconnected.")
            _db_ok = False
    return _db_ok


def _clean(rec: dict) -> dict:
    return {k: (None if (v is None or (isinstance(v, float) and not math.isfinite(v)))
                else v) for k, v in rec.items()}


def _read_file() -> pd.DataFrame:
    path = journal_path()
    if not path.exists():
        return pd.DataFrame(columns=COLUMNS)
    records = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    df = pd.DataFrame(records)
    for col in COLUMNS:
        if col not in df.columns:
            df[col] = None
    return df


def _write_file(df: pd.DataFrame) -> None:
    path = journal_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(_clean({k: rec.get(k) for k in COLUMNS}))
             for rec in df.to_dict("records")]
    path.write_text("\n".join(lines) + ("\n" if lines else ""))


def _read_db() -> pd.DataFrame:
    df = read_df(f"SELECT {', '.join(COLUMNS)} FROM trade_journal")
    if df.empty:
        return pd.DataFrame(columns=COLUMNS)
    return df


def _upsert_db(rec: dict) -> None:
    rec = _clean({k: rec.get(k) for k in COLUMNS})
    cols = ", ".join(COLUMNS)
    marks = ", ".join(["?"] * len(COLUMNS))
    # synced_at is excluded from the update list on purpose: it records when a row first
    # reconciled into the DB, and walking it forward on every re-write is precisely what turned
    # unified_signals.signal_generated_at into a last-seen time (migration 1786920000000).
    updates = ", ".join(f"{c} = excluded.{c}" for c in COLUMNS
                        if c not in ("id", "synced_at"))
    execute(f"INSERT INTO trade_journal ({cols}) VALUES ({marks}) "
            f"ON CONFLICT (id) DO UPDATE SET {updates}",
            tuple(rec[c] for c in COLUMNS))


def load_journal() -> pd.DataFrame:
    """DB rows, plus any offline rows not yet reconciled into it.

    `_source` marks where each row came from so grade results are written back to the right
    place. It is an internal column and is stripped before persisting."""
    file_df = _read_file()
    if not db_available():
        file_df["_source"] = "file"
        return file_df

    db_df = _read_db()
    db_df["_source"] = "db"
    if file_df.empty:
        return db_df
    pending = file_df[~file_df["id"].isin(db_df["id"])].copy()
    if pending.empty:
        return db_df
    print(f"[TradeJournal] {len(pending)} offline row(s) not yet in the database — "
          f"run `python trade_journal.py sync`.")
    pending["_source"] = "file"
    return pd.concat([db_df, pending], ignore_index=True)


def append_trade(rec: dict) -> str:
    if db_available():
        rec = dict(rec, synced_at=datetime.datetime.now(datetime.UTC).isoformat())
        _upsert_db(rec)
        return "database"
    _write_file(pd.concat([_read_file(), pd.DataFrame([rec])], ignore_index=True))
    return "offline journal"


def persist(df: pd.DataFrame) -> None:
    """Write graded rows back to whichever store each came from."""
    if "_source" not in df.columns:
        df = df.assign(_source="db" if db_available() else "file")
    if db_available():
        for rec in df[df["_source"] == "db"].to_dict("records"):
            _upsert_db(rec)
    file_rows = df[df["_source"] == "file"]
    if not file_rows.empty or journal_path().exists():
        _write_file(file_rows)


def sync() -> int:
    """Reconcile offline rows into the database. Idempotent -- upserts on id, and stamps
    synced_at only on rows that did not already carry one."""
    if not db_available():
        print("[TradeJournal] still offline — nothing synced.")
        return 0
    file_df = _read_file()
    if file_df.empty:
        print("[TradeJournal] offline journal is empty — nothing to sync.")
        return 0

    now = datetime.datetime.now(datetime.UTC).isoformat()
    for rec in file_df.to_dict("records"):
        if not rec.get("synced_at"):
            rec["synced_at"] = now
        _upsert_db(rec)
    print(f"[TradeJournal] synced {len(file_df)} offline row(s) into trade_journal.")

    # The DB now holds them. Keep the file as the offline log rather than deleting it, but
    # stamp it so a second sync is a no-op rather than a re-upsert of stale grading columns.
    file_df["synced_at"] = file_df["synced_at"].fillna(now)
    _write_file(file_df)
    return len(file_df)


# ── DB-backed grading ─────────────────────────────────────────────────────────────────

def load_universe_bars(trade_date: str) -> pd.DataFrame:
    """Liquid, non-suspect universe on one date, on measurement.md's filters: is_suspect
    excluded, ADTV floor, price floor. Thresholds are imported from screener_combo_finder,
    not redefined, so a retune moves the backtest and this grader together."""
    lookback = (datetime.date.fromisoformat(trade_date)
                - datetime.timedelta(days=ADTV_LOOKBACK_DAYS)).isoformat()
    return read_df(
        "WITH liq AS ("
        "  SELECT symbol, AVG(close * volume) AS adtv FROM stock_ohlcv"
        "  WHERE date > ? AND date <= ? AND is_suspect = 0 GROUP BY symbol"
        ") "
        "SELECT o.symbol, o.open, o.close FROM stock_ohlcv o "
        "JOIN liq ON liq.symbol = o.symbol "
        "WHERE o.date = ? AND o.is_suspect = 0 AND liq.adtv >= ? "
        "  AND o.open > ? AND o.close IS NOT NULL",
        (lookback, trade_date, trade_date, MIN_ADTV, MIN_PRICE),
    )


def grade(verbose: bool = True) -> int:
    """Fill model fills + benchmark + both excess columns for every ungraded trade whose
    trade_date has a settled OHLCV bar. Idempotent: already-graded rows are left alone."""
    df = load_journal()
    if df.empty:
        print("[TradeJournal] journal is empty — nothing to grade.")
        return 0

    for col in GRADE_COLUMNS:
        if col not in df.columns:
            df[col] = None

    ungraded = df[df["model_excess_pct"].isna()]
    if ungraded.empty:
        print("[TradeJournal] every trade already graded.")
        return 0

    graded = 0
    for trade_date, group in ungraded.groupby("trade_date"):
        bars = load_universe_bars(trade_date)
        if bars.empty:
            if verbose:
                print(f"[TradeJournal] {trade_date}: no settled OHLCV yet — skipping.")
            continue
        uni = universe_mean_return(bars)
        if uni is None:
            if verbose:
                print(f"[TradeJournal] {trade_date}: universe return unusable — skipping.")
            continue

        by_symbol = bars.set_index("symbol")
        for idx in group.index:
            symbol = df.at[idx, "symbol"]
            if symbol not in by_symbol.index:
                if verbose:
                    print(f"[TradeJournal] {trade_date} {symbol}: not in the liquid universe "
                          f"that date — left ungraded (it was not a tradeable candidate).")
                continue
            bar = by_symbol.loc[symbol]
            model_open, model_close = float(bar["open"]), float(bar["close"])
            model_ex = excess_return_pct(model_open, model_close, uni)
            real_ex = excess_return_pct(df.at[idx, "entry_price"], df.at[idx, "exit_price"], uni)

            df.at[idx, "model_open"] = model_open
            df.at[idx, "model_close"] = model_close
            df.at[idx, "universe_ret"] = uni
            df.at[idx, "model_excess_pct"] = model_ex
            df.at[idx, "real_excess_pct"] = real_ex
            if model_ex is not None and real_ex is not None:
                df.at[idx, "slippage_pct"] = model_ex - real_ex
            graded += 1
            if verbose:
                print(f"[TradeJournal] {trade_date} {symbol:12s} model={model_ex:+.2f}% "
                      f"real={real_ex if real_ex is None else f'{real_ex:+.2f}%'}")

    persist(df)
    print(f"[TradeJournal] graded {graded} trade(s).")
    return graded


def report(since: str | None = None) -> dict | None:
    df = load_journal()
    if df.empty or "model_excess_pct" not in df.columns:
        print(verdict(None, None))
        return None
    if since:
        df = df[df["trade_date"] >= since]

    model = per_date_stats(df, "model_excess_pct")
    real = per_date_stats(df, "real_excess_pct")

    print(f"\n[TradeJournal] {len(df)} logged trade(s)"
          f"{f' since {since}' if since else ''}, benchmark = liquid-universe mean "
          f"open->close, {COST_PCT}% round-trip cost, per-date then averaged, winsorized.\n")
    print(f"{'':<10} {'dates':>6} {'trades':>7} {'excess%':>9} {'t':>7} {'p':>8} {'win%':>7}")
    for label, s in (("model", model), ("realized", real)):
        if s is None:
            print(f"{label:<10} {'—':>6}")
            continue
        t = "—" if s["t_stat"] is None else f"{s['t_stat']:.2f}"
        p = "—" if s["p_value"] is None else f"{s['p_value']:.4f}"
        w = "—" if s["win_rate"] is None else f"{s['win_rate'] * 100:.0f}"
        print(f"{label:<10} {s['n_dates']:>6} {s['n_trades']:>7} {s['mean_pct']:>8.2f}% "
              f"{t:>7} {p:>8} {w:>7}")

    if model and real:
        print(f"\nexecution drag (model - realized): "
              f"{model['mean_pct'] - real['mean_pct']:+.2f}%/date")
        print(f"tier-1 expectation:               {EXPECTED_EXCESS_PCT:+.2f}%/date "
              f"(t={EXPECTED_T}, 425 dates — see .claude/rules/measurement.md)")
    print(f"\n{verdict(model, real)}\n")
    return {"model": model, "realized": real}


# ── CLI ───────────────────────────────────────────────────────────────────────────────

def cmd_log(a) -> None:
    rec = {
        "id": uuid.uuid4().hex[:12],
        "setup": a.setup,
        "symbol": a.symbol.upper(),
        "signal_date": a.signal_date,
        "trade_date": a.trade_date,
        "side": a.side,
        "qty": a.qty,
        "entry_price": a.entry,
        "exit_price": a.exit,
        "notes": a.notes,
        "logged_at": datetime.datetime.now(datetime.UTC).isoformat(),
    }
    # setup is compared lowercase everywhere; normalising at the one writer is what stops the
    # two-spellings-of-one-enum collision that bit signal_source and screener_catalog.source.
    rec["setup"] = (rec["setup"] or "").strip().lower()
    where = append_trade(rec)
    if not rec["signal_date"]:
        print("[TradeJournal] note: no --signal-date given. The tier-1 setup fires on session D "
              "and trades on D+1; without it, nothing records which session the setup fired.")
    print(f"[TradeJournal] logged {rec['side']} {rec['qty']} {rec['symbol']} "
          f"on {rec['trade_date']} → {where}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    lg = sub.add_parser("log", help="record one trade")
    lg.add_argument("--symbol", required=True)
    lg.add_argument("--trade-date", required=True, help="session you entered/exited (YYYY-MM-DD)")
    lg.add_argument("--signal-date", help="session the setup fired (usually trade-date minus 1)")
    lg.add_argument("--setup", default="capitulation_triple")
    lg.add_argument("--side", default="LONG", choices=["LONG", "SHORT"])
    lg.add_argument("--qty", type=float)
    lg.add_argument("--entry", type=float, help="your actual fill")
    lg.add_argument("--exit", type=float, help="your actual exit")
    lg.add_argument("--notes")

    sub.add_parser("grade", help="fill benchmark + excess columns from settled OHLCV")
    sub.add_parser("sync", help="reconcile offline-logged trades into the database")

    rp = sub.add_parser("report", help="per-date stats and verdict")
    rp.add_argument("--since")

    a = ap.parse_args()
    if a.cmd == "log":
        cmd_log(a)
    elif a.cmd == "grade":
        grade()
    elif a.cmd == "sync":
        sync()
    elif a.cmd == "report":
        report(since=a.since)


if __name__ == "__main__":
    main()
