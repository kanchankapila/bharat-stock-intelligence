"""Immutable, point-in-time copy of every input unified_ranker.py read for one run.

    python ranker_input_snapshot.py [--date YYYY-MM-DD] [--out-dir data/ranker_snapshots]
                                    [--persist] [--force] [--max-mb 200]

Why: the ranker's inputs are mutated after the fact (technical_signals is rewritten by densify
and backfills; quant_scores / stock_scores / screener membership are overwritten daily;
recommendation_log.actual_return_pct and unified_signals.status are filled in later), so a run
can never be replayed once the day has passed. Each night this writes what the ranker could see
to <out-dir>/<date>/<input>.parquet plus manifest.json, and never rewrites a finished day.

--date is the ranker's run label (unified_recommendations.computed_at, default its MAX). Every
window is anchored on that run's own generated_at, so rows written after the ranker ran are
excluded. Files are written read-only; a day that already exists is a no-op (exit 0) unless
--force, which keeps the old copy as <date>.superseded.<utc-ts>.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import polars as pl

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO_ROOT / "data" / "ranker_snapshots"
DEFAULT_MAX_MB = 200.0
SETTINGS_KEY = "ranker_input_snapshot_last"
IST = timezone(timedelta(hours=5, minutes=30))


class SnapshotTooLarge(RuntimeError):
    pass


@dataclass(frozen=True)
class Spec:
    name: str
    sql: str
    optional: bool = True
    why: str = ""


# Params: :d = the ranker's as-of calendar date (its generated_at in IST), :ts = its generated_at,
# :run = the computed_at label. Calendar windows are supersets of the ranker's own windows (its
# trading_days_back(1..3) reads fit inside 10 calendar days), so a replay can re-apply the exact
# cutoff from the stored dates/timestamps.
INPUTS: list[Spec] = [
    Spec("technical_signals", """
        SELECT symbol, date, nifty_regime, win_probability, calibrated_win_probability, signal_score,
               screener_momentum_score, breakout_probability, insider_buy_pct_90d, hv_20d, cmp
        FROM technical_signals
        WHERE date > CAST(:d AS date) - 30 AND date <= CAST(:d AS date)""", optional=False,
         why="_get_win_probabilities/_get_smart_money_scores (30d), _get_ml_scores/_get_technical_scores "
             "(3 sessions), _get_screener_momentum_scores (2), _get_breakout_scores (5d), "
             "_get_realized_vol (7d), _compute_cost_map (cmp at latest date); rewritten by densify/backfills"),
    Spec("confluence_latest", """
        WITH w AS (
            SELECT symbol, computed_at, trend_alignment_score, volume_score, sector_strength_score,
                   fundamental_score, confluence_score, entry_zone_low, entry_zone_high, stop_loss,
                   target_1, target_2, target_3, risk_reward, suggested_timeframe, trade_reasoning,
                   sector, atr
            FROM confluence_signals
            WHERE computed_at > CAST(:ts AS timestamptz) - INTERVAL '30 days'
              AND computed_at <= CAST(:ts AS timestamptz)
              AND symbol NOT LIKE '%://%' AND LENGTH(symbol) <= 20),
        latest AS (
            SELECT w.*, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY computed_at DESC) AS rn FROM w),
        last_atr AS (
            SELECT symbol, atr AS last_nonnull_atr,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY computed_at DESC) AS rn
            FROM w WHERE atr IS NOT NULL)
        SELECT l.symbol, l.computed_at, l.trend_alignment_score, l.volume_score, l.sector_strength_score,
               l.fundamental_score, l.confluence_score, l.entry_zone_low, l.entry_zone_high, l.stop_loss,
               l.target_1, l.target_2, l.target_3, l.risk_reward, l.suggested_timeframe,
               l.trade_reasoning, l.sector, l.atr, a.last_nonnull_atr
        FROM latest l LEFT JOIN last_atr a ON a.symbol = l.symbol AND a.rn = 1
        WHERE l.rn = 1""", optional=False,
         why="_get_confluence_scores (non-screener sub-scores, last session), _get_confluence_latest_map "
             "(trade geometry, 30d), _compute_cost_map (latest non-null atr, 30d); compressed hypertable, "
             "latest row per symbol only"),
    Spec("deep_learning_predictions", """
        SELECT symbol, prediction_date, prob_up_5d FROM deep_learning_predictions
        WHERE prediction_date > CAST(:d AS date) - 10 AND prediction_date <= CAST(:d AS date)""",
         optional=False, why="_get_dl_scores (prediction_date >= last session)"),
    Spec("stock_scores", "SELECT symbol, score FROM stock_scores WHERE timeframe = 'long_term'",
         optional=False, why="_get_fundamental_scores; overwritten daily by scoring_engine.py"),
    Spec("quant_scores", """
        SELECT symbol, piotroski_f_score, return_on_equity, annualized_vol, mf_composite_score,
               mf_quality_score, mf_momentum_score, mf_value_score, mf_risk_adj_score, mf_macro_score
        FROM quant_scores""", optional=False,
         why="_get_quality_metrics (quality gate, vol sizing) + _get_multi_factor_map (crowding); "
             "overwritten daily, no date column"),
    Spec("screener_trendlyne", """
        SELECT ss.symbol, ss.screener_id AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory,
               sc.investment_horizon, COALESCE(ts.screener_name, sc.screener_name, sc.screener_id) AS sname
        FROM trendlyne_screener_stocks ss
        LEFT JOIN screener_catalog sc ON sc.screener_id = ss.screener_id AND LOWER(sc.source) = 'trendlyne'
        LEFT JOIN trendlyne_screeners ts ON ts.screener_id = ss.screener_id""",
         why="_get_screener_membership (current membership, replaced on every sync)"),
    Spec("screener_moneycontrol", """
        SELECT ss.symbol, ss.scan_id AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory,
               sc.investment_horizon, COALESCE(sc.screener_name, sc.screener_id) AS sname
        FROM moneycontrol_screener_stocks ss
        LEFT JOIN screener_catalog sc ON sc.screener_id = ss.scan_id AND LOWER(sc.source) = 'moneycontrol'""",
         why="_get_screener_membership"),
    Spec("screener_etnow", """
        SELECT ss.symbol, ss.screener_id AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory,
               sc.investment_horizon, COALESCE(sc.screener_name, sc.screener_id) AS sname
        FROM etnow_screener_stocks ss
        LEFT JOIN screener_catalog sc ON sc.screener_id = ss.screener_id AND LOWER(sc.source) = 'etnow'""",
         why="_get_screener_membership"),
    Spec("screener_et_marketstats", """
        SELECT ss.symbol, ss.screener_key AS sid, sc.signal_bias, sc.confidence, sc.category, sc.subcategory,
               sc.investment_horizon, COALESCE(sc.screener_name, ss.screener_key) AS sname
        FROM et_marketstats_screener_stocks ss
        LEFT JOIN screener_catalog sc ON sc.screener_id = ss.screener_key AND LOWER(sc.source) = 'et_marketstats'""",
         why="_get_screener_membership"),
    Spec("screener_master", "SELECT scan_id, source, inferred_sentiment FROM screener_master",
         why="_get_screener_membership's bias fallback for uncatalogued screeners"),
    Spec("block_deals", """
        SELECT symbol, date, pct_transacted FROM block_deals
        WHERE date > CAST(:d AS date) - 90 AND date <= CAST(:d AS date)
          AND trade_type = 'buy' AND pct_transacted IS NOT NULL""",
         why="_get_smart_money_scores block-deal leg (90d buys)"),
    Spec("institutional_deal_signals", """
        SELECT symbol, deal_date, deal_value_cr_1w FROM institutional_deal_signals
        WHERE deal_date > CAST(:d AS date) - 14 AND deal_date <= CAST(:d AS date)
          AND action = 'buy' AND deal_value_cr_1w IS NOT NULL""",
         why="_get_smart_money_scores institutional leg (14d buys)"),
    Spec("recommendation_log_track", """
        SELECT symbol, COUNT(*) AS cnt, SUM(actual_return_pct) AS s,
               SUM(actual_return_pct * actual_return_pct) AS ss
        FROM recommendation_log
        WHERE generated_at > CAST(:ts AS timestamptz) - INTERVAL '90 days'
          AND generated_at <= CAST(:ts AS timestamptz) AND actual_return_pct IS NOT NULL
        GROUP BY symbol""", optional=False,
         why="_get_rl_gate_map + _get_avg_track_record (90d resolved returns; actual_return_pct is "
             "filled in later, so only an as-of copy can replay the gate)"),
    Spec("recommendation_log_latest", """
        SELECT symbol, generated_at, entry_price, stop_loss, target_1, target_2, target_3, timeframe,
               reasoning AS trade_reasoning, sector FROM (
            SELECT r.*, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY generated_at DESC) AS rn
            FROM recommendation_log r
            WHERE generated_at > CAST(:ts AS timestamptz) - INTERVAL '30 days'
              AND generated_at <= CAST(:ts AS timestamptz)) t
        WHERE rn = 1""", optional=False, why="_get_rec_log_latest_map (geometry tier 2, 30d)"),
    Spec("unified_signals_latest", """
        SELECT symbol, signal_generated_at, entry_price AS entry, target_price AS target,
               stop_loss AS "stopLoss", reasoning AS trade_reasoning FROM (
            SELECT u.*, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY signal_generated_at DESC) AS rn
            FROM unified_signals u
            WHERE signal_type IN ('BUY', 'Bullish') AND status = 'ACTIVE'
              AND signal_generated_at > CAST(:ts AS timestamptz) - INTERVAL '30 days'
              AND signal_generated_at <= CAST(:ts AS timestamptz)) t
        WHERE rn = 1""", optional=False,
         why="_get_unified_signals_latest_map (geometry tier 3); status is lifecycle-maintained, so "
             "ACTIVE-as-of-the-run is unrecoverable later"),
    Spec("stock_ohlcv_summary", """
        WITH w AS (
            SELECT symbol, date, close, volume, is_suspect FROM stock_ohlcv
            WHERE date > CAST(:d AS date) - 30 AND date <= CAST(:d AS date)),
        lastd AS (SELECT MAX(date) AS md FROM w)
        SELECT w.symbol, MAX(w.date) AS last_date,
               MAX(w.close) FILTER (WHERE w.date = lastd.md AND w.close > 0
                                     AND COALESCE(w.is_suspect, 0) = 0) AS last_close,
               AVG(w.close * w.volume) FILTER (WHERE w.date > CAST(:d AS date) - 20) AS adt_20d
        FROM w CROSS JOIN lastd GROUP BY w.symbol""", optional=False,
         why="_get_last_close_map (plan_is_current), _restrict_to_tradeable_universe (priced in 30d), "
             "_compute_cost_map (20d ADT). Aggregated server-side; _get_recent_returns' 120d closes "
             "stay in stock_ohlcv, the price archive of record"),
    Spec("nse_stocks", "SELECT symbol, sector FROM nse_stocks", optional=False,
         why="_restrict_to_tradeable_universe (master list) + _get_sector_map"),
    Spec("market_regimes", """
        SELECT date, regime, regime_prob FROM market_regimes WHERE date <= CAST(:d AS date)""",
         optional=False, why="_get_regime (latest) + regime_tilt_fit_readiness (full history; one row/day)"),
    Spec("macro_vix", """
        SELECT date, close FROM macro_asset_prices
        WHERE symbol = 'INDIAVIX' AND date > CAST(:d AS date) - 10 AND date <= CAST(:d AS date)""",
         why="_effective_regime_for_weights (latest INDIAVIX close)"),
    Spec("stock_event_triggers", """
        SELECT symbol, triggers FROM stock_event_triggers
        WHERE date = CAST(:run AS date) AND triggers IS NOT NULL AND triggers != ''""",
         why="_get_event_triggers(today) advisory disclosure"),
    Spec("regime_edge_status", """
        SELECT regime, auc, auc_n, distinct_days, episodes, ready, first_day, last_day, computed_at,
               calib_slope, calib_slope_n FROM regime_edge_status""",
         why="ml_calibration.load_regime_edge_status (edge-adjusted win probability); replaced on refit"),
    Spec("factor_edge_history", """
        SELECT run_at, score_col, regime, horizon_days, rank_ic, hit_auc, dates, verdict
        FROM factor_edge_history
        WHERE table_name = 'unified_recommendations' AND run_at = (
            SELECT MAX(run_at) FROM factor_edge_history WHERE table_name = 'unified_recommendations')""",
         why="load_engine_edge_verdicts / load_latest_engine_ics (latest run only)"),
    Spec("app_settings", """
        SELECT key, value, "updatedAt" FROM app_settings
        WHERE key IN ('optimal_regime_cat_tilt', 'engine_edge_adjustment_enabled',
                      'engine_ic_tilt_enabled', 'edge_adjustment_enabled')""", optional=False,
         why="the four feature flags / tilt override the ranker reads"),
    Spec("market_holidays", "SELECT date FROM market_holidays WHERE exchange = 'NSE'",
         why="valid_until_for (session arithmetic)"),
    Spec("feature_store", """
        SELECT * FROM feature_store WHERE date = (
            SELECT MAX(date) FROM feature_store
            WHERE date > CAST(:d AS date) - 10 AND date <= CAST(:d AS date))""",
         why="not read by the ranker: the raw feature row behind the DL/ML engines it does read, so "
             "they can be re-scored; hypertable, latest date only"),
]


def _git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True,
                              text=True, timeout=10).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def resolve_run(conn, run_date: str | None) -> tuple[str, datetime | None]:
    if run_date is None:
        row = conn.execute("SELECT MAX(computed_at) AS d FROM unified_recommendations").fetchone()
        run_date = row["d"] if row else None
        if not run_date:
            raise SystemExit("no unified_recommendations rows: pass --date")
    date.fromisoformat(str(run_date))
    row = conn.execute("SELECT MAX(generated_at) AS g FROM unified_recommendations WHERE computed_at = ?",
                       (str(run_date),)).fetchone()
    return str(run_date), (row["g"] if row else None)


def _column(name: str, values: list) -> pl.Series:
    vals = []
    for v in values:
        if isinstance(v, Decimal):
            v = float(v)
        elif isinstance(v, (dict, list)):
            v = json.dumps(v, default=str)
        vals.append(v)
    try:
        s = pl.Series(name, vals, strict=False)
    except Exception:
        s = pl.Series(name, [None if v is None else str(v) for v in vals], dtype=pl.String)
    return s.cast(pl.String) if s.dtype == pl.Null else s


def _frame(cur) -> pl.DataFrame:
    cols = [c[0] for c in (cur.description or [])]
    rows = cur.fetchall()
    return pl.DataFrame([_column(c, [r[i] for r in rows]) for i, c in enumerate(cols)])


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot(conn, run_date: str | None = None, out_dir=DEFAULT_OUT_DIR, *, force: bool = False,
             max_mb: float = DEFAULT_MAX_MB, specs: list[Spec] = INPUTS) -> dict:
    run_date, generated_at = resolve_run(conn, run_date)
    out_dir = Path(out_dir)
    final = out_dir / run_date
    if final.exists() and not force:
        conn.rollback()
        return {"status": "noop", "dir": str(final)}

    anchor_ts = generated_at or datetime.now(timezone.utc)
    params = {"d": anchor_ts.astimezone(IST).date(), "ts": anchor_ts, "run": run_date}

    frames: dict[str, pl.DataFrame] = {}
    tables: dict[str, dict] = {}
    for spec in specs:
        t0 = time.perf_counter()
        try:
            # Server-side cap, so a killed run cannot orphan a scan on production.
            conn.execute("SET LOCAL statement_timeout = 300000")
            df = _frame(conn.execute(spec.sql, {k: v for k, v in params.items() if f":{k}" in spec.sql}))
        except Exception as e:
            conn.rollback()
            if not spec.optional:
                raise RuntimeError(f"required input {spec.name} failed: {e}") from e
            msg = str(e).splitlines()[0][:300]
            missing = "does not exist" in msg
            tables[spec.name] = {"status": "absent" if missing else "error", "error": msg,
                                 "seconds": round(time.perf_counter() - t0, 2)}
            print(f"[snapshot] {spec.name}: {'absent' if missing else 'ERROR'} ({msg})", file=sys.stderr)
            continue
        frames[spec.name] = df
        tables[spec.name] = {"status": "ok", "rows": df.height, "columns": df.columns,
                             "seconds": round(time.perf_counter() - t0, 2)}
    conn.rollback()   # read-only: end the transaction so no lock outlives the reads

    est_mb = sum(df.estimated_size() for df in frames.values()) / 1e6
    if est_mb > max_mb:
        raise SnapshotTooLarge(f"snapshot for {run_date} estimates {est_mb:.1f} MB in memory, above the "
                               f"{max_mb} MB cap - refusing to write (raise --max-mb only after checking "
                               f"which input grew: {sorted(((round(df.estimated_size()/1e6, 1), n) for n, df in frames.items()), reverse=True)[:5]})")

    out_dir.mkdir(parents=True, exist_ok=True)
    stage = out_dir / f".{run_date}.tmp-{os.getpid()}"
    if stage.exists():
        shutil.rmtree(stage, onerror=lambda f, p, _: (os.chmod(p, stat.S_IWRITE), f(p)))
    stage.mkdir()
    for name, df in frames.items():
        p = stage / f"{name}.parquet"
        df.write_parquet(p)
        tables[name].update(file=p.name, bytes=p.stat().st_size, sha256=_sha256(p))
        os.chmod(p, stat.S_IREAD)

    manifest = {
        "date": run_date,
        "anchor_date": params["d"].isoformat(),
        "ranker_generated_at": generated_at.isoformat() if generated_at else None,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_commit": _git_commit(),
        "estimated_mb": round(est_mb, 2),
        "tables": tables,
    }
    mp = stage / "manifest.json"
    mp.write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    os.chmod(mp, stat.S_IREAD)

    if final.exists():
        final.rename(out_dir / f"{run_date}.superseded.{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}")
    stage.rename(final)
    return {"status": "written", "dir": str(final), "manifest": manifest}


def persist(conn, manifest: dict) -> None:
    ok = [t for t in manifest["tables"].values() if t["status"] == "ok"]
    value = json.dumps({"date": manifest["date"], "tables": len(ok), "rows": sum(t["rows"] for t in ok),
                        "bytes": sum(t["bytes"] for t in ok)})
    conn.execute('INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, now()) '
                 'ON CONFLICT (key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"',
                 (SETTINGS_KEY, value))
    conn.commit()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="ranker run label (unified_recommendations.computed_at); default MAX")
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    ap.add_argument("--persist", action="store_true", help=f"upsert app_settings['{SETTINGS_KEY}']")
    ap.add_argument("--force", action="store_true", help="rewrite an existing day, keeping it as .superseded")
    ap.add_argument("--max-mb", type=float, default=DEFAULT_MAX_MB)
    args = ap.parse_args(argv)

    from db_compat import connect
    conn = connect()
    try:
        return _main(conn, args)
    finally:
        try:
            conn.rollback()
            conn.close()
        except Exception:
            pass


def _main(conn, args) -> int:
    try:
        res = snapshot(conn, args.date, args.out_dir, force=args.force, max_mb=args.max_mb)
    except SnapshotTooLarge as e:
        print(f"[snapshot] REFUSED: {e}", file=sys.stderr)
        return 3
    if res["status"] == "noop":
        print(f"[snapshot] {res['dir']} already exists - snapshots are immutable, nothing to do "
              f"(--force rewrites it and keeps the old copy)")
        return 0
    m = res["manifest"]
    for name, t in m["tables"].items():
        print(f"[snapshot] {name:28s} {t['status']:6s} rows={t.get('rows', '-'):>8} "
              f"bytes={t.get('bytes', '-'):>10} {t['seconds']:>6.2f}s")
    ok = [t for t in m["tables"].values() if t["status"] == "ok"]
    print(f"[snapshot] wrote {res['dir']}: {len(ok)} inputs, {sum(t['rows'] for t in ok):,} rows, "
          f"{sum(t['bytes'] for t in ok):,} bytes")
    if args.persist:
        persist(conn, m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
